// The headless job loop end to end inside a real workspace: an agent turn (pi's faux provider
// standing in for the model) creates a gadget with a server export, finishJob merges the chat so
// the gadget is live and reports it as data, and the export runs against the live code. This is
// the acceptance test the SDK refactor keeps green at every step.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import {runAgent} from "../src/agent";
import {exportJobGadget, finishJob, type JobAccount} from "../src/owner-jobs";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

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

/** The owner's view of this one workspace, straight over the real Overseer implementation. */
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
    openGadget: async (id: string) => {
      expect(id).toBe(WS);
      return workspace;
    },
    // The owner's outputs index, as the workspace pushes it: committed gadgets only.
    listOutputs: async () => ({catchingUp: false, outputs: [...impl.storage.gadgets.list()]
        .filter((g: any) => g.type === "gadget" && g.commitId !== undefined)
        .map((g: any) => ({workspaceId: WS, workpieceId: g.id, title: g.title, workspaceTitle: "Job",
          created: new Date(), lastActive: new Date()}))}),
  };
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("headless job loop", () => {
  it("builds, merges live, reports as data and exports", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      let impl = instance.impl as any;
      let timestamp = impl.getChatTimestamp();
      impl.storage.chatMeta.put({id: CHAT, title: "Job", started: timestamp, lastActive: timestamp});
      impl.addChatMessages(CHAT, USER, [{type: "message", message: "Build a deals tracker."}]);
      impl.getInstanceInstructions = async () => "";
      impl.describeStandardFormats = async () => [];
      impl.listConnectableVendors = async () => [];

      let faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("createGadget", {title: "Deals", bindingName: "DEALS"}),
            {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxToolCall("writeFile",
            {workpiece: "DEALS", filename: "server.js", content: SERVER_JS}), {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxText("Built the deals tracker.")),
      ]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, CHAT, AUTHOR,
          new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""} as any);

      // Before finishing, the gadget is a draft that only the chat can see.
      let [meta] = await account(impl).openGadget(WS).then(ws => ws.listChats());
      expect(meta.proposedChangeWorkpieces?.length).toBe(1);
      let gadgetId = meta.proposedChangeWorkpieces![0];

      let result = await finishJob({workspaceId: WS, chatId: CHAT}, account(impl));
      expect(result).toMatchObject({
        status: "done", merged: true, stale: false, pendingActions: [],
        gadgets: [{id: gadgetId, title: "Deals", live: true,
          formats: [{id: "csv", mode: "server", contentType: "text/csv"}]}],
      });

      // Finishing again is a no-op that reports the same live gadget.
      let again = await finishJob({workspaceId: WS, chatId: CHAT}, account(impl));
      expect(again).toMatchObject({status: "done", merged: false, gadgets: [{id: gadgetId, live: true}]});

      let csv = await exportJobGadget(account(impl), {workspaceId: WS, gadgetId, format: "csv"});
      expect(await text(csv)).toBe("deal,stage\nacme,won\n");
    });
  });
});
