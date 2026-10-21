/**
 * Every Overseer and User Durable Object is addressed by name (getByName / idFromName), never by
 * id string, so `ctx.id.name` is always set: the Agents SDK Lifecycle requires it. A workspace's
 * name is 64 lowercase hex characters and is what URLs carry; a user's name is their username.
 */
export const WORKSPACE_NAME = /^[0-9a-f]{64}$/;

/** A fresh, unguessable workspace name. */
export function newWorkspaceName(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toHex();
}

/** A stable workspace name derived from a key, for workspaces found again by key (owner jobs). */
export async function workspaceNameFor(key: string): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).toHex();
}
