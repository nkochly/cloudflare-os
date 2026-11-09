/**
 * The one `agents` Lifecycle job a driver Durable Object keeps in place of its own alarm. A driver
 * has several concerns that each need it to run at some time (a delivery's retry, a subscription's
 * renewal, a schedule's next firing); the job is due at the earliest of them, and each run handles
 * every concern that has come due, then sets the job for the next one.
 *
 * The Lifecycle owns the object's physical alarm: nothing in a driver that uses this sets, reads or
 * deletes one, and the driver defines no `alarm()` of its own (Lifecycle installs its own handler
 * only where the host has none). Lifecycle needs the object's name, so only an object addressed by
 * `getByName()`/`idFromName()` can use it; one created by `newUniqueId()` cannot.
 */

import type { Lifecycle, LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";

/** How long a run may take before Lifecycle treats it as hung and runs the job again. */
const DEFAULT_HUNG_TIMEOUT_SECONDS = 300;
/** When a run that threw is tried again. */
const DEFAULT_FAILURE_RETRY_MS = 60_000;

export type DriverJobOptions = {
  /** How long a run may take before Lifecycle treats it as hung and runs the job again. */
  hungTimeoutSeconds?: number;
  /** When a run that threw is tried again. */
  failureRetryMs?: number;
};

/**
 * @example
 * ```ts
 * export class HookDriver extends DurableObject<Env> {
 *   readonly #job = new DriverJob(Lifecycle.install(this), this.ctx, "drive");
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     ctx.blockConcurrencyWhile(() => this.#job.start());
 *   }
 *
 *   async onJob(context: LifecycleJobContext) {
 *     return this.#job.drive(context, async () => {
 *       await this.#queue.run(Date.now(), deliver);
 *       await this.#job.set(this.#queue.nextDue());
 *     }, error => logger.error("drive failed", { error }));
 *   }
 * }
 * ```
 */
export class DriverJob {
  readonly #lifecycle: Lifecycle<object>;
  readonly #ctx: DurableObjectState;
  readonly #id: string;
  readonly #hungTimeoutSeconds: number;
  readonly #failureRetryMs: number;

  /**
   * @param lifecycle The driver's installed Lifecycle.
   * @param ctx The driver's `ctx`.
   * @param id The job's id, which is also the `fn` it is dispatched as.
   */
  constructor(lifecycle: Lifecycle<object>, ctx: DurableObjectState, id: string,
              options: DriverJobOptions = {}) {
    this.#lifecycle = lifecycle;
    this.#ctx = ctx;
    this.#id = id;
    this.#hungTimeoutSeconds = options.hungTimeoutSeconds ?? DEFAULT_HUNG_TIMEOUT_SECONDS;
    this.#failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
  }

  /**
   * Start the Lifecycle, which native RPC bypasses, so a driver calls this from its constructor's
   * `blockConcurrencyWhile`. An alarm the driver set itself before it used Lifecycle becomes the
   * job, due at the same time, so no object loses its next run.
   */
  async start(): Promise<void> {
    await this.#lifecycle.start();
    if (this.due() !== undefined) return;
    const alarm = await this.#ctx.storage.getAlarm();
    if (alarm !== null) await this.set(alarm);
  }

  /** When the job is next due, or `undefined` while nothing needs the driver. */
  due(): number | undefined {
    return this.#lifecycle.jobs.get(this.#id)?.time;
  }

  /** Make the job due by `time`: an earlier due time stands. */
  async wakeBy(time: number): Promise<void> {
    const due = this.due();
    if (due === undefined || time < due) await this.set(time);
  }

  /** Make the job due at `time`, or remove it when `time` is `undefined`. */
  async set(time: number | undefined): Promise<void> {
    if (time === undefined) {
      await this.#lifecycle.jobs.cancel(this.#id);
      return;
    }
    await this.#lifecycle.jobs.push({
      id: this.#id,
      fn: this.#id,
      time,
      singleflight: true,
      hungTimeoutSeconds: this.#hungTimeoutSeconds,
    });
  }

  /**
   * Run `work` for a dispatch of this job, from the driver's `onJob`, and return what Lifecycle
   * should do with the job. `work` sets the job for its next run with `set()`, which takes
   * precedence over the returned outcome; a job `work` leaves unset is done. A run that throws is
   * reported to `onError` and tried again after `failureRetryMs`, unless `work` set the job first.
   *
   * @returns `undefined` for another job's dispatch, which `onJob` should handle itself.
   */
  async drive(context: LifecycleJobContext, work: () => Promise<void>,
              onError: (error: unknown) => void): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== this.#id) return undefined;
    try {
      await work();
      return undefined;
    } catch (error) {
      onError(error);
      return { rescheduleAt: Date.now() + this.#failureRetryMs };
    }
  }

  /**
   * Delete everything the driver stores, the job included. Alarms are disabled first, as
   * `Agent.destroy()` does, so the run this may be part of leaves nothing behind. Unlike
   * `Agent.destroy()` the object is not reset, so a stub its callers hold keeps working; the job
   * can't be set again until the object is next started, so only an object that is never used
   * again after deletion may call this.
   */
  async destroy(): Promise<void> {
    await this.#lifecycle.disableAlarms();
    await this.#ctx.storage.deleteAll();
  }

}
