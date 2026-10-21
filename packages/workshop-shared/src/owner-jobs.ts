import type { RpcStub } from "cloudflare:workers";
import type { GadgetExportFormat, WorkpieceId } from "./api";
import type { ChatGatewayRpcTarget } from "./external-message-gateway";

/**
 * A build job run headless by the account an OwnerApi binding names: no browser, no Access
 * session. The caller starts it, is told once the agent's turn ends (through `notify`, delivered
 * at least once like a gateway reply), then finishes it, which merges the chat's changes and
 * reports the workspace's state as data.
 */
export type StartJobInput = {
  /** Names the app; the workspace is keyed by it, so the same app reuses the same workspace. */
  app: string;
  /** The workspace title when it is created. */
  title: string;
  /** What to build or change, standing alone. */
  brief: string;
  /** Selects the chat to continue; defaults to the app's own chat. */
  chatKey?: string;
  /** Deduplicates the job: starting the same id twice submits once. */
  jobId: string;
  /** Called once the agent's turn ends. Must be idempotent. */
  notify: RpcStub<ChatGatewayRpcTarget>;
};

export type StartJobResult =
  | { accepted: true; workspaceId: string; chatId: number; path: string }
  | { accepted: false; message: string };

export type FinishJobInput = {
  workspaceId: string;
  chatId: number;
  /** False leaves the chat's changes as a draft for a person to accept. Default true. */
  merge?: boolean;
};

export type JobGadget = {
  id: WorkpieceId;
  title: string;
  /** False while the gadget exists only in the chat's unaccepted changes. */
  live: boolean;
  formats: GadgetExportFormat[];
};

export type JobPendingAction = {
  id: number;
  title: string;
  resource: string;
  /** A creation waits for a person to pick the account it is made with, in the browser. */
  needsAccount: boolean;
};

export type JobResult = {
  /**
   * "running": the agent is still working. "needs_input": something waits on a person (an
   * approval, an account, or a merge that could not fast-forward). "done": merged and live, or
   * left as a draft on request.
   */
  status: "running" | "needs_input" | "done";
  workspaceId: string;
  chatId: number;
  /** Path of the workspace, without the chat: what a person opens to use the live app. */
  path: string;
  merged: boolean;
  /** The merge found mainline moved past the chat; nothing was merged. */
  stale: boolean;
  gadgets: JobGadget[];
  pendingActions: JobPendingAction[];
};
