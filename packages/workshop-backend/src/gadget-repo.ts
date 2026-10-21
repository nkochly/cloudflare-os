import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";

/**
 * Spike: one gadget's code as a git repository in a computer Workspace, with each chat's draft as
 * a branch. Computer's git is isomorphic-git over the Workspace's SQLite files and keeps a single
 * working tree per repository, so writing to a draft checks its branch out; reads of any branch
 * go through the object store (lsTree/catFile) and need no checkout. Callers serialize writes per
 * gadget, as the Overseer already serializes them per chat.
 */
export type MergeOutcome = { outcome: "merged"; oid: string } | { outcome: "stale"; error: string };

const MAIN = "main";
const AUTHOR = { name: "Workshop", email: "workshop@localhost" };
const draftBranch = (chatId: number) => `chat-${chatId}`;

export class GadgetRepo {
  readonly #ws: Workspace;
  readonly #dir: string;

  constructor(storage: DurableObjectStorageLike, gadgetId: number) {
    this.#ws = new Workspace({ storage, git: createGitClient(), defaultGitIdentity: AUTHOR, output: false });
    this.#dir = `/gadgets/${gadgetId}`;
  }

  get workspace(): Workspace { return this.#ws; }

  /** Creates the repository with its first mainline commit. */
  async init(files: Record<string, string>): Promise<string> {
    await this.#ws.fs.mkdir(this.#dir, { recursive: true });
    await this.#ws.git.init({ dir: this.#dir, defaultBranch: MAIN });
    return this.#commitFiles(files, "Initial version");
  }

  /** Starts a chat's draft from mainline's current head. Idempotent. */
  async openDraft(chatId: number): Promise<void> {
    let branches = await this.#ws.git.branchList({ dir: this.#dir });
    if (!branches.includes(draftBranch(chatId))) {
      await this.#ws.git.branch({ dir: this.#dir, name: draftBranch(chatId), startPoint: MAIN });
    }
  }

  /** Writes files to a chat's draft as one commit. */
  async writeDraft(chatId: number, files: Record<string, string>, message: string): Promise<string> {
    await this.#ws.git.checkout({ dir: this.#dir, ref: draftBranch(chatId) });
    try {
      return await this.#commitFiles(files, message);
    } finally {
      await this.#ws.git.checkout({ dir: this.#dir, ref: MAIN });
    }
  }

  /** Writes files straight to mainline (another chat's accepted change, or a person's edit). */
  async writeMain(files: Record<string, string>, message: string): Promise<string> {
    await this.#ws.git.checkout({ dir: this.#dir, ref: MAIN });
    return this.#commitFiles(files, message);
  }

  /** Reads a file at a ref (a branch, `main`, or a commit) without touching the working tree. */
  async read(ref: string, path: string): Promise<string | undefined> {
    let commit = await this.head(ref);
    try {
      let blob = await this.#ws.git.catFile({ dir: this.#dir, oid: commit, filepath: path });
      return new TextDecoder().decode(blob.bytes);
    } catch {
      return undefined;
    }
  }

  /** Reads a chat's view: its draft if it has one, else mainline. */
  async readForChat(chatId: number, path: string): Promise<string | undefined> {
    let branches = await this.#ws.git.branchList({ dir: this.#dir });
    return this.read(branches.includes(draftBranch(chatId)) ? draftBranch(chatId) : MAIN, path);
  }

  /** Accepts a chat's draft into mainline; a conflict leaves mainline as it was and reports stale. */
  async mergeDraft(chatId: number): Promise<MergeOutcome> {
    await this.#ws.git.checkout({ dir: this.#dir, ref: MAIN });
    try {
      let result = await this.#ws.git.merge({
        dir: this.#dir, ours: MAIN, theirs: draftBranch(chatId), message: `Accept chat ${chatId}`,
      });
      await this.#ws.git.checkout({ dir: this.#dir, ref: MAIN, force: true });
      await this.#ws.git.branchDelete({ dir: this.#dir, name: draftBranch(chatId) });
      return { outcome: "merged", oid: result.oid ?? await this.head() };
    } catch (err) {
      await this.#ws.git.checkout({ dir: this.#dir, ref: MAIN, force: true });
      return { outcome: "stale", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async head(ref = MAIN): Promise<string> {
    return this.#ws.git.revParse({ dir: this.#dir, ref });
  }

  async log(ref = MAIN): Promise<string[]> {
    return (await this.#ws.git.log({ dir: this.#dir, ref })).map(c => c.message.trim());
  }

  async #commitFiles(files: Record<string, string>, message: string): Promise<string> {
    for (let [path, content] of Object.entries(files)) {
      let full = `${this.#dir}/${path}`;
      await this.#ws.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await this.#ws.fs.writeFile(full, content);
    }
    await this.#ws.git.add({ dir: this.#dir, paths: Object.keys(files) });
    return (await this.#ws.git.commit({ dir: this.#dir, message, author: AUTHOR })).oid;
  }
}
