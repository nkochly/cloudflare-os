import { Workspace } from "@cloudflare/computer";
import { createPiTools, type PiTool } from "@cloudflare/computer/tools/pi-ai";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { CodeChange, FileChange } from "@gadgets/workshop-shared/code-change";
import type { AgentGadgetInfo, AgentStepChange, ChatHistory } from "./agent";
import type { ModelHandle } from "./ai-models";

/**
 * Chat turns on pi-durable, hosted by the Agents SDK's PiHarness.
 *
 * Pi owns the turn: one Pi session per chat holds the transcript, the inbox and the run, and
 * resumes it after an eviction. The chat's draft is a folder in a computer Workspace,
 * `/chats/<chatId>/`, with one subfolder per gadget; the file tools are computer's, rooted there.
 * When a run settles, the draft is diffed against the chat's view of each gadget and lands in the
 * chat as one agent step, with Pi's answer as its message. That step is what the chat log, the
 * UI and `mergeChanges` read, so the chat log is a projection of Pi's runs, written once per run.
 */

/** The pi-ai provider id every workshop model is registered under for Pi. */
export const PI_PROVIDER = "workshop";

const MANIFEST = ".workshop.json";
/** Where the model sees its chat's draft. */
const WORKSPACE = "/workspace";
const FILE_TOOLS = ["read", "write", "edit", "ls", "find", "grep", "delete"];

/** What a draft folder holds, by folder name: an existing gadget (id) or one the run created. */
type Manifest = {gadgets: Record<string, {id?: WorkpieceId; title: string}>};

/** The Overseer operations a Pi turn needs. */
export interface PiChatHooks {
  loadChatHistory(chatId: number): ChatHistory;
  listGadgetInfo(forChatId: number): AgentGadgetInfo[];
  readGadgetFiles(gadgetId: WorkpieceId, chatId?: number): Promise<ReadonlyMap<string, string>>;
  getGadgetHead(gadgetId: WorkpieceId): string | undefined;
  createGadget(title: string, bindingName: string, chatId: number): {id: WorkpieceId; title: string};
  commitAgentStep(chatId: number, author: AiChatAuthorInfo,
      msgs: {type: "message"; message: string}[],
      step: {
        changes: AgentStepChange[];
        createdGadgets: {gadgetId: WorkpieceId; title: string; bindingName: string}[];
        createdWorktrees: never[];
        addedBindings: never[];
        worktreeCommits: never[];
        blueprintMerges: never[];
      }): Promise<boolean>;
}

/**
 * PiHarness opens pi at every start to wake sessions with unfinished work. A workspace whose
 * chats have never run on Pi has none, so it starts without opening pi at all.
 */
class LazyPiHarness extends PiHarness {
  readonly #hasSessions: () => boolean;
  constructor(hasSessions: () => boolean, options: ConstructorParameters<typeof PiHarness>[0]) {
    super(options);
    this.#hasSessions = hasSessions;
  }
  override async onStart(context: Parameters<PiHarness["onStart"]>[0]): Promise<void> {
    if (this.#hasSessions()) await super.onStart(context);
  }
}

export class PiChats {
  readonly harness: PiHarness;
  readonly workspace: Workspace;
  readonly #sql: SqlStorage;
  readonly #models = createModels();

  constructor(ctx: DurableObjectState) {
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS workshop_pi_chat (
      chat_id INTEGER PRIMARY KEY, session TEXT NOT NULL, synced_sequence INTEGER NOT NULL)`);
    this.workspace = new Workspace({storage: ctx.storage, output: false});
    let registry = createRegistry();
    registry.install(this.#extension());
    this.harness = new LazyPiHarness(() => this.#hasChats(), {
      harness: ({storage, context}) => Harness.open(storage, {models: this.#models, registry,
        onReport: error => console.error(JSON.stringify({event: "pi.report", error: String(error)}))}, context),
    });
  }

  #hasChats(): boolean {
    return this.#sql.exec("SELECT 1 FROM workshop_pi_chat LIMIT 1").toArray().length > 0;
  }

  /** The draft folder of a chat. */
  static folder(chatId: number): string {
    return `/chats/${chatId}`;
  }

  /**
   * Runs one turn: submits the chat's unanswered messages to its Pi session, waits for Pi to
   * settle them, and lands the draft in the chat. Submitting is idempotent per message, so a
   * turn the Overseer resumes after an eviction waits on the same Pi run instead of starting one.
   */
  async runTurn(hooks: PiChatHooks, handle: ModelHandle, chatId: number, author: AiChatAuthorInfo,
      signal: AbortSignal): Promise<void> {
    let model = this.#useModel(handle);
    let {session, syncedSequence} = await this.#session(hooks, chatId, model);

    let pending = hooks.loadChatHistory(chatId).chatMessages.filter(m =>
        m.sequence > syncedSequence && m.type === "message" && m.author.type !== "agent");
    if (pending.length === 0) return;
    let last = pending[pending.length - 1].sequence;
    let prompt = pending.map(m => (m as {message: string}).message).join("\n\n");

    let receipt = await this.harness.session(session).submit(prompt, {operationId: `chat-${chatId}-${last}`});
    let result = await this.harness.session(session).wait(receipt.operationId, signal);
    signal.throwIfAborted();
    if (result.status !== "done") {
      // pi records a failed request on the transcript's last assistant entry.
      let last = (await this.harness.session(session).messages()).at(-1) as {data?: {errorMessage?: string}} | undefined;
      throw new Error([result.reason ?? "The model did not answer.", last?.data?.errorMessage].filter(Boolean).join(": "));
    }

    await this.#land(hooks, chatId, author, result.text ?? "");
    this.#sql.exec("UPDATE workshop_pi_chat SET synced_sequence = ? WHERE chat_id = ?", last, chatId);
  }

  /** Registers the turn's model with Pi's catalog under PI_PROVIDER, streaming through the handle. */
  #useModel(handle: ModelHandle): Model<Api> {
    let model = {...handle.model, provider: PI_PROVIDER} as Model<Api>;
    this.#models.setProvider(createProvider({
      id: PI_PROVIDER,
      // The handle carries its own credentials; Pi resolves none.
      auth: {apiKey: {name: "Workshop", resolve: async () => ({auth: {}})}} as never,
      models: [model],
      api: {
        stream: (m: Model<Api>, context: never, options: never) =>
          handle.stream({...handle.model, id: m.id} as never, context, options),
        streamSimple: (m: Model<Api>, context: never, options: never) =>
          handle.stream({...handle.model, id: m.id} as never, context, options),
      } as never,
    }));
    return model;
  }

  async #session(hooks: PiChatHooks, chatId: number, model: Model<Api>)
      : Promise<{session: string; syncedSequence: number}> {
    let row = this.#sql.exec<{session: string; synced_sequence: number}>(
        "SELECT session, synced_sequence FROM workshop_pi_chat WHERE chat_id = ?", chatId).toArray()[0];
    if (row) {
      await this.harness.session(row.session).setModel(model);
      return {session: row.session, syncedSequence: row.synced_sequence};
    }

    // A new chat's draft starts as its current view of every gadget it can see.
    let manifest: Manifest = {gadgets: {}};
    let dir = PiChats.folder(chatId);
    for (let info of hooks.listGadgetInfo(chatId)) {
      let name = `g${info.id}`;
      manifest.gadgets[name] = {id: info.id, title: info.title};
      for (let [path, content] of await hooks.readGadgetFiles(info.id, chatId)) {
        await this.#write(`${dir}/${name}/${path}`, content);
      }
    }
    await this.#write(`${dir}/${MANIFEST}`, JSON.stringify(manifest));

    let session = await this.harness.sessions.create();
    await session.setModel(model);
    // Messages already in the chat before Pi took it over are not replayed into the session.
    let before = hooks.loadChatHistory(chatId).chatMessages
        .filter(m => m.type === "message" && m.author.type === "agent").at(-1)?.sequence ?? -1;
    this.#sql.exec("INSERT INTO workshop_pi_chat (chat_id, session, synced_sequence) VALUES (?, ?, ?)",
        chatId, session.id, before);
    return {session: session.id, syncedSequence: before};
  }

  /** Lands the draft in the chat as one step: new gadgets, every changed file, and the answer. */
  async #land(hooks: PiChatHooks, chatId: number, author: AiChatAuthorInfo, answer: string) {
    let dir = PiChats.folder(chatId);
    let manifest = await this.#manifest(chatId);
    let createdGadgets: {gadgetId: WorkpieceId; title: string; bindingName: string}[] = [];
    let changes: AgentStepChange[] = [];

    for (let [name, entry] of Object.entries(manifest.gadgets)) {
      let id = entry.id;
      if (id === undefined) {
        let created = hooks.createGadget(entry.title, name, chatId);
        id = entry.id = created.id;
        createdGadgets.push({gadgetId: id, title: created.title, bindingName: name});
      }
      let draft = await this.#readTree(`${dir}/${name}`);
      let current = createdGadgets.some(g => g.gadgetId === id)
          ? new Map<string, string>() : await hooks.readGadgetFiles(id, chatId);
      let edits: [string, FileChange][] = [];
      for (let [path, content] of draft) {
        if (current.get(path) !== content) edits.push([path, {set: content}]);
      }
      for (let path of current.keys()) {
        if (!draft.has(path)) edits.push([path, {remove: true}]);
      }
      if (edits.length === 0) continue;
      let head = hooks.getGadgetHead(id);
      let change: CodeChange = {[id]: edits};
      changes.push(head !== undefined ? {change, pin: {gadgetId: id, baseCommit: head}} : {change});
    }

    await hooks.commitAgentStep(chatId, author, [{type: "message", message: answer}], {
      changes, createdGadgets, createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
    });
    await this.#write(`${dir}/${MANIFEST}`, JSON.stringify(manifest));
  }

  async #manifest(chatId: number): Promise<Manifest> {
    let text = await this.workspace.fs.readFile(`${PiChats.folder(chatId)}/${MANIFEST}`, "utf8").catch(() => undefined);
    return text ? JSON.parse(text as string) : {gadgets: {}};
  }

  async #write(path: string, content: string) {
    await this.workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), {recursive: true});
    await this.workspace.fs.writeFile(path, content);
  }

  async #readTree(root: string, prefix = ""): Promise<Map<string, string>> {
    let files = new Map<string, string>();
    let entries = await this.workspace.fs.readdir(root + (prefix ? `/${prefix}` : "")).catch(() => []);
    for (let entry of entries) {
      let rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        for (let [p, c] of await this.#readTree(root, rel)) files.set(p, c);
      } else {
        files.set(rel, await this.workspace.fs.readFile(`${root}/${rel}`, "utf8") as string);
      }
    }
    return files;
  }

  #chatOf(session: string): number {
    let row = this.#sql.exec<{chat_id: number}>(
        "SELECT chat_id FROM workshop_pi_chat WHERE session = ?", session).toArray()[0];
    if (!row) throw new Error("This conversation is not a workshop chat.");
    return row.chat_id;
  }

  /** The workshop's tools: computer's file tools over the chat's draft, and createGadget. */
  #extension() {
    let declarations = createPiTools({workspace: this.workspace, root: "/", exec: {}}).tools
        .filter(tool => FILE_TOOLS.includes(tool.name));
    let fileTools = declarations.map((tool: PiTool): ToolRegistration => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      execute: async (args, api, context) => {
        // The model sees the chat's draft as /workspace; the tools see its real folder.
        let root = PiChats.folder(this.#chatOf(String(api.conversationId)));
        let inRoot = (path: unknown) => typeof path === "string"
            ? root + path.replace(/^\/workspace(?=\/|$)/, "").replace(/^(?!\/)/, "/") : path;
        let call = {...args as Record<string, unknown>};
        for (let key of ["path", "file_path"]) if (key in call) call[key] = inRoot(call[key]);
        let result = await createPiTools({workspace: this.workspace, root, exec: {}})
            .execute({id: api.callId, name: tool.name, arguments: call}, {abortSignal: context.abortSignal});
        let content = result.content.map(c => c.type === "text" ? {...c, text: c.text.replaceAll(root, WORKSPACE)} : c);
        if (result.isError) throw new Error(content.map(c => c.type === "text" ? c.text : "").join("\n"));
        return {output: content};
      },
    }));

    let CreateGadget = Type.Object({
      title: Type.String({description: "The gadget's title."}),
      bindingName: Type.String({description: "Folder and binding name, upper case, e.g. DEALS."}),
    });
    let createGadget: ToolRegistration<typeof CreateGadget> = {
      name: "createGadget",
      description: "Create a new gadget. Its files live in the folder named by bindingName.",
      parameters: CreateGadget,
      replay: "safe",
      execute: async ({title, bindingName}, api) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(bindingName)) throw new Error("bindingName must be upper case.");
        let chatId = this.#chatOf(String(api.conversationId));
        let manifest = await this.#manifest(chatId);
        if (manifest.gadgets[bindingName]) throw new Error(`${bindingName} already exists.`);
        manifest.gadgets[bindingName] = {title};
        await this.workspace.fs.mkdir(`${PiChats.folder(chatId)}/${bindingName}`, {recursive: true});
        await this.#write(`${PiChats.folder(chatId)}/${MANIFEST}`, JSON.stringify(manifest));
        return {output: [{type: "text", text: `Created ${bindingName}. Write its files under ${WORKSPACE}/${bindingName}/.`}]};
      },
    };

    return defineExtension({
      name: "workshop",
      sections: [section("workshop", () => [
        "You build gadgets in a workspace. Each gadget is a folder; its server code is server.js,",
        "exporting a Durable Object class Gadget and, for exports, a WorkerEntrypoint ExportHandler.",
        "Create a gadget with createGadget, then write its files under /workspace/<bindingName>/.",
        "Existing gadgets are the other folders in /workspace.",
      ].join("\n"))],
      tools: [...fileTools, createGadget as unknown as ToolRegistration],
    });
  }
}
