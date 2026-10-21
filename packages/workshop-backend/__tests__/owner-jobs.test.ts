import { describe, expect, it, vi } from "vitest";
import { finishJob, jobWorkspaceName, startJob, type JobAccount, type JobWorkspace } from "../src/owner-jobs";

const WS = "a".repeat(64);

function account(opts: {
  active?: boolean;
  proposed?: number[];
  pending?: Array<{id: number; creation?: boolean}>;
  indexed?: Array<{id: number; title: string}>;
  outcome?: "merged" | "stale";
}) {
  let mergeChanges = vi.fn(async () => ({outcome: opts.outcome ?? "merged" as const}));
  let getExportFormats = vi.fn(async (_chatId?: number) => [
    {id: "pdf", label: "PDF", mode: "browser" as const, contentType: "application/pdf", fileExtension: ".pdf"},
  ]);
  let ws: JobWorkspace = {
    listChats: async () => [{
      id: 7, title: "t", started: new Date(), lastActive: new Date(),
      ...(opts.active ? {activeAgent: {type: "agent", id: "m"} as never} : {}),
      proposedChangeWorkpieces: opts.proposed ?? [],
    }],
    listActions: async () => ({entries: (opts.pending ?? []).map(p => ({
      id: p.id, type: "action" as const, resourceTitle: "Slack", createdAt: new Date(),
      state: "pending" as never, description: {title: `post ${p.id}`} as never,
      ...(p.creation ? {creation: true as const} : {}),
    }))}),
    mergeChanges,
    getGadget: async id => ({getTitle: async () => `Draft ${id}`, getExportFormats, export: async () => new ReadableStream()}),
  };
  let acct: JobAccount = {
    openGadget: async () => ws,
    listOutputs: async () => ({catchingUp: false, outputs: (opts.indexed ?? []).map(o => ({
      workspaceId: WS, workpieceId: o.id, title: o.title, workspaceTitle: "W",
      created: new Date(), lastActive: new Date(),
    }))}),
  };
  return {acct, mergeChanges, getExportFormats};
}

describe("startJob", () => {
  it("submits under the owner source and reads the chat path", async () => {
    let receive = vi.fn(async () => ({accepted: true as const, chatPath: `/workspace/${WS}?chat=3`}));
    let names: string[] = [];
    let result = await startJob(
      {app: "pipeline", title: "Pipeline", brief: "Build it", jobId: "j1", notify: {} as never},
      "me@x.com",
      name => (names.push(name), {receiveExternalMessage: receive}),
    );
    expect(names).toEqual([await jobWorkspaceName("pipeline")]);
    expect(receive.mock.calls[0][0]).toMatchObject({
      callerEmail: "me@x.com", externalChatKey: "owner:app:pipeline", idempotencyKey: "owner:job:j1",
    });
    expect(result).toEqual({accepted: true, workspaceId: WS, chatId: 3, path: `/workspace/${WS}?chat=3`});
  });

  it("turns away a bad slug without touching a workspace", async () => {
    let overseer = vi.fn();
    let result = await startJob(
      {app: "Bad Slug", title: "t", brief: "b", jobId: "j", notify: {} as never}, "me@x.com", overseer);
    expect(result.accepted).toBe(false);
    expect(overseer).not.toHaveBeenCalled();
  });
});

describe("finishJob", () => {
  it("merges a finished chat and reports the new gadget live", async () => {
    let {acct, mergeChanges, getExportFormats} = account({proposed: [4]});
    let result = await finishJob({workspaceId: WS, chatId: 7}, acct);
    expect(mergeChanges).toHaveBeenCalledWith(7);
    expect(getExportFormats).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({status: "done", merged: true, path: `/workspace/${WS}`,
      gadgets: [{id: 4, title: "Draft 4", live: true}]});
  });

  it("does not merge while the agent is running", async () => {
    let {acct, mergeChanges} = account({active: true, proposed: [4]});
    let result = await finishJob({workspaceId: WS, chatId: 7}, acct);
    expect(mergeChanges).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
    expect(result.gadgets[0]).toMatchObject({id: 4, live: false});
  });

  it("holds the merge while an action waits, and flags a creation", async () => {
    let {acct, mergeChanges, getExportFormats} = account({proposed: [4], pending: [{id: 9, creation: true}]});
    let result = await finishJob({workspaceId: WS, chatId: 7}, acct);
    expect(mergeChanges).not.toHaveBeenCalled();
    expect(getExportFormats).toHaveBeenCalledWith(7);
    expect(result.status).toBe("needs_input");
    expect(result.pendingActions).toEqual([{id: 9, title: "post 9", resource: "Slack", needsAccount: true}]);
  });

  it("reports a stale merge as needing input", async () => {
    let {acct} = account({proposed: [4], outcome: "stale"});
    let result = await finishJob({workspaceId: WS, chatId: 7}, acct);
    expect(result).toMatchObject({status: "needs_input", merged: false, stale: true});
  });

  it("leaves a draft when asked, and lists every live gadget", async () => {
    let {acct, mergeChanges} = account({proposed: [5], indexed: [{id: 1, title: "Deck"}, {id: 2, title: "Sheet"}]});
    let result = await finishJob({workspaceId: WS, chatId: 7, merge: false}, acct);
    expect(mergeChanges).not.toHaveBeenCalled();
    expect(result.gadgets.map(g => [g.id, g.title, g.live])).toEqual([
      [1, "Deck", true], [2, "Sheet", true], [5, "Draft 5", false],
    ]);
  });
});
