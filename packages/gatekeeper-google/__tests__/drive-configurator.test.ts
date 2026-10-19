// The Drive configurator in a stand-in for the sandbox runtime: what it shows when a location needs
// a grant the account lacks (shared drives), and what it asks Workshop for.

import { expect, it, vi } from "vitest";
import type { DriveNodePage } from "../src/configurator/drive-configurator-types";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Button: "Button",
  Field: "Field",
  Fragment: "Fragment",
  HierarchyPicker: "HierarchyPicker",
  Notice: "Notice",
  Section: "Section",
}));

type Node = { component: unknown; props: Record<string, any>; children: unknown[] };

const nodes = (tree: unknown): Node[] => {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("component" in tree)) return [];
  return [tree as Node, ...nodes((tree as Node).children)];
};

const text = (tree: unknown): string =>
  typeof tree === "string" ? tree
  : Array.isArray(tree) ? tree.map(text).join("")
  : tree && typeof tree === "object" && "children" in tree ? text((tree as Node).children)
  : "";

const GRANT = "https://drive.google.com/drive/shared-drives";

/** A fresh module, since it keeps the pending grant at module level, and its frame. */
async function open() {
  vi.resetModules();
  const spec = (await import("../src/configurator/drive-configurator-ui")).default as unknown as {
    initial: Record<string, unknown>;
    render(context: unknown): unknown;
  };
  let values = { ...spec.initial };
  const ui = {
    listDriveNodes: vi.fn(async (): Promise<DriveNodePage> => ({ nodes: [] })),
    getDriveNode: vi.fn(),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => false);
  const find = (component: string) => nodes(spec.render({
    values,
    setValues: (patch: Record<string, unknown>) => { values = { ...values, ...patch }; },
    clearFields: () => {},
    ensureResources,
    ui,
  })).filter(node => node.component === component);
  return {
    ui, ensureResources,
    list: (parentId: string) =>
      find("HierarchyPicker")[0].props.loadItems({ parentId, query: "", cursor: null }),
    notices: () => find("Notice").map(node => ({ tone: node.props.tone, text: text(node) })),
    allow: () => find("Button").find(node => text(node) === "Allow access")?.props.onClick(),
  };
}

it("asks for the grant a location names, then stops once a listing loads", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });

  await expect(frame.list("shared-drives")).rejects.toThrow("Allow it below, then select Retry.");
  expect(frame.notices()).toEqual([
    { tone: undefined, text: expect.stringContaining('"View and download all your Drive files"') },
  ]);
  frame.allow();
  expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith([GRANT]);
  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: undefined, text: "Allow access in Google's window, then select Retry." }));

  await frame.list("shared-drives");
  expect(frame.notices()).toEqual([]);
});

it("says why the grant was not given", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
  frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));

  await expect(frame.list("shared-drives")).rejects.toThrow();
  frame.allow();

  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: "error", text: "The pop-up was closed." }));
});
