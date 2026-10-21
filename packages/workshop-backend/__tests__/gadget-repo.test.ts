// Spike: a gadget's code in a computer Workspace with each chat's draft as a git branch. Checks
// the semantics the Overseer needs (drafts isolated from mainline and from each other, accept as
// a merge, a conflicting accept refused as stale with mainline untouched) and records what each
// step costs in wall time and Durable Object SQLite size.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import type {OverseerDurableObject} from "../src/overseer";
import {GadgetRepo} from "../src/gadget-repo";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const FILES = {
  "server.js": "export class Gadget {}\n" + "// padding\n".repeat(200),
  "client.js": "export default function App() {}\n" + "// padding\n".repeat(400),
  "lib/util.js": "export const one = 1;\n",
};

type Repo = (repo: GadgetRepo, sql: SqlStorage) => Promise<unknown>;

function inRepo(name: string) {
  let stub = env.TEST_OVERSEER.getByName(name);
  return async <T>(fn: Repo): Promise<{value: T; ms: number; bytes: number}> => {
    let started = Date.now();
    let out = await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let storage = (instance as unknown as {ctx: DurableObjectState}).ctx.storage;
      let before = storage.sql.databaseSize;
      let value = await fn(new GadgetRepo(storage, 1), storage.sql);
      return {value, bytes: storage.sql.databaseSize - before};
    });
    return {value: out.value as T, ms: Date.now() - started, bytes: out.bytes};
  };
}

describe("gadget repo spike (computer git, drafts as branches)", () => {
  it("keeps drafts apart, accepts by merge and refuses a conflicting accept", async () => {
    let run = inRepo(`gadget-repo-${crypto.randomUUID()}`);
    let costs: Record<string, {ms: number; bytes: number}> = {};
    let step = async <T>(label: string, fn: Repo) => {
      let r = await run<T>(fn);
      costs[label] = {ms: r.ms, bytes: r.bytes};
      return r.value;
    };

    await step("init (3 files)", repo => repo.init(FILES));
    await step("open two drafts", async repo => { await repo.openDraft(1); await repo.openDraft(2); });
    await step("draft 1 edit", repo => repo.writeDraft(1, {"lib/util.js": "export const one = 1;\nexport const two = 2;\n"}, "add two"));
    await step("draft 2 edit", repo => repo.writeDraft(2, {"lib/util.js": "export const one = 'uno';\n"}, "rename one"));

    // Each chat sees its own draft; mainline is untouched; reads need no checkout.
    let views = await step<string[]>("read three views", async repo => [
      await repo.readForChat(1, "lib/util.js"), await repo.readForChat(2, "lib/util.js"),
      await repo.read("main", "lib/util.js"), await repo.readForChat(3, "lib/util.js"),
    ]);
    expect(views).toEqual([
      "export const one = 1;\nexport const two = 2;\n", "export const one = 'uno';\n",
      "export const one = 1;\n", "export const one = 1;\n",
    ]);

    // Ten small edits on one draft, the agent's usual rhythm.
    await step("10 draft commits", async repo => {
      for (let i = 0; i < 10; i++) {
        await repo.writeDraft(1, {"server.js": FILES["server.js"] + `// edit ${i}\n`}, `edit ${i}`);
      }
    });

    let merged = await step<{outcome: string}>("accept draft 1", repo => repo.mergeDraft(1));
    expect(merged.outcome).toBe("merged");
    let main = await run<string[]>(async repo => [
      await repo.read("main", "lib/util.js"), await repo.read("main", "server.js"),
    ]);
    expect(main.value[0]).toContain("two = 2");
    expect(main.value[1]).toContain("// edit 9");

    // Draft 2 changed the same line draft 1 did: accepting it now is refused, mainline unchanged.
    let headBefore = (await run<string>(repo => repo.head())).value;
    let stale = await step<{outcome: string; error?: string}>("accept conflicting draft 2", repo => repo.mergeDraft(2));
    expect(stale.outcome).toBe("stale");
    expect((await run<string>(repo => repo.head())).value).toBe(headBefore);
    expect((await run<string | undefined>(repo => repo.readForChat(2, "lib/util.js"))).value)
        .toBe("export const one = 'uno';\n");

    // Baseline: the same ten commits through today's git store (whole-tree commits, no checkout).
    let base = env.TEST_OVERSEER.getByName(`git-store-${crypto.randomUUID()}`);
    let baseline = async (fn: (impl: any) => Promise<unknown>) => {
      let started = Date.now();
      let bytes = await runInDurableObject(base, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as {impl: any}).impl;
        let before = impl.ctx.storage.sql.databaseSize;
        await fn(impl);
        return impl.ctx.storage.sql.databaseSize - before;
      });
      return {ms: Date.now() - started, bytes};
    };
    let opts = (n: number, parents: string[]) => ({parents, message: `edit ${n}`,
      author: {name: "Workshop", email: "workshop@localhost"}, timestamp: new Date(1700000000_000 + n)});
    let parent = "";
    costs["git store: init"] = await baseline(async impl => {
      parent = await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(FILES)), opts(0, []));
    });
    costs["git store: 10 commits"] = await baseline(async impl => {
      for (let i = 0; i < 10; i++) {
        parent = await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(
            {...FILES, "server.js": FILES["server.js"] + `// edit ${i}\n`})), opts(i + 1, [parent]));
      }
    });

    // A draft as a plain Workspace directory instead: ten file writes, no git.
    await step("10 plain file writes", async repo => {
      await repo.workspace.fs.mkdir("/drafts/1", {recursive: true});
      for (let i = 0; i < 10; i++) {
        await repo.workspace.fs.writeFile("/drafts/1/server.js", FILES["server.js"] + `// edit ${i}\n`);
      }
    });

    console.log("gadget-repo spike costs", JSON.stringify(costs, null, 1), "conflict:", stale.error);
  });
});
