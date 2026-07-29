import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openFile: vi.fn(),
  resolveReference: vi.fn(),
  pushToast: vi.fn(),
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

import { useInternalReferenceNavigation } from "./useInternalReferenceNavigation";

describe("useInternalReferenceNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
