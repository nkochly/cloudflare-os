import type { Lifecycle } from "agents/lifecycle";

/** Storage key Lifecycle reads its name from when the id carries none. */
const LIFECYCLE_NAME_KEY = "__ps_name";

/**
 * Starts a Lifecycle on a Durable Object addressed by newUniqueId or idFromString. Those ids carry
 * no name, and Lifecycle refuses to start without one, so the id's hex string stands in as the
 * name: it is stable for the object's whole life.
 */
export async function startLifecycle(ctx: DurableObjectState, lifecycle: Lifecycle): Promise<void> {
  if (ctx.id.name === undefined && (await ctx.storage.get(LIFECYCLE_NAME_KEY)) === undefined) {
    await ctx.storage.put(LIFECYCLE_NAME_KEY, ctx.id.toString());
  }
  await lifecycle.start();
}
