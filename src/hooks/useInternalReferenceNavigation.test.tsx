import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openFile: vi.fn(),
  resolveReference: vi.fn(),
  pushToast: vi.fn(),
  statusGet: vi.fn(),
  restore: vi.fn(),
  workspace: vi.fn(),
  openContent: vi.fn(),
  readBytes: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../services/desktopApi", () => ({
  desktopApi: {
    openFile: mocks.openFile,
  },
}));

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    internalReferenceResolve: mocks.resolveReference,
    workspaceStatusGet: mocks.workspace,
  },
}));

vi.mock("../state/feedback-store", () => ({
  useFeedbackStore: () => ({ pushToast: mocks.pushToast }),
}));
vi.mock("../services/agentApi", () => ({ agentApi: { statusGet: mocks.statusGet, operationRestoreCreated: mocks.restore } }));
vi.mock("../services/projectContentApi", () => ({ openProjectContent: mocks.openContent }));

vi.mock("../services/projectFileApi", () => ({ projectFileApi: { readBytes: mocks.readBytes } }));

import { useInternalReferenceNavigation } from "./useInternalReferenceNavigation";

describe("useInternalReferenceNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
    mocks.restore.mockResolvedValue({ restored: true });
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
    mocks.openContent.mockResolvedValue({ tabId: "file-51" });
  });

  it("opens document references through verified File identity in the Project content layout", async () => {
    mocks.resolveReference.mockResolvedValue({
      kind: "document",
      id: 51,
      label: "brief.pdf",
      projectId: 7,
      scope: "project",
      route: "/projects/7?focus=document-51",
      focusId: "document-51",
      managedPath: "/workspace/project/brief.pdf",
    });
    mocks.openFile.mockResolvedValue(undefined);
    const { result } = renderHook(() => useInternalReferenceNavigation());

    await expect(
      result.current({ refKind: "document", refId: 51, label: "brief.pdf" }),
    ).resolves.toBe(true);

    expect(mocks.openContent).toHaveBeenCalledWith({ workspaceRoot: "/workspace", projectId: 7,
      object: { kind: "file", id: 51, title: "brief.pdf" }, expectedBinding: { workspaceId: "w1", generation: "g1" } });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps an inaccessible File reference intact and reports refusal", async () => {
    mocks.resolveReference.mockResolvedValue({ kind: "document", id: 51, label: "brief.pdf", projectId: 7, scope: "project" });
    mocks.openContent.mockRejectedValueOnce(new Error("归属不符"));
    const { result } = renderHook(() => useInternalReferenceNavigation());
    await expect(result.current({ refKind: "document", refId: 51, label: "brief.pdf" })).resolves.toBe(false);
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "打开引用失败" }));
  });

  it("keeps navigating for non-document references", async () => {
    mocks.resolveReference.mockResolvedValue({
      kind: "todo",
      id: 18,
      label: "推进审批",
      projectId: 7,
      scope: "project",
      route: "/projects/7?focus=todo-18",
      focusId: "todo-18",
    });
    const { result } = renderHook(() => useInternalReferenceNavigation());

    await expect(
      result.current({ refKind: "todo", refId: 18, label: "推进审批" }),
    ).resolves.toBe(true);

    expect(mocks.navigate).toHaveBeenCalledWith("/projects/7?focus=todo-18");
    expect(mocks.openFile).not.toHaveBeenCalled();
  });
  it("navigates a Workspace Record through its typed resolver rather than guessing a Project route", async () => {
    mocks.resolveReference.mockResolvedValue({kind:"workspace_record",id:42,label:"个人方法",scope:"workspace",projectId:null,route:"/workspace/records/42"});
    const {result}=renderHook(()=>useInternalReferenceNavigation());
    await expect(result.current({refKind:"workspace_record",refId:42,label:"个人方法"})).resolves.toBe(true);
    expect(mocks.resolveReference).toHaveBeenCalledWith({kind:"workspace_record",id:42});
    expect(mocks.navigate).toHaveBeenCalledWith("/workspace/records/42");
    expect(mocks.openFile).not.toHaveBeenCalled();
  });

  it("navigates Workspace Todo references to the Workspace Rail", async () => {
    mocks.resolveReference.mockResolvedValue({
      kind: "todo",
      id: 19,
      label: "跨项目复盘",
      scope: "workspace",
      projectId: null,
      route: "/?focus=todo-19",
      focusId: "todo-19",
    });
    const { result } = renderHook(() => useInternalReferenceNavigation());

    await expect(
      result.current({ refKind: "todo", refId: 19, label: "跨项目复盘" }),
    ).resolves.toBe(true);

    expect(mocks.navigate).toHaveBeenCalledWith("/?focus=todo-19");
  });

  const withdrawn = JSON.stringify({ code: "OBJECT_WITHDRAWN", details: { objectKey: "w1/workspace/record/42", creationOperationId: "a".repeat(32), withdrawalRevision: 2, restoreAvailable: true } });
  it("offers recovery for a withdrawn native reference and resolves again before navigating", async () => {
    mocks.resolveReference.mockRejectedValueOnce(withdrawn).mockResolvedValue({ kind: "workspace_record", route: "/workspace/records/42" });
    const { result } = renderHook(() => useInternalReferenceNavigation());
    await expect(result.current({ refKind: "workspace_record", refId: 42, label: "成果" })).resolves.toBe(false);
    const toast = mocks.pushToast.mock.calls[0][0];
    expect(toast.title).toBe("引用记录已撤回");
    expect(toast.action.label).toBe("恢复并打开");
    toast.action.onClick();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/workspace/records/42"));
    expect(mocks.restore).toHaveBeenCalledWith({ workspaceId: "w1", generation: "g1" }, { creationOperationId: "a".repeat(32), expectedWithdrawalRevision: 2 });
    expect(mocks.resolveReference).toHaveBeenCalledTimes(2);
  });
  it("stops a recovery action after a binding change and reports restore failures", async () => {
    mocks.resolveReference.mockRejectedValue(withdrawn);
    const { result } = renderHook(() => useInternalReferenceNavigation());
    await result.current({ refKind: "workspace_record", refId: 42, label: "成果" });
    mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g2" } });
    mocks.pushToast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(mocks.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "恢复引用失败" })));
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("keeps the ordinary error message and makes no extra status calls for normal navigation", async () => {
    mocks.resolveReference.mockRejectedValue(new Error("ordinary failure"));
    const { result } = renderHook(() => useInternalReferenceNavigation());
    await result.current({ refKind: "note", refId: 42, label: "成果" });
    expect(mocks.pushToast).toHaveBeenCalledWith({ tone: "error", title: "打开引用失败", detail: "请稍后重试。" });
    expect(mocks.statusGet).not.toHaveBeenCalled();
  });
  it("reports a native restore failure and does not retry resolution or navigate", async () => {
    mocks.resolveReference.mockRejectedValue(withdrawn);
    mocks.restore.mockRejectedValueOnce(new Error("Undo conflict"));
    const { result } = renderHook(() => useInternalReferenceNavigation());
    await result.current({ refKind: "workspace_record", refId: 42, label: "成果" });
    mocks.pushToast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(mocks.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "恢复引用失败" })));
    expect(mocks.resolveReference).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

const sourceRef = { object: { workspaceId: "w1", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" },
  revision: `sha256:${"a".repeat(64)}`, fileVersion: 2, recordVersion: null, blockId: null,
  locator: { kind: "page" as const, page: 3, start: 1, end: 2 }, title: "旧名称.pdf", excerpt: "" };
it("opens fixed File evidence at the original version and page through the verified shared Tab service", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  mocks.openContent.mockResolvedValue({});
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "旧名称.pdf", sourceRef })).toBe(true);
  expect(mocks.readBytes).toHaveBeenCalledWith({ workspaceId: "w1", generation: "g1" }, {
    object: sourceRef.object, versionNumber: 2, expectedContentHash: sourceRef.revision });
  expect(mocks.openContent).toHaveBeenCalledWith({ workspaceRoot: "/workspace", projectId: 7,
    object: { kind: "file", id: 51, title: "旧名称.pdf" }, view: { versionNumber: 2, line: undefined, page: 3, sourceLocator: sourceRef.locator },
    expectedBinding: { workspaceId: "w1", generation: "g1" } });
  expect(mocks.resolveReference).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
});
it.each([
  [{ kind: "line", start: 8, end: 10 }, { line: 8 }],
  [{ kind: "paragraph", start: 2, end: 3 }, {}],
  [{ kind: "page", page: 2, start: 0, end: 19 }, { page: 2 }],
] as const)("opens verified fixed coordinates %j without inventing a paragraph line", async (locator, coordinates) => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  mocks.openContent.mockResolvedValue({});
  const { result } = renderHook(() => useInternalReferenceNavigation());
  const source = { ...sourceRef, locator };
  expect(await result.current({ refKind: "document", refId: 51, label: "File", sourceRef: source })).toBe(true);
  expect(mocks.openContent).toHaveBeenCalledWith(expect.objectContaining({
    view: { versionNumber: 2, line: undefined, page: undefined, ...coordinates, sourceLocator: locator },
    expectedBinding: { workspaceId: "w1", generation: "g1" },
  }));
  expect(mocks.resolveReference).not.toHaveBeenCalled();
});
it("clears every old coordinate when opening fixed evidence without a locator", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  const priorView = { versionNumber: 9, line: 40, page: 6, sourceLocator: sourceRef.locator };
  mocks.openContent.mockImplementationOnce(async ({ view }) => {
    const merged = { ...priorView, ...view };
    expect(merged).toEqual({ versionNumber: 2, line: undefined, page: undefined, sourceLocator: undefined });
    for (const key of ["line", "page", "sourceLocator"]) expect(Object.hasOwn(view, key)).toBe(true);
    return {};
  });
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "File", sourceRef: { ...sourceRef, locator: null } })).toBe(true);
  expect(mocks.openContent).toHaveBeenCalledTimes(1);
});
it("reports an unavailable snapshot without finding a same-name replacement or opening latest", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockRejectedValue(new Error("Retained File Version bytes are missing"));
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "旧名称.pdf", sourceRef })).toBe(false);
  expect(mocks.resolveReference).not.toHaveBeenCalled();
  expect(mocks.openContent).not.toHaveBeenCalled();
  expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "历史文件不可用", detail: "Retained File Version bytes are missing" }));
});
it("rejects fixed evidence from another Workspace before reading bytes", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "other", generation: "g1" } });
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "材料", sourceRef })).toBe(false);
  expect(mocks.readBytes).not.toHaveBeenCalled();
  expect(mocks.openContent).not.toHaveBeenCalled();
});

it("opens fixed Workspace File evidence at its original version in the shared Workspace tab", async () => {
  vi.clearAllMocks();
  const source = { ...sourceRef, object: { ...sourceRef.object, scope: { kind: "workspace" as const } } };
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  mocks.openContent.mockResolvedValue({});
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "Workspace依据", sourceRef: source })).toBe(true);
  expect(mocks.readBytes).toHaveBeenCalledWith({ workspaceId: "w1", generation: "g1" }, { object: source.object, versionNumber: 2, expectedContentHash: source.revision });
  expect(mocks.openContent).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, expectedBinding: { workspaceId: "w1", generation: "g1" }, view: expect.objectContaining({ versionNumber: 2, page: 3, sourceLocator: source.locator }) }));
  expect(mocks.resolveReference).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it("opens a current Workspace File link in the shared tab and never falls back to its local path", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.resolveReference.mockResolvedValue({ kind: "document", id: 51, projectId: null, scope: "workspace", label: "工作区材料", managedPath: "/workspace/files/plan.md" });
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  mocks.openContent.mockResolvedValue({});
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "工作区材料" })).toBe(true);
  expect(mocks.openContent).toHaveBeenCalledWith({ workspaceRoot: "/workspace", projectId: null, object: { kind: "file", id: 51, title: "工作区材料" }, expectedBinding: { workspaceId: "w1", generation: "g1" } });
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it("rejects an inconsistent resolved File owner instead of treating a Project File as Workspace File", async () => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.resolveReference.mockResolvedValue({ kind: "document", id: 51, projectId: null, scope: "project", label: "错误归属", managedPath: "/workspace/files/plan.md" });
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "错误归属" })).toBe(false);
  expect(mocks.openContent).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it("keeps unavailable Workspace fixed evidence fixed instead of opening the latest file", async () => {
  vi.clearAllMocks();
  const source = { ...sourceRef, object: { ...sourceRef.object, scope: { kind: "workspace" as const } } };
  mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
  mocks.readBytes.mockRejectedValueOnce(new Error("Historical snapshot is missing"));
  const { result } = renderHook(() => useInternalReferenceNavigation());
  expect(await result.current({ refKind: "document", refId: 51, label: "历史依据", sourceRef: source })).toBe(false);
  expect(mocks.openContent).not.toHaveBeenCalled();
  expect(mocks.resolveReference).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "历史文件不可用", detail: "Historical snapshot is missing" }));
});
