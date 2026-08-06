import { beforeEach, describe, expect, it } from "vitest";

import { clearAllTodoComposerDrafts } from "./todo-draft-storage";

describe("Todo composer draft storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("clears every Workspace and Project Todo draft without touching other settings", () => {
    window.localStorage.setItem("project-mind:todo-rail-draft:workspace", "workspace draft");
    window.localStorage.setItem("project-mind:todo-rail-draft:7", "project draft");
    window.localStorage.setItem("project-mind:ui", "settings");

    clearAllTodoComposerDrafts();

    expect(window.localStorage.getItem("project-mind:todo-rail-draft:workspace")).toBeNull();
    expect(window.localStorage.getItem("project-mind:todo-rail-draft:7")).toBeNull();
    expect(window.localStorage.getItem("project-mind:ui")).toBe("settings");
  });
});
