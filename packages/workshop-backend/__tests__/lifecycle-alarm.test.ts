// The workspace's alarm is a host job in the Agents Lifecycle queue: pushing it arms the physical
// alarm, and the alarm dispatches it to OverseerDurableObject.onJob, which runs the alarm tasks.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it, vi} from "vitest";
import type {OverseerDurableObject} from "../src/overseer";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

describe("workspace alarm on the Lifecycle queue", () => {
  it("arms the physical alarm and dispatches the job to the alarm tasks", async () => {
    let stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    let runs = 0;
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as {impl: any}).impl;
      let run = impl.runAlarmTasks.bind(impl);
      impl.runAlarmTasks = async (retry?: number) => { runs++; await run(retry); };
      await impl.jobs.push({id: "workspace-alarm", fn: "runAlarmTasks", time: Date.now() + 50});
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      // The runtime fires the alarm on its own once due.
      await vi.waitFor(() => expect(runs).toBe(1), {timeout: 5000});
      // Nothing was outstanding, so the tasks' recompute left no job behind.
      await vi.waitFor(() => expect(impl.jobs.get("workspace-alarm")).toBeUndefined());
    });
  });
});
