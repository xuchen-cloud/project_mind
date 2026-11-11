import { beforeEach, describe, expect, it } from "vitest";
import { fileNavigationScopeKey, indexProjectFiles, notifyProjectFilesChanged, openProjectFilePreview, projectFilePathMatches, useProjectFileNavigation } from "./project-file-navigation";
beforeEach(() => useProjectFileNavigation.setState({ request: null, revisions: {} }));
it("isolates Workspace and Project file refreshes and captures the originating Workspace in navigation", () => {
  notifyProjectFilesChanged(null, "/workspace/a");
  notifyProjectFilesChanged(7, "/workspace/a");
  notifyProjectFilesChanged(null, "/workspace/b");
  notifyProjectFilesChanged(null, "/workspace/a");
  const revisions = useProjectFileNavigation.getState().revisions;
  expect(revisions[fileNavigationScopeKey(null, "/workspace/a")]).toBe(2);
  expect(revisions[fileNavigationScopeKey(7, "/workspace/a")]).toBe(1);
  expect(revisions[fileNavigationScopeKey(null, "/workspace/b")]).toBe(1);
  openProjectFilePreview(null, "plan.md", undefined, undefined, undefined, "/workspace/a");
  expect(useProjectFileNavigation.getState().request).toMatchObject({ workspaceRoot: "/workspace/a", projectId: null, path: "plan.md" });
});

describe("indexProjectFiles", () => {
  it.each([
    { name: "Unix paths", rootPath: "/workspace", managedPath: "/workspace/notes/plan.md", relativePath: "notes/plan.md", matches: true },
    { name: "Windows paths", rootPath: "C:\\workspace", managedPath: "C:\\workspace\\notes\\plan.md", relativePath: "notes/plan.md", matches: true },
    { name: "mixed separators", rootPath: "C:\\workspace/", managedPath: "C:/workspace\\notes/plan.md", relativePath: "notes/plan.md", matches: true },
    { name: "one trailing root slash", rootPath: "/workspace/", managedPath: "/workspace/plan.md", relativePath: "plan.md", matches: true },
    { name: "one trailing Windows root slash", rootPath: "C:\\workspace\\", managedPath: "C:\\workspace\\plan.md", relativePath: "plan.md", matches: true },
    { name: "only one trailing root slash removed", rootPath: "/workspace//", managedPath: "/workspace//plan.md", relativePath: "plan.md", matches: true },
    { name: "multiple trailing slashes are not collapsed", rootPath: "/workspace//", managedPath: "/workspace/plan.md", relativePath: "plan.md", matches: false },
    { name: "root case is significant", rootPath: "C:/Workspace", managedPath: "C:/workspace/plan.md", relativePath: "plan.md", matches: false },
    { name: "relative case is significant", rootPath: "/workspace", managedPath: "/workspace/Plan.md", relativePath: "plan.md", matches: false },
    { name: "relative backslashes stay literal", rootPath: "/workspace", managedPath: "/workspace/notes/plan.md", relativePath: "notes\\plan.md", matches: false },
    { name: "relative leading slash stays literal", rootPath: "/workspace", managedPath: "/workspace/plan.md", relativePath: "/plan.md", matches: false },
    { name: "literal leading slash can match doubled separator", rootPath: "/workspace", managedPath: "/workspace//plan.md", relativePath: "/plan.md", matches: true },
    { name: "relative dot is not resolved", rootPath: "/workspace", managedPath: "/workspace/plan.md", relativePath: "./plan.md", matches: false },
    { name: "literal dot path can match", rootPath: "/workspace", managedPath: "/workspace/./plan.md", relativePath: "./plan.md", matches: true },
    { name: "relative parent segment is not resolved", rootPath: "/workspace", managedPath: "/workspace/plan.md", relativePath: "notes/../plan.md", matches: false },
    { name: "literal parent segment can match", rootPath: "/workspace", managedPath: "/workspace/notes/../plan.md", relativePath: "notes/../plan.md", matches: true },
    { name: "aliases are not resolved", rootPath: "/workspace", managedPath: "/workspace/notes/plan.md", relativePath: "alias/plan.md", matches: false },
    { name: "directory boundary is exact", rootPath: "/workspace", managedPath: "/workspace-other/plan.md", relativePath: "plan.md", matches: false },
    { name: "filesystem root", rootPath: "/", managedPath: "/plan.md", relativePath: "plan.md", matches: true },
    { name: "empty root keeps joining slash", rootPath: "", managedPath: "/plan.md", relativePath: "plan.md", matches: true },
    { name: "empty relative path keeps joining slash", rootPath: "/workspace", managedPath: "/workspace/", relativePath: "", matches: true },
    { name: "empty relative path does not match bare root", rootPath: "/workspace", managedPath: "/workspace", relativePath: "", matches: false },
  ])("preserves matcher semantics: $name", ({ rootPath, managedPath, relativePath, matches }) => {
    const document = { id: 1, managedPath };
    const documents = [document];
    const index = indexProjectFiles({ rootPath, documents });
    expect(index.findByRelativePath(relativePath)).toBe(matches ? document : undefined);
    expect(index.findByRelativePath(relativePath)).toBe(
      documents.find(candidate => projectFilePathMatches(candidate.managedPath, rootPath, relativePath)),
    );
  });

  it("returns the first document when normalized paths collide", () => {
    const first = { id: 1, managedPath: "C:\\workspace\\plan.md" };
    const second = { id: 2, managedPath: "C:/workspace/plan.md" };
    const index = indexProjectFiles({ rootPath: "C:/workspace", documents: [first, second] });
    expect(index.findByRelativePath("plan.md")).toBe(first);
  });

  it("returns undefined for empty documents and unmatched paths", () => {
    const empty = indexProjectFiles({ rootPath: "/workspace", documents: [] });
    expect(empty.findByRelativePath("plan.md")).toBeUndefined();
    expect(empty.findByRelativePath("")).toBeUndefined();
    const index = indexProjectFiles({ rootPath: "/workspace", documents: [{ managedPath: "/workspace/plan.md" }] });
    expect(index.findByRelativePath("missing.md")).toBeUndefined();
  });

  it("reflects additions, renames and deletions in replacement document snapshots", () => {
    const original = { id: 1, managedPath: "/workspace/plan.md" };
    const added = { id: 2, managedPath: "/workspace/new.md" };
    const renamed = { ...original, managedPath: "/workspace/renamed.md" };
    const initial = indexProjectFiles({ rootPath: "/workspace", documents: [original] });
    const afterAdd = indexProjectFiles({ rootPath: "/workspace", documents: [original, added] });
    const afterRename = indexProjectFiles({ rootPath: "/workspace", documents: [renamed, added] });
    const afterDelete = indexProjectFiles({ rootPath: "/workspace", documents: [renamed] });
    expect(initial.findByRelativePath("plan.md")).toBe(original);
    expect(initial.findByRelativePath("new.md")).toBeUndefined();
    expect(afterAdd.findByRelativePath("new.md")).toBe(added);
    expect(afterRename.findByRelativePath("plan.md")).toBeUndefined();
    expect(afterRename.findByRelativePath("renamed.md")).toBe(renamed);
    expect(afterDelete.findByRelativePath("new.md")).toBeUndefined();
    expect(afterDelete.findByRelativePath("renamed.md")).toBe(renamed);
    expect(afterAdd.findByRelativePath("plan.md")).toBe(original);
    expect(afterAdd.findByRelativePath("new.md")).toBe(added);
  });

  it("uses the new root only in the replacement index", () => {
    const first = { id: 1, managedPath: "/workspace/a/plan.md" };
    const second = { id: 2, managedPath: "/workspace/b/plan.md" };
    const documents = Object.freeze([first, second]);
    const initial = indexProjectFiles({ rootPath: "/workspace/a", documents });
    const replacement = indexProjectFiles({ rootPath: "/workspace/b", documents });
    expect(initial.findByRelativePath("plan.md")).toBe(first);
    expect(replacement.findByRelativePath("plan.md")).toBe(second);
    expect(initial.findByRelativePath("plan.md")).toBe(first);
  });

  it("keeps captured paths and membership until explicitly rebuilt", () => {
    const original = { id: 1, managedPath: "/workspace/plan.md" };
    const added = { id: 2, managedPath: "/workspace/new.md" };
    const documents = [original];
    const index = indexProjectFiles({ rootPath: "/workspace", documents });
    original.managedPath = "/workspace/renamed.md";
    documents.splice(0, 1, added);
    expect(index.findByRelativePath("plan.md")).toBe(original);
    expect(index.findByRelativePath("renamed.md")).toBeUndefined();
    expect(index.findByRelativePath("new.md")).toBeUndefined();
    const replacement = indexProjectFiles({ rootPath: "/workspace", documents });
    expect(replacement.findByRelativePath("plan.md")).toBeUndefined();
    expect(replacement.findByRelativePath("new.md")).toBe(added);
  });

  it.each([1000, 2000, 5000])("reads %i document paths once during construction and never during lookups", size => {
    let reads = 0;
    const documents = Object.freeze(Array.from({ length: size }, (_, id) => ({
      id,
      get managedPath() {
        reads += 1;
        return `/workspace/notes/file-${id}.md`;
      },
    })));
    const index = indexProjectFiles({ rootPath: "/workspace", documents });
    expect(reads).toBe(size);
    for (let id = 0; id < size; id += 1) {
      expect(index.findByRelativePath(`notes/file-${id}.md`)).toBe(documents[id]);
    }
    expect(index.findByRelativePath("notes/missing.md")).toBeUndefined();
    expect(reads).toBe(size);
  });
});
