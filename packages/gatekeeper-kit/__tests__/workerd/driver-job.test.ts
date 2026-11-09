import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { DriverJobHost } from "./worker";

const hosts = (env as unknown as { DRIVER_JOB_HOST: DurableObjectNamespace<DriverJobHost> }).DRIVER_JOB_HOST;

/** Move the job to now, as the clock would; the tests can't wait out its due time. */
async function runNow(host: DurableObjectStub<DriverJobHost>): Promise<void> {
  await runInDurableObject(host, (_instance, state) => {
    state.storage.sql.exec("UPDATE cf_agents_jobs SET time = ? WHERE id = 'drive'", Date.now());
  });
  await runDurableObjectAlarm(host);
}

it("takes over an alarm set before the driver used Lifecycle, due at the same time", async () => {
  const host = hosts.getByName("legacy");
  const legacyAt = Date.now() + 3_600_000;
  // An object from before the change: its alarm is set, and it has no job.
  await runInDurableObject(host, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM cf_agents_jobs");
    await state.storage.setAlarm(legacyAt);
  });
  await abortAllDurableObjects();
  expect(await hosts.getByName("legacy").due()).toBe(legacyAt);
});

it("keeps an earlier due time on wakeBy, and brings a later one forward", async () => {
  const host = hosts.getByName("wake");
  const now = Date.now();
  await host.wakeBy(now + 60_000);
  await host.wakeBy(now + 120_000);
  expect(await host.due()).toBe(now + 60_000);
  await host.wakeBy(now + 30_000);
  expect(await host.due()).toBe(now + 30_000);
  expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBe(now + 30_000);
});

it("runs a due job, which then stands at the time the run set, or is gone", async () => {
  const host = hosts.getByName("run");
  await host.wakeBy(Date.now() + 60_000);
  const next = Date.now() + 600_000;
  await host.script({ next });
  await runNow(host);
  expect(await host.runs()).toBe(1);
  expect(await host.due()).toBe(next);

  await host.script({});
  await runNow(host);
  expect(await host.runs()).toBe(2);
  expect(await host.due()).toBeUndefined();
  expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("tries a run that threw again after failureRetryMs", async () => {
  const host = hosts.getByName("fail");
  await host.wakeBy(Date.now() + 60_000);
  await host.script({ fail: true });
  const ranAt = Date.now();
  await runNow(host);
  expect(await host.runs()).toBe(1);
  expect(await host.due()).toBeGreaterThanOrEqual(ranAt + 60_000);
});

it("deletes the job and the alarm with the rest of storage on destroy", async () => {
  const host = hosts.getByName("destroy");
  await host.wakeBy(Date.now() + 60_000);
  await host.destroy();
  await runInDurableObject(host, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    expect((await state.storage.list()).size).toBe(0);
  });
});
