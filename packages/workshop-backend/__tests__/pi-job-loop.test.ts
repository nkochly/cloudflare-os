// The headless job loop with the turn on Pi (pi-chat.ts): a Pi run (pi's faux provider standing
// in for the model) creates a gadget and writes its server code into the chat's Workspace draft,
// the draft lands in the chat as one step, and finishJob merges it live and exports it, exactly
// as job-loop.test.ts does for the legacy loop.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import {exportJobGadget, finishJob, type JobAccount} from "../src/owner-jobs";

const USER = {type: "user" as const, id: "owner@example.com", name: "Owner"};
const AUTHOR = {type: "agent" as const, id: "faux-model", name: "Faux"};
const WS = "c".repeat(64);
const CHAT = 1;

const SERVER_JS = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async rows() { return "deal,stage\\nacme,won\\n"; }
}
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    return [{ id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" }];
  }
  async export(gadget, id) {
    let csv = await gadget.rows();
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(csv)); c.close(); } });
  }
}
`;

function account(impl: any): JobAccount {
  let workspace = {
    listChats: async () => [...impl.storage.chatMeta.list()].map((m: any) => impl.chatMetaForClient(m)),
    listActions: async () => ({entries: []}),
    mergeChanges: (chatId: number) => impl.withChatLock(chatId,
        () => impl.mergeChanges(chatId, {profile: USER}, "owner-user-do")),
    getGadget: async (id: number) => ({
      getTitle: async () => impl.getGadgetRecord(id).title,
      getExportFormats: (chatId?: number) => impl.getGadgetExportFormats(id, chatId),
      export: (format: string, chatId?: number) => impl.exportGadget(id, format, chatId),
    }),
  };
  return {
    openGadget: async () => workspace,
    listOutputs: async () => ({catchingUp: false, outputs: [...impl.storage.gadgets.list()]
        .filter((g: any) => g.type === "gadget" && g.commitId !== undefined)
        .map((g: any) => ({workspaceId: WS, workpieceId: g.id, title: g.title, workspaceTitle: "Job",
          created: new Date(), lastActive: new Date()}))}),
  };
}

describe("headless job loop on Pi", () => {
  it("builds in the Workspace draft, lands as a step, merges live and exports", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      let impl = instance.impl as any;
      let timestamp = impl.getChatTimestamp();
      impl.storage.chatMeta.put({id: CHAT, title: "Job", started: timestamp, lastActive: timestamp});
      impl.addChatMessages(CHAT, USER, [{type: "message", message: "Build a deals tracker."}]);

      let faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("createGadget", {title: "Deals", bindingName: "DEALS"}),
            {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxToolCall("write", {path: "/workspace/DEALS/server.js", content: SERVER_JS}),
            {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxText("Built the deals tracker.")),
      ]);
      await impl.piChats.runTurn(impl, {model: faux.getModel(), stream: faux.stream}, CHAT, AUTHOR,
          new AbortController().signal);

      // The draft landed as the chat's own change: the gadget is provisional to the chat.
      let [meta] = await account(impl).openGadget(WS).then(ws => ws.listChats());
      expect(meta.proposedChangeWorkpieces?.length).toBe(1);
      let gadgetId = meta.proposedChangeWorkpieces![0];
      let history = impl.loadChatHistory(CHAT).chatMessages;
      expect(history.filter((m: any) => m.type === "message").at(-1).message).toBe("Built the deals tracker.");

      let result = await finishJob({workspaceId: WS, chatId: CHAT}, account(impl));
      expect(result).toMatchObject({
        status: "done", merged: true, stale: false, pendingActions: [],
        gadgets: [{id: gadgetId, title: "Deals", live: true,
          formats: [{id: "csv", mode: "server", contentType: "text/csv"}]}],
      });

      let csv = await exportJobGadget(account(impl), {workspaceId: WS, gadgetId, format: "csv"});
      expect(await new Response(csv).text()).toBe("deal,stage\nacme,won\n");

      // A second turn with nothing new to answer is a no-op.
      await impl.piChats.runTurn(impl, {model: faux.getModel(), stream: faux.stream}, CHAT, AUTHOR,
          new AbortController().signal);
      expect(faux.getPendingResponseCount()).toBe(0);
    });
  });
});
