import { beforeEach, describe, expect, it } from "vitest";
import { createListPinsStore, recordPinScope } from "./list-pins-store";

describe("list pin preferences", () => {
  beforeEach(() => localStorage.clear());

  it("isolates matching IDs across workspaces, projects and workspace records", () => {
    const store = createListPinsStore();
    const scopes = ["projects", "todos", recordPinScope(null), recordPinScope(1), recordPinScope(2)] as const;
    for (const workspace of ["/one", "/two"]) {
      for (const scope of scopes) store.getState().togglePin(workspace, scope, 7);
    }
    store.getState().togglePin("/one", recordPinScope(1), 7);
    for (const workspace of ["/one", "/two"]) {
      for (const scope of scopes) {
        expect(store.getState().pins[JSON.stringify([workspace, scope])]).toEqual(
          workspace === "/one" && scope === "project-records:1" ? [] : [7],
        );
      }
    }
    expect(recordPinScope(undefined)).toBe("workspace-records");
  });

  it.each(["projects", "todos"] as const)("reloads persisted %s pins without replacing actions", async (scope) => {
    const first = createListPinsStore();
    first.getState().togglePin("/workspace", scope, 7);
    const reloaded = createListPinsStore();
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().pins[JSON.stringify(["/workspace", scope])]).toEqual([7]);
    reloaded.getState().togglePin("/workspace", scope, 7);
    expect(reloaded.getState().pins[JSON.stringify(["/workspace", scope])]).toEqual([]);
  });

  it("pins and unpins an item through its scoped action", () => {
    const store = createListPinsStore();
    store.getState().togglePin("/workspace", "projects", 7);
    expect(store.getState().pins[JSON.stringify(["/workspace", "projects"])]).toEqual([7]);
    store.getState().togglePin("/workspace", "projects", 7);
    expect(store.getState().pins[JSON.stringify(["/workspace", "projects"])]).toEqual([]);
  });
});
