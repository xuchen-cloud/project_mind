import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openFile: vi.fn(),
  resolveReference: vi.fn(),
  pushToast: vi.fn(),
  statusGet: vi.fn(),
  restore: vi.fn(),
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
  },
}));

vi.mock("../state/feedback-store", () => ({
  useFeedbackStore: () => ({ pushToast: mocks.pushToast }),
}));
vi.mock("../services/agentApi", () => ({ agentApi: { statusGet: mocks.statusGet, operationRestoreCreated: mocks.restore } }));

import { useInternalReferenceNavigation } from "./useInternalReferenceNavigation";

describe("useInternalReferenceNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statusGet.mockResolvedValue({ binding: { workspaceId: "w1", generation: "g1" } });
    mocks.restore.mockResolvedValue({ restored: true });
  });

  it("opens document references with the system app without navigating", async () => {
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

    expect(mocks.openFile).toHaveBeenCalledWith("/workspace/project/brief.pdf");
    expect(mocks.navigate).not.toHaveBeenCalled();
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
