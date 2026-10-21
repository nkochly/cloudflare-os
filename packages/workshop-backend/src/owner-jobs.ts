import type {
  ActionHistoryPage,
  AiChatMetadata,
  GadgetExportFormat,
  ListOutputsResult,
  WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { SubmitExternalMessageResult } from "@gadgets/workshop-shared/external-message-gateway";
import type {
  FinishJobInput,
  JobGadget,
  JobResult,
  StartJobInput,
  StartJobResult,
} from "@gadgets/workshop-shared/owner-jobs";
import { workspaceNameFor } from "./do-names";

/** Prefix of every workspace, chat and message key a job uses: apart from any gateway source. */
export const JOB_SOURCE = "owner";

const APP = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_BRIEF = 50_000;
const WORKSPACE_ID = /^[0-9a-f]{64}$/;

/** The Overseer's external-message entry, as a job calls it. */
export type JobOverseer = {
  receiveExternalMessage(input: {
    callerEmail: string;
    externalChatKey: string;
    idempotencyKey: string;
    prompt: string;
    chatGatewayRpcTarget: unknown;
    title: string;
  }): Promise<SubmitExternalMessageResult>;
};

/** The workspace surface a job reads and merges through, as the owner. */
export type JobWorkspace = {
  listChats(): Promise<AiChatMetadata[]>;
  listActions(options?: {filter?: "pending"}): Promise<ActionHistoryPage>;
  mergeChanges(chatId: number): Promise<{outcome: "merged" | "stale"}>;
  getGadget(id: WorkpieceId): Promise<{
    getTitle(): Promise<string>;
    getExportFormats(chatId?: number): Promise<GadgetExportFormat[]>;
    export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>;
  }>;
};

/** The owner's account surface a job needs. */
export type JobAccount = {
  openGadget(id: string): Promise<JobWorkspace>;
  listOutputs(): Promise<ListOutputsResult>;
};

/** The workspace an app lives in, by Durable Object name: the same app always finds the same one. */
export function jobWorkspaceName(app: string): Promise<string> {
  return workspaceNameFor(`${JOB_SOURCE}:app:${app}`);
}

/** Submits the brief into the app's workspace as the owner; `notify` hears when the turn ends. */
export async function startJob(
  input: StartJobInput,
  email: string,
  overseer: (name: string) => JobOverseer,
): Promise<StartJobResult> {
  if (!APP.test(input.app)) return {accepted: false, message: "The app slug is not valid."};
  if (!input.jobId.trim()) return {accepted: false, message: "A job id is required."};
  if (!input.brief.trim()) return {accepted: false, message: "Please include a brief."};
  if (input.brief.length > MAX_BRIEF) return {accepted: false, message: "The brief is too long."};

  let result = await overseer(await jobWorkspaceName(input.app)).receiveExternalMessage({
    callerEmail: email,
    externalChatKey: `${JOB_SOURCE}:${input.chatKey ?? `app:${input.app}`}`,
    idempotencyKey: `${JOB_SOURCE}:job:${input.jobId}`,
    prompt: input.brief,
    chatGatewayRpcTarget: input.notify,
    title: input.title,
  });
  if (!result.accepted) return result;
  let match = /^\/workspace\/([0-9a-f]{64})\?chat=(\d+)$/.exec(result.chatPath);
  if (!match) throw new Error(`Unexpected chat path from the workspace: ${result.chatPath}`);
  return {accepted: true, workspaceId: match[1], chatId: Number(match[2]), path: result.chatPath};
}

/**
 * Merges the job's chat when nothing waits on a person, then reports what the workspace holds.
 * Safe to call again: a merge with nothing proposed is a no-op.
 */
export async function finishJob(input: FinishJobInput, account: JobAccount): Promise<JobResult> {
  let {workspaceId, chatId} = input;
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error("The workspace id is not valid.");
  let ws = await account.openGadget(workspaceId);
  let meta = (await ws.listChats()).find(chat => chat.id === chatId);
  if (!meta) throw new Error(`No chat ${chatId} in workspace ${workspaceId}.`);

  let pending = (await ws.listActions({filter: "pending"})).entries
    .filter(entry => entry.type === "action")
    .map(entry => ({
      id: entry.id,
      title: entry.type === "action" ? entry.description.title : "",
      resource: entry.resourceTitle,
      needsAccount: entry.type === "action" && entry.creation === true,
    }));

  let running = meta.activeAgent !== undefined;
  let proposed = meta.proposedChangeWorkpieces ?? [];
  let merged = false;
  let stale = false;
  if (!running && input.merge !== false && proposed.length > 0 && pending.length === 0) {
    let {outcome} = await ws.mergeChanges(chatId);
    merged = outcome === "merged";
    stale = outcome === "stale";
  }

  // The outputs index never holds provisional gadgets, and may not yet hold ones just merged.
  let indexed = (await account.listOutputs()).outputs.filter(o => o.workspaceId === workspaceId);
  let ids = new Map<WorkpieceId, string | undefined>(indexed.map(o => [o.workpieceId, o.title]));
  let liveIds = new Set(ids.keys());
  for (let id of proposed) {
    if (!ids.has(id)) ids.set(id, undefined);
    if (merged) liveIds.add(id);
  }

  let gadgets: JobGadget[] = [];
  for (let [id, known] of ids) {
    let isLive = liveIds.has(id);
    let formats: GadgetExportFormat[] = [];
    let title = known;
    try {
      let gadget = await ws.getGadget(id);
      title ??= await gadget.getTitle();
      formats = await gadget.getExportFormats(isLive ? undefined : chatId);
    } catch {
      // A proposed workpiece that is not a gadget (a worktree) has no title or formats to report.
      if (title === undefined) continue;
    }
    gadgets.push({id, title: title ?? `Gadget ${id}`, live: isLive, formats});
  }

  let status: JobResult["status"] = running ? "running"
    : pending.length > 0 || stale ? "needs_input"
    : "done";
  return {
    status,
    workspaceId,
    chatId,
    path: `/workspace/${workspaceId}`,
    merged,
    stale,
    gadgets,
    pendingActions: pending,
  };
}

/** One gadget's export, live code or the chat's draft. */
export async function exportJobGadget(
  account: JobAccount,
  input: {workspaceId: string; gadgetId: WorkpieceId; format: string; chatId?: number},
): Promise<ReadableStream<Uint8Array>> {
  if (!WORKSPACE_ID.test(input.workspaceId)) throw new Error("The workspace id is not valid.");
  let gadget = await (await account.openGadget(input.workspaceId)).getGadget(input.gadgetId);
  return gadget.export(input.format, input.chatId);
}
