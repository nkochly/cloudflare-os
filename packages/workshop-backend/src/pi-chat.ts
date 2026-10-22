import {
  createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Message,
  type ImageContent, type Model, type TextContent, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  createRegistry, defineExtension, GenerationTask, Harness, hook, section, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { PiHarness } from "agents/harness/pi";
import { AsyncLocalStorage } from "node:async_hooks";

/** The calling context, to run callbacks in later (workerd implements Node's snapshot()). */
const snapshotContext = (): (<R>(fn: () => R) => R) =>
  (AsyncLocalStorage as unknown as {snapshot(): <R>(fn: () => R) => R}).snapshot();
import { AGENT_TOOL_DECLARATIONS } from "./agent";
import type { ModelHandle } from "./ai-models";
import { PDF_MIME_TYPE } from "./chat-attachment-pdf";
import { canInlineChatAttachmentImage } from "./chat-attachment-validation";

/**
 * Every chat turn runs on pi-durable, hosted by the Agents SDK's PiHarness.
 *
 * Pi owns the run: one Pi session per chat holds the model transcript, the inbox and the run,
 * makes the model requests, executes the tool calls durably, compacts the transcript when it
 * nears the model's window, and resumes the run after an eviction. The chat log is the product's
 * record of what the agent did: each completed round is written to it at the round's barrier
 * (`afterTools`, or `onYield` for the final answer) by the turn attached to the run.
 *
 * A turn attaches a `PiPass`: the tools' implementations (which close over the chat's session
 * content, pins, worktrees, connections and captured gatekeeper actions) and the event sink that
 * streams to clients and persists each round. The tools Pi sees are static declarations
 * (AGENT_TOOL_DECLARATIONS) that call into the attached pass. A run Pi wakes after an eviction
 * waits for the Overseer's restart recovery to attach a turn again before its next call.
 */

/** The prefix of the pi-ai provider id each chat's model is registered under for Pi. */
export const PI_PROVIDER = "workshop";

/** chord's background context (no values, never cancelled), which pi-durable takes on every call. */
const BACKGROUND = Object.freeze({
  abortSignal: undefined, value: () => undefined, toString: () => "[Context workshop background]",
}) as never;

/** How long a woken run waits for a turn to attach before its tool calls fail. */
const ATTACH_TIMEOUT_MS = 60_000;

/** What one attached turn gives Pi: the tools' implementations and the round barrier. */
export interface PiPass {
  tools: Record<string, AgentTool>;
  /** The client stream and persistence sink: message_update, tool_execution_end, turn_end. */
  emit(event: AgentEvent): Promise<void>;
  /** Decides after a round's tools whether the run ends there, before another request. */
  finishTurn(round: {message: AssistantMessage; toolResults: ToolResultMessage[]}): {action: "end"} | undefined | void;
  /** Tells clients to drop what a failed request streamed; Pi may retry it. */
  resetStream(): void;
  /** Steering the user sent while the turn ran, joined after the current round. */
  takeSteering(): string[];
  maxTokens?: number;
}

/** How a driven turn ended. */
export type PiTurnOutcome =
  | {type: "finished"}
  | {type: "failed"; message: AssistantMessage | undefined; reason: string};

type Attached = {
  pass: PiPass;
  /**
   * Runs a callback in the turn's own context. Pi makes requests and calls tools from its own
   * session line; running them in the turn's context keeps them in the turn's trace span and
   * logging context, as they were when the turn made them itself.
   */
  inTurn: <R>(fn: () => R) => R;
  handle: ModelHandle;
  /** The assistant message of the round in flight, as the provider finished it. */
  assistant?: AssistantMessage;
  /** Tool results of the round in flight, by call id. */
  results: Map<string, ToolResultMessage>;
  /** The round's stop decision, made once its last call returned. */
  decision?: {action: "end"} | undefined | void;
  decided: boolean;
  ended: boolean;
  failure?: AssistantMessage;
  /** A throw from the turn's own sink, e.g. a failed persistence barrier: it fails the turn. */
  error?: {thrown: unknown};
};

/**
 * PiHarness opens pi at every start to wake sessions with unfinished work. A workspace whose
 * chats have never run has none, so it starts without opening pi at all.
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
  readonly #sql: SqlStorage;
  readonly #models = createModels();
  readonly #attached = new Map<number, Attached>();
  readonly #waiters = new Map<number, (() => void)[]>();
  readonly #tools: ToolRegistration[];
  /**
   * Runs a callback in the object's own context. Pi's run and its wake job outlive the turn that
   * submits to them, so submitting must not tie them to that turn's trace span.
   */
  readonly #detached = snapshotContext();

  constructor(ctx: DurableObjectState) {
    this.#sql = ctx.storage.sql;
    // `system` is the system prompt the chat's turn last set; Pi renders it before every request.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS workshop_pi_chat (
      chat_id INTEGER PRIMARY KEY, session TEXT NOT NULL, synced_sequence INTEGER NOT NULL,
      system TEXT NOT NULL DEFAULT '')`);
    let extension = this.#extension();
    this.#tools = [...extension.tools ?? []];
    let registry = createRegistry();
    registry.install(extension);
    this.harness = new LazyPiHarness(() => this.#hasChats(), {
      harness: ({storage, context}) => Harness.open(storage, {
        models: this.#models, registry, settings: {toolExecution: "sequential"},
        onReport: error => console.error(JSON.stringify({event: "pi.report", error: String(error)})),
      }, context),
    });
  }

  #hasChats(): boolean {
    return this.#sql.exec("SELECT 1 FROM workshop_pi_chat LIMIT 1").toArray().length > 0;
  }

  /** The chat log sequence Pi's transcript has taken in up to; -1 for a chat Pi has not run. */
  syncedSequence(chatId: number): number {
    return this.#sql.exec<{synced_sequence: number}>(
        "SELECT synced_sequence FROM workshop_pi_chat WHERE chat_id = ?", chatId)
        .toArray()[0]?.synced_sequence ?? -1;
  }

  /** The chat's Pi session, if it has run on Pi. */
  sessionOf(chatId: number): string | undefined {
    return this.#sql.exec<{session: string}>(
        "SELECT session FROM workshop_pi_chat WHERE chat_id = ?", chatId).toArray()[0]?.session;
  }

  /**
   * Starts the chat's model context over: the next turn opens a new Pi session that takes in the
   * whole chat log again. Used when the log no longer matches what Pi saw (a rewind or reroot).
   */
  forget(chatId: number) {
    this.#sql.exec("DELETE FROM workshop_pi_chat WHERE chat_id = ?", chatId);
  }

  /**
   * Drives one turn on the chat's Pi session: hands Pi the chat's new inputs (the model messages
   * the chat log produced after `syncedSequence`, up to `lastSequence`) and waits until Pi
   * settles them. Submitting is idempotent per input, so a turn restarted after an eviction
   * waits on the run Pi resumed instead of starting another. With no new inputs it waits on the
   * run still in flight, if any.
   */
  async drive(chatId: number, handle: ModelHandle, pass: PiPass, input: {
    system: string; messages: Message[]; lastSequence: number;
  }, signal: AbortSignal): Promise<PiTurnOutcome> {
    let model = this.#useModel(chatId, handle);
    let session = await this.#detached(() => this.#session(chatId, model, input.system));
    let attached: Attached = {pass, handle, inTurn: snapshotContext(), results: new Map(), decided: false, ended: false};
    this.#attached.set(chatId, attached);
    for (let wake of this.#waiters.get(chatId) ?? []) wake();
    this.#waiters.delete(chatId);
    // The model is offered exactly the tools this turn implements (a spawned agent gets fewer).
    let offered = this.#tools.filter(tool => Object.hasOwn(pass.tools, tool.name));
    if (offered.length !== this.#tools.length) {
      await this.#detached(async () =>
          (await this.harness.conversation(session)).configure({modelTools: offered}, BACKGROUND));
    }
    let onAbort = () => void this.harness.session(session).abort().catch(() => {});
    signal.addEventListener("abort", onAbort);
    try {
      let operationId: string | undefined;
      if (input.messages.length > 0) {
        let receipt = await this.#detached(() => this.harness.session(session).submit(
            toUserInput(input.messages), {operationId: `chat-${chatId}-${input.lastSequence}`}));
        operationId = receipt.operationId;
        this.#sql.exec("UPDATE workshop_pi_chat SET synced_sequence = ? WHERE chat_id = ?",
            input.lastSequence, chatId);
      } else {
        operationId = (await this.#detached(() => this.harness.pending({session}))).at(-1)?.operationId;
        if (!operationId) return {type: "finished"};
      }
      let waitFor = operationId;
      let result = await this.#detached(() => this.harness.session(session).wait(waitFor, signal));
      signal.throwIfAborted();
      if (attached.error) throw attached.error.thrown;
      if (result.status === "done" || attached.ended) return {type: "finished"};
      return {type: "failed", message: attached.failure, reason: result.reason ?? "The model did not answer."};
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#attached.get(chatId) === attached) this.#attached.delete(chatId);
    }
  }

  /**
   * `/compact`: Pi summarizes the older part of the chat's transcript now, as it does on its own
   * when a request nears the model's window. False when the chat has no Pi session yet.
   */
  async compact(chatId: number, handle: ModelHandle): Promise<boolean> {
    let session = this.sessionOf(chatId);
    if (!session) return false;
    await this.harness.session(session).setModel(this.#useModel(chatId, handle));
    let pi = await this.harness.pi();
    let task = await (await this.harness.conversation(session)).compact(undefined, BACKGROUND);
    let settled = await pi.waitForTask(task, BACKGROUND) as {outcome?: {result?: {entryId?: string}}};
    return settled.outcome?.result?.entryId !== undefined;
  }

  /** The turn attached to a chat, waiting a while for one when a woken run gets ahead of it. */
  async #attachedTo(chatId: number): Promise<Attached> {
    let attached = this.#attached.get(chatId);
    if (attached) return attached;
    await new Promise<void>((resolve, reject) => {
      let timer = setTimeout(() => reject(new Error(
          "This turn was interrupted and could not be resumed.")), ATTACH_TIMEOUT_MS);
      let list = this.#waiters.get(chatId) ?? [];
      list.push(() => { clearTimeout(timer); resolve(); });
      this.#waiters.set(chatId, list);
    });
    return this.#attached.get(chatId)!;
  }

  /**
   * Registers the chat's model with Pi's catalog under its own provider id. Requests stream
   * through the attached turn's handle, and every event also feeds the turn's client stream.
   */
  #useModel(chatId: number, handle: ModelHandle): Model<Api> {
    let provider = `${PI_PROVIDER}-${chatId}`;
    let model = {...handle.model, provider} as Model<Api>;
    let stream = (m: Model<Api>, context: never, options: Record<string, unknown> | undefined) => {
      let attached = this.#attached.get(chatId);
      let target = attached?.handle ?? handle;
      let request = context as unknown as {messages: Message[]};
      context = {...request, messages: limitRequestImages(request.messages)} as never;
      if (!attached) return target.stream({...target.model, id: m.id} as never, context, options as never);
      let source = attached.inTurn(() => target.stream({...target.model, id: m.id} as never, context,
          {...options, maxTokens: attached.pass.maxTokens} as never));
      let out = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (let event of source) {
            if (event.type === "done") attached.assistant = event.message;
            let partial = "partial" in event ? event.partial
                : event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
            await attached.pass.emit({type: "message_update", message: partial as never,
              assistantMessageEvent: event as AssistantMessageEvent});
            out.push(event);
          }
          out.end();
        } catch (error) {
          let message = {...emptyAssistant(target.model), stopReason: "error", errorMessage: String(error)};
          out.push({type: "error", reason: "error", error: message} as never);
          out.end();
        }
      })();
      return out;
    };
    this.#models.setProvider(createProvider({
      id: provider,
      // The handle carries its own credentials; Pi resolves none.
      auth: {apiKey: {name: "Workshop", resolve: async () => ({auth: {}})}} as never,
      models: [model],
      api: {stream, streamSimple: stream} as never,
    }));
    return model;
  }

  async #session(chatId: number, model: Model<Api>, system: string): Promise<string> {
    let session = this.sessionOf(chatId);
    if (session) {
      this.#sql.exec("UPDATE workshop_pi_chat SET system = ? WHERE chat_id = ?", system, chatId);
      await this.harness.session(session).setModel(model);
      return session;
    }
    let created = await this.harness.sessions.create();
    await created.setModel(model);
    this.#sql.exec("INSERT INTO workshop_pi_chat (chat_id, session, synced_sequence, system) VALUES (?, ?, ?, ?)",
        chatId, created.id, -1, system);
    return created.id;
  }

  #chatOf(session: string): number | undefined {
    return this.#sql.exec<{chat_id: number}>(
        "SELECT chat_id FROM workshop_pi_chat WHERE session = ?", session).toArray()[0]?.chat_id;
  }

  /** Makes the round's stop decision once every call the round made has a result. */
  #decide(attached: Attached) {
    let message = attached.assistant;
    if (!message || attached.decided) return;
    let calls = message.content.filter(c => c.type === "toolCall");
    if (calls.some(c => !attached.results.has(c.id))) return;
    attached.decided = true;
    attached.decision = attached.pass.finishTurn({message, toolResults: calls.map(c => attached.results.get(c.id)!)});
    if (attached.decision?.action === "end") attached.ended = true;
  }

  /** Writes the round Pi just finished to the chat log through the attached turn's barrier. */
  async #barrier(attached: Attached) {
    let message = attached.assistant;
    if (!message) return;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      attached.failure = message;
      attached.assistant = undefined;
      return;
    }
    let calls = message.content.filter(c => c.type === "toolCall");
    for (let call of calls) {
      if (attached.results.has(call.id)) continue;
      // Pi refused the call before it reached a tool (an unknown name, invalid arguments).
      let text = "The call was rejected before it ran.";
      this.#record(attached, call.id, call.name, text, true);
      await attached.inTurn(() => attached.pass.emit({type: "tool_execution_end", toolCallId: call.id,
        toolName: call.name, result: {content: [{type: "text", text}]}, isError: true}));
    }
    this.#decide(attached);
    let toolResults = calls.map(c => attached.results.get(c.id)!);
    attached.assistant = undefined;
    attached.results.clear();
    attached.decided = false;
    try {
      await attached.inTurn(() => attached.pass.emit({type: "turn_end", message, toolResults}));
    } catch (thrown) {
      // Nothing of a round that failed to persist may run on: end the run and fail the turn.
      attached.error ??= {thrown};
      attached.ended = true;
    }
  }

  /** The workshop's tools, its system prompt section and the round barrier. */
  #extension() {
    let tools = Object.values(AGENT_TOOL_DECLARATIONS).map((declaration): ToolRegistration => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters as never,
      execute: async (args, api, context) => {
        let chatId = this.#chatOf(String(api.conversationId));
        if (chatId === undefined) throw new Error("This conversation is not a workshop chat.");
        let attached = await this.#attachedTo(chatId);
        let tool = attached.pass.tools[declaration.name];
        let result: {content: ToolResultMessage["content"]; details?: unknown};
        let isError = false;
        try {
          if (!tool) throw new Error(`${declaration.name} is not available in this conversation.`);
          result = await attached.inTurn(() =>
              tool.execute(api.callId, args as never, context.abortSignal as AbortSignal | undefined));
        } catch (error) {
          isError = true;
          result = {content: [{type: "text", text: error instanceof Error ? error.message : String(error)}]};
        }
        this.#record(attached, api.callId, declaration.name, result.content, isError, result.details);
        await attached.inTurn(() => attached.pass.emit({type: "tool_execution_end", toolCallId: api.callId,
          toolName: declaration.name, result, isError}));
        this.#decide(attached);
        return {output: result.content, isError, ...attached.ended ? {control: {terminate: true}} : {}};
      },
    }));

    return defineExtension({
      name: "workshop",
      sections: [section("workshop", ({conversationId}) => this.#sql.exec<{system: string}>(
          "SELECT system FROM workshop_pi_chat WHERE session = ?", String(conversationId))
          .toArray()[0]?.system || undefined, {tag: false})],
      tools,
      hooks: [hook(GenerationTask, {
        afterResponse: (message, api) => {
          let attached = this.#attachedFor(String(api.conversationId));
          if (!attached) return;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            // Nothing of a failed request is kept; Pi retries it or fails the run with it.
            attached.failure = message;
            attached.assistant = undefined;
            attached.pass.resetStream();
            return;
          }
          attached.assistant = message;
        },
        afterTools: async (_assistant, _results, api) => {
          let session = String(api.conversationId);
          let attached = this.#attachedFor(session);
          if (!attached) return;
          await this.#barrier(attached);
          if (attached.ended) {
            void this.harness.session(session).abort().catch(() => {});
            return;
          }
          // Steering joins after this round, as the user's own words.
          let steering = attached.pass.takeSteering();
          if (steering.length > 0) {
            void this.harness.session(session).steer(steering.join("\n\n")).catch(() => {});
          }
        },
        onYield: async (_answer, api) => {
          let attached = this.#attachedFor(String(api.conversationId));
          if (attached) await this.#barrier(attached);
          return undefined;
        },
      })],
    });
  }

  #attachedFor(session: string): Attached | undefined {
    let chatId = this.#chatOf(session);
    return chatId === undefined ? undefined : this.#attached.get(chatId);
  }

  #record(attached: Attached, toolCallId: string, toolName: string,
      content: ToolResultMessage["content"] | string, isError: boolean, details?: unknown) {
    attached.results.set(toolCallId, {
      role: "toolResult", toolCallId, toolName, isError, details, timestamp: Date.now(),
      content: typeof content === "string" ? [{type: "text", text: content}] : content,
    } as ToolResultMessage);
  }
}

/** The chat log's new model messages as one Pi input: their text and attachments, in order. */
function toUserInput(messages: Message[]): Parameters<PiHarness["submit"]>[0] {
  let users = messages.filter(m => m.role === "user");
  if (users.every(m => typeof m.content === "string")) return users.map(m => m.content as string).join("\n\n");
  let parts: (TextContent | ImageContent)[] = [];
  for (let message of users) {
    if (parts.length > 0) parts.push({type: "text", text: "\n\n"});
    if (typeof message.content === "string") parts.push({type: "text", text: message.content});
    else parts.push(...message.content as (TextContent | ImageContent)[]);
  }
  return parts as never;
}

/** Anthropic's limit on images in one request before the smaller per-image edge applies. */
const MANY_IMAGES = 20;
const MANY_IMAGES_MAX_EDGE = 2000;

/**
 * A request with more than MANY_IMAGES images may only carry images up to MANY_IMAGES_MAX_EDGE
 * pixels on an edge, so larger ones are left out of that request (never out of the transcript).
 * The text part beside each attachment already names its workspace file.
 */
export function limitRequestImages(messages: readonly Message[]): Message[] {
  let count = 0;
  for (let m of messages) if (Array.isArray(m.content)) for (let p of m.content) if (p.type === "image") ++count;
  if (count <= MANY_IMAGES) return messages as Message[];
  return messages.map(message => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    return {...message, content: message.content.map(part =>
      part.type !== "image" || part.mimeType === PDF_MIME_TYPE ||
          canInlineChatAttachmentImage(part.mimeType, Uint8Array.fromBase64(part.data), MANY_IMAGES_MAX_EDGE)
        ? part
        : {type: "text" as const, text: "[Image left out of this request, which has too many images for its " +
            "size; binary contents are not inlined. Use byte-aware tools to inspect the workspace file.]"})};
  });
}

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: "stop", timestamp: Date.now()} as AssistantMessage;
}
