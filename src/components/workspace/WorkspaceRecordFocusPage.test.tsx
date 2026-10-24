import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NoteRecord,
  ProjectPageData,
  ProjectRecord,
  WorkspacePageData,
  WorkspaceRecord,
} from "../../lib/types";
import { requestWorkspaceRecordFocusSave } from "../../lib/record-focus-save";
import * as contentLifecycle from "../../lib/project-content-lifecycle";
import { prepareWorkspaceContentClose } from "../../lib/project-content-lifecycle";
import { desktopApi } from "../../services/desktopApi";
import { AgentApiError } from "../../services/agentApi";
import { queryKeys } from "../../lib/queryKeys";
import { RecordSaveFailure, RecordSaveCoordinator, type CommittedRecordSnapshot, type RecordSaveResult } from "../../lib/record-save-coordinator";
import { RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { RecordFocusResidentPages } from "../record/RecordFocusResidentPages";
import { WorkspaceRecordFocusPage } from "./WorkspaceRecordFocusPage";

vi.mock("../voice/VoiceRecordPanel", () => ({
  VoiceRecordPanel: ({ onMinutesCommitted }: { onMinutesCommitted?: () => void }) =>
    <button onClick={() => onMinutesCommitted?.()}>测试纪要已提交</button>,
}));

import { fixtureDocument, fixtureEditorState, fixtureBodySave } from "../../test/recordDocumentFixture";
import type { RecordBodySaveInput, RecordTarget } from "../../lib/record-document-types";
const recordMocks = vi.hoisted(() => ({
  queryClient: null as QueryClient | null,
  confirm: vi.fn(), pendingReviewCount: 0, busy: false,
  saveProjectRecord: vi.fn(), saveWorkspaceRecord: vi.fn(), bodySave: vi.fn(), editorGet: vi.fn(), metadataGet: vi.fn(), metadataApply: vi.fn(),
  sourceReveal: vi.fn((_blockId: string) => true),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, QueryClientProvider: (props: React.ComponentProps<typeof original.QueryClientProvider>) => {
    recordMocks.queryClient = props.client;
    return <original.QueryClientProvider {...props} />;
  } };
});
vi.mock("../../services/agentApi", async (importOriginal) => ({ ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: { statusGet: async () => ({ binding: { workspaceId: "fixture-workspace", generation: "open-1" } }) } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: {
  editorGet: recordMocks.editorGet, bodySave: recordMocks.bodySave, metadataGet: recordMocks.metadataGet, metadataApply: recordMocks.metadataApply, checkpoint: vi.fn(),
  editorRegister: vi.fn(async () => null), editorUnregister: vi.fn(async () => null), editorFlushReply: vi.fn(async () => null),
} }));

const apiMocks = vi.hoisted(() => ({
  workspacePageGet: vi.fn(),
  projectsList: vi.fn(),
  workspaceStatusGet: vi.fn(),
  projectTagSettingsGet: vi.fn(),
  projectTagUpsert: vi.fn(),
  workspaceRecordUpsert: vi.fn(),
  aiSettingsGet: vi.fn(),
  projectPageGet: vi.fn(),
  projectRecordUpsert: vi.fn(),
}));

const aiMetadataMocks = vi.hoisted(() => ({
  enqueueAndWait: vi.fn(),
}));

vi.mock("../../lib/aiJobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/aiJobs")>()),
  enqueueAndWait: aiMetadataMocks.enqueueAndWait,
}));

const recordExportMocks = vi.hoisted(() => ({
  sources: [] as Array<{ committedHtml: string; recordKind: string }>,
  editorValue: "正文 A[AI preview]",
  committedValue: "正文 A",
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../features/record-export/desktopRecordExportPlatform", () => ({
  createDesktopRecordExporter: (saveCommittedContent: () => Promise<{ committedHtml: string; recordKind: string }>) =>
    async () => {
      recordExportMocks.sources.push(await saveCommittedContent());
      return { kind: "success", path: "/tmp/export.pdf", warnings: [], fontSubstituted: false };
    },
}));

vi.mock("../../features/record-export/RecordExportAction", () => ({
  RecordExportAction: ({ exportTo }: { exportTo: (request: object) => Promise<unknown> }) => (
    <button type="button" onClick={() => void exportTo({ format: "pdf", targetPath: "/tmp/export.pdf" })}>
      测试导出
    </button>
  ),
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    confirm: recordMocks.confirm,
    listenEvent: vi.fn(async () => () => undefined),
    focusProjectWindow: vi.fn(async () => false),
    openProjectWindow: vi.fn(async () => undefined),
  },
}));

vi.mock("../../hooks/useContactMentionOptions", () => ({
  useContactMentionOptions: () => ({}),
}));

vi.mock("../../hooks/useInternalReferenceNavigation", () => ({
  useInternalReferenceNavigation: () => vi.fn(),
}));

vi.mock("../../hooks/useProjectMutations", () => ({
  useProjectMutations: () => ({
    createProjectMutation: { isPending: false, mutateAsync: vi.fn(async () => undefined) },
    archiveMutation: { mutate: vi.fn() },
    deleteProjectMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../../state/ui-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../state/ui-store")>(),
  useUiStore: () => ({
    openSettings: vi.fn(),
    pageWidthMode: "adaptive",
    projectRecentPaths: {},
    openProjectIds: [],
    closeProjectTab: vi.fn(),
    projectSidebarCollapsed: false,
  }),
}));

vi.mock("../../todo", () => ({
  TodoModuleRail: ({ enabled }: { enabled?: boolean }) => (
    <div data-testid="todo-module-rail" data-enabled={enabled === false ? "false" : "true"} />
  ),
}));

vi.mock("../home/HomeNoteSidebar", () => ({
  HomeNoteSidebar: ({ onOpenRecord }: { onOpenRecord: (recordId: number) => void }) => (
    <button type="button" onClick={() => onOpenRecord(8)}>
      Open record 8
    </button>
  ),
}));

vi.mock("../record/RecordConflictActions", () => ({
  RecordConflictActions: ({ onReload }: { onReload: () => void }) =>
    <button onClick={onReload}>测试重载冲突</button>,
}));

vi.mock("../rich-editor/noteImageAssets", () => ({
  buildWorkspaceNoteImageAssetHandlers: () => undefined,
  buildProjectNoteImageAssetHandlers: () => undefined,
  externalizeEmbeddedImageDataUrls: vi.fn(async (value) => value),
  materializeEmbeddedRecordImages: vi.fn(),
}));

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichEditor: ({
    html,
    controllerRef,
    sourceBlockNavigation,
    onSourceBlockResult,
    onDefaultCodeLanguageChange,
  }: {
    html?: string;
    onDefaultCodeLanguageChange?: (value: string | null) => void;
    sourceBlockNavigation?: { blockId: string; key: string } | null;
    onSourceBlockResult?: (located: boolean) => void;
    controllerRef?: {
      current: {
        acknowledgeCommittedContent: () => void;
        applyIncomingContent: (html: string) => boolean;
        isBusy: () => boolean;
        getPendingAiReviewCount: () => number;
        getValue: () => { html: string; text: string; markdown: string };
        getCommittedValue: () => { html: string; text: string; markdown: string };
        getCommittedDocumentJson: () => ReturnType<typeof fixtureDocument>;
        focus: () => void;
        save: () => Promise<unknown>;
      } | null;
    };
  }) => {
    const [value] = useState(toPlainText(html ?? ""));
    const valueRef = useRef(value);
    valueRef.current = value;
    useEffect(() => {
      if (sourceBlockNavigation) onSourceBlockResult?.(recordMocks.sourceReveal(sourceBlockNavigation.blockId));
    }, [sourceBlockNavigation?.key, onSourceBlockResult]);

    useEffect(() => {
      if (!controllerRef) return;

      controllerRef.current = {
        acknowledgeCommittedContent: vi.fn(),
        applyIncomingContent: () => !recordMocks.busy && !recordMocks.pendingReviewCount
          && recordExportMocks.committedValue === toPlainText(html ?? "") && !recordExportMocks.editorValue.includes("[AI preview]"),
        isBusy: () => recordMocks.busy,
        getPendingAiReviewCount: () => recordMocks.pendingReviewCount,
        getValue: () => buildMockRichValue(recordExportMocks.editorValue),
        getCommittedValue: () => buildMockRichValue(recordExportMocks.committedValue),
        getCommittedDocumentJson: () => fixtureDocument(recordExportMocks.committedValue),
        focus: vi.fn(),
        save: vi.fn(),
      };

      return () => {
        controllerRef.current = null;
      };
    }, [controllerRef]);

    return <><textarea aria-label="正文编辑器" value={value} readOnly />
      <button onClick={() => onDefaultCodeLanguageChange?.("rust")}>测试切换代码语言</button></>;
  },
}));

const noteA: WorkspaceRecord = {
  id: 7,
  title: "A",
  contentMarkdown: "正文 A",
  contentHtml: "<p>正文 A</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

const noteB: WorkspaceRecord = {
  id: 8,
  title: "B",
  contentMarkdown: "正文 B",
  contentHtml: "<p>正文 B</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

const noteC: WorkspaceRecord = {
  id: 9,
  title: "C",
  contentMarkdown: "正文 C",
  contentHtml: "<p>正文 C</p>",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}{location.search}</div>;
}

function renderPage(ui: ReactElement, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }), initialEntry = "/workspace/records/7") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/workspace/records/:noteId" element={ui} />
          <Route path="*" element={null} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function ResidentWorkspaceFocusHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/workspace/records/7")}>打开 Workspace 记录 A</button>
      <button type="button" onClick={() => navigate("/workspace/records/8")}>打开 Workspace 记录 B</button>
      <button type="button" onClick={() => navigate("/workspace/records/9")}>打开 Workspace 记录 C</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function CrossScopeFocusHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/workspace/records/7")}>打开 Workspace Focus</button>
      <button type="button" onClick={() => navigate("/projects/1/records/70")}>打开 Project Focus</button>
      <RecordFocusResidentPages workspaceKey="/tmp/workspace" />
    </>
  );
}

function buildWorkspacePage(): WorkspacePageData {
  return {
    quickNote: null,
    records: [noteA, noteB, noteC],
    unfinishedTodos: [],
    finishedTodos: [],
  };
}

function buildMockRichValue(value: string) {
  return {
    html: `<p>${value}</p>`,
    text: value,
    markdown: value,
  };
}

function toPlainText(html: string) {
  return html.replace(/<[^>]+>/gu, "");
}

describe("WorkspaceRecordFocusPage record switching", () => {
  beforeEach(() => {
    vi.mocked(desktopApi.listenEvent).mockClear();
    recordMocks.queryClient = null;
    recordMocks.confirm.mockReset().mockResolvedValue(true);
    recordMocks.pendingReviewCount = 0;
    recordMocks.busy = false;
    recordMocks.bodySave.mockReset();
    recordMocks.sourceReveal.mockReset().mockReturnValue(true);
    recordMocks.editorGet.mockReset();
    const findRecord = async (target: RecordTarget) => {
      if (target.scope.kind === "project") {
        const page = recordMocks.queryClient?.getQueryData<ProjectPageData>(queryKeys.projectPage(target.scope.projectId));
        return page?.records.find((record) => record.id === target.recordId) ?? { ...noteA, id: target.recordId };
      }
      const cached = recordMocks.queryClient?.getQueryData<WorkspacePageData>(queryKeys.workspacePage);
      const page = cached ?? await apiMocks.workspacePageGet.getMockImplementation()?.();
      return page?.records.find((record: WorkspaceRecord) => record.id === target.recordId) ?? noteA;
    };
    recordMocks.editorGet.mockImplementation(async (_binding, target: RecordTarget) => fixtureEditorState(target, await findRecord(target)));
    recordMocks.bodySave.mockImplementation(async (_binding, input: RecordBodySaveInput) => fixtureBodySave(input, await findRecord(input.target), input.target.scope.kind === "project" ? recordMocks.saveProjectRecord : recordMocks.saveWorkspaceRecord));
    recordExportMocks.sources.length = 0;
    recordExportMocks.editorValue = "正文 A[AI preview]";
    recordExportMocks.committedValue = "正文 A";
    apiMocks.workspacePageGet.mockReset();
    apiMocks.projectsList.mockReset();
    apiMocks.workspaceStatusGet.mockReset();
    apiMocks.projectTagSettingsGet.mockReset();
    apiMocks.projectTagUpsert.mockReset();
    recordMocks.saveWorkspaceRecord.mockReset();
    recordMocks.metadataGet.mockReset();
    recordMocks.metadataApply.mockReset();
    recordMocks.metadataGet.mockImplementation(async (_binding,target) => (await recordMocks.editorGet(_binding,target)).metadata);
    apiMocks.aiSettingsGet.mockReset();
    apiMocks.projectPageGet.mockReset();
    recordMocks.saveProjectRecord.mockReset();
    aiMetadataMocks.enqueueAndWait.mockReset();

    apiMocks.workspacePageGet.mockResolvedValue(buildWorkspacePage());
    apiMocks.projectsList.mockResolvedValue([]);
    apiMocks.workspaceStatusGet.mockResolvedValue({
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    apiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.aiSettingsGet.mockResolvedValue(null);
    recordMocks.saveProjectRecord.mockResolvedValue({});
    apiMocks.projectTagUpsert.mockImplementation(async ({ label }: { label: string }) => ({
      id: 22,
      label,
      colorKey: "blue",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    }));
    recordMocks.saveWorkspaceRecord.mockImplementation(async (input: Partial<WorkspaceRecord>) => ({
      ...(input.noteId === 8 ? noteB : noteA),
      title: input.title,
      contentMarkdown: input.markdown ?? "",
      contentHtml: input.html ?? "",
    }));
    recordMocks.metadataApply.mockImplementation(async (_binding,input) => {
      const record = { ...noteA, title: input.metadata.title, tags: [
        ...input.metadata.tagIds.map((id: number) => ({ id,label: `Tag ${id}`,colorKey: "blue" as const })),
        ...input.newTags.map((tag: { label: string },index: number) => ({ id: 30 + index,label: tag.label,colorKey: "teal" as const })),
      ] };
      return { metadata: { title: record.title,tagIds: record.tags.map((tag) => tag.id),revision: "metadata-ai",updatedAt: "now" },tags: record.tags };
    });
  });

  it("refreshes a committed voice title and its canonical metadata without saving it again", async () => {
    apiMocks.workspacePageGet.mockResolvedValue({ ...buildWorkspacePage(), records: [{ ...noteA, isVoice: true }] });
    recordExportMocks.editorValue = recordExportMocks.committedValue;
    const persist = vi.fn(async () => ({ updatedAt: "saved", headRevision: 2 }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    const view = renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    const incoming = fixtureEditorState({ scope: { kind: "workspace" }, recordId: 7 }, { ...noteA, title: "纪要标题" });
    incoming.metadata.revision = "minutes-metadata";
    recordMocks.editorGet.mockResolvedValue(incoming);
    fireEvent.click(screen.getByText("测试纪要已提交"));
    await waitFor(() => expect(recordMocks.editorGet).toHaveBeenCalledTimes(2));
    expect(screen.getByPlaceholderText("记录标题")).toHaveValue("纪要标题");
    expect(screen.queryByText("测试重载冲突")).not.toBeInTheDocument();
    expect(persist).not.toHaveBeenCalled();
    act(() => { requestWorkspaceRecordFocusSave({ recordId: 7 }); });
    expect(coordinator.getLatestSnapshot("workspace:7")?.canonicalBody?.metadataBase).toEqual(incoming.metadata);
    await act(async () => { await coordinator.flush(); });
    view.unmount();
  });

  it.each(["body", "title"])("preserves an unsaved %s draft when voice minutes commit metadata", async (field) => {
    apiMocks.workspacePageGet.mockResolvedValue({ ...buildWorkspacePage(), records: [{ ...noteA, isVoice: true }] });
    recordExportMocks.editorValue = recordExportMocks.committedValue;
    const persist = vi.fn(async () => ({ updatedAt: "saved", headRevision: 2 }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    const view = renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    if (field === "body") recordExportMocks.editorValue = recordExportMocks.committedValue = "用户未保存正文";
    else fireEvent.change(screen.getByPlaceholderText("记录标题"), { target: { value: "用户未保存标题" } });
    const incoming = fixtureEditorState({ scope: { kind: "workspace" }, recordId: 7 }, { ...noteA, title: "纪要标题" });
    incoming.metadata.revision = "minutes-metadata";
    recordMocks.editorGet.mockResolvedValue(incoming);
    fireEvent.click(screen.getByText("测试纪要已提交"));
    expect(await screen.findByText("测试重载冲突")).toBeInTheDocument();
    if (field === "body") expect(recordExportMocks.committedValue).toBe("用户未保存正文");
    else expect(screen.getByPlaceholderText("记录标题")).toHaveValue("用户未保存标题");
    expect(persist).not.toHaveBeenCalled();
    view.unmount();
  });

  async function renderDeletedRecord() {
    const persist = vi.fn(async () => { throw new RecordSaveFailure("record deleted", { code: "NOT_FOUND", retryable: false }); });
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    const view = renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    recordMocks.editorGet.mockRejectedValue(new AgentApiError({ code: "NOT_FOUND", message: "record deleted", retryable: false }));
    return { view, coordinator, persist };
  }

  it("confirms a deleted record, clears its queue, and does not resubmit on navigation or unmount", async () => {
    const { view, coordinator, persist } = await renderDeletedRecord();
    const submit = vi.spyOn(coordinator, "submit");
    await act(async () => { await prepareWorkspaceContentClose("/tmp/workspace"); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
    submit.mockClear();
    expect(requestWorkspaceRecordFocusSave({ recordId: 7 })).toBe("not_needed");
    view.unmount();
    expect(submit).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    await prepareWorkspaceContentClose("/tmp/workspace");
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
  });

  it("retains the draft when deleted-record close is cancelled", async () => {
    const { coordinator } = await renderDeletedRecord();
    recordMocks.confirm.mockResolvedValue(false);
    await act(async () => { await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toThrow(); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSnapshot("workspace:7")).not.toBeNull();
    expect(screen.getByPlaceholderText("记录标题")).toHaveValue("A");
  });

  it.each(["title", "document", "language"])("requires another confirmation after a new %s edit", async (field) => {
    const { coordinator } = await renderDeletedRecord();
    await act(async () => { await prepareWorkspaceContentClose("/tmp/workspace"); });
    if (field === "title") fireEvent.change(screen.getByPlaceholderText("记录标题"), { target: { value: "new title" } });
    else if (field === "document") recordExportMocks.committedValue = "new body";
    else fireEvent.click(screen.getByText("测试切换代码语言"));
    recordMocks.confirm.mockResolvedValue(false);
    await act(async () => { await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toThrow(); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(2);
    expect(coordinator.getLatestSnapshot("workspace:7")).not.toBeNull();
  });

  it("rejects discard if the draft changes while confirmation is open", async () => {
    const { coordinator } = await renderDeletedRecord();
    recordMocks.confirm.mockImplementation(async () => {
      fireEvent.change(screen.getByPlaceholderText("记录标题"), { target: { value: "edited during confirm" } });
      return true;
    });
    await act(async () => { await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toThrow(); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSnapshot("workspace:7")).not.toBeNull();
  });

  it("prioritizes a typed missing save failure over a generic synchronization error", async () => {
    const { coordinator } = await renderDeletedRecord();
    act(() => { expect(requestWorkspaceRecordFocusSave({ recordId: 7 })).toBe("submitted"); });
    await expect(coordinator.flush("workspace:7")).rejects.toMatchObject({ code: "NOT_FOUND" });
    recordMocks.editorGet.mockRejectedValueOnce(new Error("sync connection failed"));
    const listener = vi.mocked(desktopApi.listenEvent).mock.calls.find(([event]) => event === "record:head-changed")?.[1];
    expect(listener).toBeDefined();
    await act(async () => {
      listener?.({ binding: { workspaceId: "fixture-workspace", generation: "open-1" },
        target: { scope: { kind: "workspace" }, recordId: 7 }, requestId: "external", headRevision: 20, metadataRevision: null });
    });
    expect(await screen.findByText("同步记录失败，当前草稿已保留。请检查工作区连接。")).toBeInTheDocument();
    await act(async () => { await prepareWorkspaceContentClose("/tmp/workspace"); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
  });

  it.each(["busy", "pending AI"])("blocks close before submitting while the editor has %s", async (state) => {
    const { coordinator, persist } = await renderDeletedRecord();
    if (state === "busy") recordMocks.busy = true;
    else recordMocks.pendingReviewCount = 1;
    await act(async () => { await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toThrow(); });
    expect(persist).not.toHaveBeenCalled();
    expect(recordMocks.confirm).not.toHaveBeenCalled();
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
  });

  it("flushes only the current record and keeps another record's failed draft", async () => {
    const persist = vi.fn(async (snapshot: Readonly<CommittedRecordSnapshot>) => {
      if (snapshot.recordId === 8) throw new Error("other record failed");
      return { updatedAt: "now", headRevision: snapshot.canonicalBody!.baseRevision + 1 };
    });
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    coordinator.submit({ scope: "workspace", workspaceKey: "/tmp/workspace", recordId: 8, title: "other",
      tagIds: [], defaultCodeLanguage: null, committedContent: buildMockRichValue("other") });
    await expect(coordinator.flush("workspace:8")).rejects.toThrow("other record failed");
    const other = coordinator.getLatestSnapshot("workspace:8");
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    const flush = vi.spyOn(coordinator, "flush");
    await act(async () => { await prepareWorkspaceContentClose("/tmp/workspace"); });
    expect(flush).toHaveBeenCalledExactlyOnceWith("workspace:7");
    expect(coordinator.getLatestSnapshot("workspace:8")).toBe(other);
    expect(recordMocks.confirm).not.toHaveBeenCalled();
  });

  it("preserves a real save error without offering to discard", async () => {
    const failure = new Error("disk unavailable");
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist: async () => { throw failure; } } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    await act(async () => { await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toBe(failure); });
    expect(coordinator.getLatestSnapshot("workspace:7")).not.toBeNull();
    expect(recordMocks.confirm).not.toHaveBeenCalled();
  });

  it("rejects close if the document changes during persistence", async () => {
    let finishSave!: () => void;
    const persist = vi.fn((snapshot: Readonly<CommittedRecordSnapshot>) => new Promise<RecordSaveResult>((resolve) => {
      finishSave = () => resolve({ updatedAt: "now", headRevision: snapshot.canonicalBody!.baseRevision + 1 });
    }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    await act(async () => {
      const close = prepareWorkspaceContentClose("/tmp/workspace");
      const rejected = expect(close).rejects.toThrow("记录仍在编辑");
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      recordExportMocks.committedValue = "edited during save";
      finishSave();
      await rejected;
    });
    expect(recordMocks.confirm).not.toHaveBeenCalled();
  });

  async function notifyWorkspaceRecordChanged() {
    const listener = vi.mocked(desktopApi.listenEvent).mock.calls.find(([event]) => event === "record:head-changed")?.[1];
    expect(listener).toBeDefined();
    await act(async () => {
      listener?.({ binding: { workspaceId: "fixture-workspace", generation: "open-1" },
        target: { scope: { kind: "workspace" }, recordId: 7 }, requestId: "external", headRevision: 20, metadataRevision: null });
    });
  }

  it("navigation save fails while a loaded draft is still waiting for canonical initialization", async () => {
    recordMocks.editorGet.mockImplementation(() => new Promise(() => {}));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist: vi.fn() } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await screen.findByLabelText("正文编辑器");
    await waitFor(() => expect(recordMocks.editorGet).toHaveBeenCalled());
    expect(requestWorkspaceRecordFocusSave({ recordId: 7 })).toBe("failed");
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
  });

  it("allows close after initial canonical load failure without an editable draft or pending snapshot", async () => {
    recordMocks.editorGet.mockRejectedValue(new Error("initial load failed"));
    const persist = vi.fn();
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await screen.findByText(/initial load failed/);
    expect(requestWorkspaceRecordFocusSave({ recordId: 7 })).toBe("not_needed");
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
    await expect(prepareWorkspaceContentClose("/tmp/workspace")).resolves.toBeUndefined();
    expect(recordMocks.confirm).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("uses the pending snapshot binding when initial canonical load fails for a deleted record", async () => {
    const failure = new RecordSaveFailure("record deleted", { code: "NOT_FOUND", retryable: false });
    recordMocks.editorGet.mockRejectedValue(new AgentApiError({ code: "NOT_FOUND", message: "initial deleted", retryable: false }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist: async () => { throw failure; } } });
    coordinator.submit({ scope: "workspace", workspaceKey: "/tmp/workspace", recordId: 7, title: "pending draft",
      tagIds: [], defaultCodeLanguage: null, committedContent: buildMockRichValue("pending"),
      canonicalBody: { binding: { workspaceId: "fixture-workspace", generation: "open-1" }, requestId: "pending",
        baseRevision: 1, document: fixtureDocument("pending"), editSessionId: "session", origin: "manual" } });
    await expect(coordinator.flush("workspace:7")).rejects.toBe(failure);
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await screen.findByText(/initial deleted/);
    expect(requestWorkspaceRecordFocusSave({ recordId: 7 })).toBe("failed");
    expect(coordinator.getLatestSnapshot("workspace:7")).not.toBeNull();
    await act(async () => { await prepareWorkspaceContentClose("/tmp/workspace"); });
    expect(recordMocks.confirm).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
  });

  it("blocks normal close with an incoming conflict before submitting", async () => {
    const persist = vi.fn(async () => ({ updatedAt: "now", headRevision: 2 }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText("记录标题"), { target: { value: "local draft" } });
    recordMocks.editorGet.mockResolvedValueOnce(fixtureEditorState({ scope: { kind: "workspace" }, recordId: 7 }, noteA, 20));
    await notifyWorkspaceRecordChanged();
    await screen.findByText("测试重载冲突");
    await expect(prepareWorkspaceContentClose("/tmp/workspace")).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
    expect(recordMocks.confirm).not.toHaveBeenCalled();
  });

  it.each(["incoming conflict", "sync error", "resolving conflict"])("checks latest %s after persistence", async (state) => {
    const register = vi.spyOn(contentLifecycle, "registerWorkspaceRecordCloseGuard");
    const persist = vi.fn(async (snapshot: Readonly<CommittedRecordSnapshot>) =>
      ({ updatedAt: "now", headRevision: snapshot.canonicalBody!.baseRevision + 1 }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><WorkspaceRecordFocusPage /></RecordSaveCoordinatorProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText("记录标题"), { target: { value: "local title" } });
    let finishIo!: () => void;
    const io = new Promise<void>((resolve) => { finishIo = resolve; });
    const originalFlush = coordinator.flush.bind(coordinator);
    const flush = vi.spyOn(coordinator, "flush").mockImplementation(async (key) => {
      await originalFlush(key);
      await io;
    });
    const prepare = register.mock.lastCall![0].prepare;
    let close!: Promise<void>;
    await act(async () => { close = prepare(); });
    const rejected = expect(close).rejects.toThrow();
    await vi.waitFor(() => expect(coordinator.getRecordStatus("workspace:7").phase).toBe("idle"));
    if (state === "sync error") recordMocks.editorGet.mockRejectedValueOnce(new Error("sync failed during save"));
    else recordMocks.editorGet.mockResolvedValueOnce(fixtureEditorState({ scope: { kind: "workspace" }, recordId: 7 }, noteA, 20));
    await notifyWorkspaceRecordChanged();
    if (state === "resolving conflict") {
      recordMocks.editorGet.mockImplementation(() => new Promise(() => {}));
      fireEvent.click(await screen.findByText("测试重载冲突"));
      await waitFor(() => expect(screen.queryByText("测试重载冲突")).not.toBeInTheDocument());
    }
    await act(async () => { finishIo(); await rejected; });
    expect(recordMocks.confirm).not.toHaveBeenCalled();
    flush.mockRestore();
    register.mockRestore();
  });

  it("source navigation shows a missing block status without writing the record", async () => {
    recordMocks.sourceReveal.mockReturnValue(false);
    const id = "a".repeat(32);
    const view = renderPage(<WorkspaceRecordFocusPage />, undefined, `/workspace/records/7?sourceBlock=${id}&sourceRevision=1`);
    expect(await screen.findByText("引用段落已删除或变更，无法定位来源。")).toBeInTheDocument();
    expect(recordMocks.sourceReveal).toHaveBeenCalledWith(id);
    expect(recordMocks.bodySave).not.toHaveBeenCalled();
    view.unmount();
  });

  it("source navigation follows a second query on the same workspace record", async () => {
    const first = "a".repeat(32); const second = "b".repeat(32);
    function SourceHarness() {
      const navigate = useNavigate();
      return <><button onClick={() => navigate(`/workspace/records/7?sourceBlock=${second}&sourceRevision=1`)}>打开第二个来源块</button>
        <WorkspaceRecordFocusPage /></>;
    }
    const view = renderPage(<SourceHarness />, undefined, `/workspace/records/7?sourceBlock=${first}&sourceRevision=1`);
    await waitFor(() => expect(recordMocks.sourceReveal).toHaveBeenCalledWith(first));
    fireEvent.click(screen.getByText("打开第二个来源块"));
    await waitFor(() => expect(recordMocks.sourceReveal).toHaveBeenLastCalledWith(second));
    expect(screen.getByRole("textbox", { name: "正文编辑器" })).toHaveValue("正文 A");
    view.unmount();
  });

  it.each([
    ["missing", "/workspace/records/7", "记录未找到", "/workspace", "返回工作区"],
    ["invalid", "/workspace/records/invalid", "无效的记录ID", "/workspace", "返回工作区"],
    ["failed", "/workspace/records/7", "记录加载失败，请重试", "/workspace", "返回工作区"],
  ])("error page returns with filters and without a missing focus anchor: %s %s", async (state, route, message, target, label) => {
    if (state === "missing") apiMocks.workspacePageGet.mockResolvedValue({ ...buildWorkspacePage(), records: [] });
    if (state === "failed") apiMocks.workspacePageGet.mockRejectedValue(new Error("load failed"));
    renderPage(<WorkspaceRecordFocusPage />, undefined, `${route}?recordQuery=needle&recordTag=12&focus=record-7`);
    const user = userEvent.setup();

    expect(await screen.findByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: label }));

    const location = screen.getByTestId("location-display").textContent ?? "";
    const [pathname, search] = location.split("?");
    expect(pathname).toBe(target);
    const params = new URLSearchParams(search);
    expect(params.get("recordQuery")).toBe("needle");
    expect(params.get("recordTag")).toBe("12");
    expect(params.has("focus")).toBe(false);
  });

  it("error page retries a failed record load", async () => {
    apiMocks.workspacePageGet.mockRejectedValueOnce(new Error("load failed"));
    renderPage(<WorkspaceRecordFocusPage />);
    const user = userEvent.setup();

    expect(await screen.findByText("记录加载失败，请重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByLabelText("正文编辑器")).toBeInTheDocument();
    expect(apiMocks.workspacePageGet).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "failed", "loading"] as const)(
    "navigation save is not_needed without a draft when %s",
    async (state) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (state === "missing") {
        apiMocks.workspacePageGet.mockResolvedValue({ ...buildWorkspacePage(), records: [] });
      } else if (state === "failed") {
        apiMocks.workspacePageGet.mockRejectedValue(new Error("load failed"));
      } else {
        apiMocks.workspacePageGet.mockImplementation(() => new Promise(() => {}));
      }
      const persist = vi.fn(async () => ({}));
      const coordinator = new RecordSaveCoordinator({
        workspaceKey: "/tmp/workspace",
        adapter: { persist },
      });
      renderPage(
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <WorkspaceRecordFocusPage />
        </RecordSaveCoordinatorProvider>,
        queryClient,
      );
      if (state !== "loading") {
        await waitFor(() => expect(queryClient.getQueryState(queryKeys.workspacePage)?.status)
          .toBe(state === "failed" ? "error" : "success"));
      }

      await expect(prepareWorkspaceContentClose("/tmp/workspace")).resolves.toBeUndefined();
      expect(recordMocks.confirm).not.toHaveBeenCalled();
      let result;
      act(() => { result = requestWorkspaceRecordFocusSave({ recordId: 7 }); });

      expect(result).toBe("not_needed");
      expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
      expect(coordinator.getStatus().pendingCount).toBe(0);
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("navigation save submits a loaded draft and retains a real persistence failure", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("save failed"); }) },
    });
    renderPage(
      <RecordSaveCoordinatorProvider coordinator={coordinator}>
        <WorkspaceRecordFocusPage />
      </RecordSaveCoordinatorProvider>,
      queryClient,
    );

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).not.toBeDisabled());
    let result;
    act(() => { result = requestWorkspaceRecordFocusSave({ recordId: 7 }); });
    expect(result).toBe("submitted");
    await act(async () => {
      await expect(coordinator.flush()).rejects.toThrow("save failed");
    });
    expect(coordinator.getRecordStatus("workspace:7")).toMatchObject({ phase: "error", failedCount: 1 });
    expect(coordinator.getLatestSnapshot("workspace:7")).toMatchObject({
      title: "A",
      committedContent: { markdown: "正文 A" },
    });
    expect(screen.getByLabelText("正文编辑器")).toHaveValue("正文 A");
  });

  it("navigation save follows resident visibility changes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    function VisibilityHarness() {
      const [visible, setVisible] = useState(true);
      return <>
        <button type="button" onClick={() => setVisible((value) => !value)}>切换可见性</button>
        <WorkspaceRecordFocusPage visible={visible} />
      </>;
    }
    const persist = vi.fn(async (snapshot) => ({ headRevision: snapshot.canonicalBody.baseRevision + 1 }));
    const coordinator = new RecordSaveCoordinator({ workspaceKey: "/tmp/workspace", adapter: { persist } });
    renderPage(<RecordSaveCoordinatorProvider coordinator={coordinator}><VisibilityHarness /></RecordSaveCoordinatorProvider>, queryClient);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "切换可见性" }));
    await coordinator.flush();
    const hiddenSaveCount = persist.mock.calls.length;
    let result;
    act(() => { result = requestWorkspaceRecordFocusSave({ recordId: 7 }); });
    expect(result).toBe("unhandled");
    expect(persist).toHaveBeenCalledTimes(hiddenSaveCount);

    await user.click(screen.getByRole("button", { name: "切换可见性" }));
    act(() => { result = requestWorkspaceRecordFocusSave({ recordId: 7 }); });
    expect(result).toBe("submitted");
    await coordinator.flush();
    expect(persist).toHaveBeenCalledTimes(hiddenSaveCount + 1);
  });

  it.each([false, true])("hidden resident navigation save is unhandled with draft=%s", (hasDraft) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (hasDraft) queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    const persist = vi.fn(async () => ({}));
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist },
    });
    renderPage(
      <RecordSaveCoordinatorProvider coordinator={coordinator}>
        <WorkspaceRecordFocusPage visible={false} />
      </RecordSaveCoordinatorProvider>,
      queryClient,
    );

    let result;
    act(() => { result = requestWorkspaceRecordFocusSave({ recordId: 7 }); });

    expect(result).toBe("unhandled");
    expect(coordinator.getLatestSnapshot("workspace:7")).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("hands a cold record from one static skeleton to ready content", async () => {
    vi.useFakeTimers();
    let resolvePage!: (value: WorkspacePageData) => void;
    apiMocks.workspacePageGet.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const view = renderPage(<WorkspaceRecordFocusPage />);

    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "正在加载工作区记录" })).toHaveAttribute("data-variant", "record");
    expect(view.container.querySelector(".animate-spin, .spin")).toBeNull();

    vi.useRealTimers();
    await act(async () => resolvePage(buildWorkspacePage()));
    expect(await screen.findByLabelText("正文编辑器")).toHaveValue("正文 A");
    expect(screen.queryByRole("status", { name: "正在加载工作区记录" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".page-cold-entry")).toHaveAttribute("data-cold-entry", "true");
  });

  it("renders a cached record synchronously without a cold entrance", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.projects.all, []);
    queryClient.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" }, recentWorkspaces: [], aiSecretsUnlocked: true });
    const view = renderPage(<WorkspaceRecordFocusPage />, queryClient);

    expect(screen.queryByRole("status", { name: /正在加载/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("正文编辑器")).toHaveValue("正文 A");
    expect(view.container.querySelector(".page-cold-entry")).not.toHaveAttribute("data-cold-entry");
    expect(screen.queryByTestId("todo-module-rail")).not.toBeInTheDocument();
  });

  it("offers AI title and Tag filling in a Workspace Record", async () => {
    renderPage(<WorkspaceRecordFocusPage />);

    expect(
      await screen.findByRole("button", { name: "AI 填写标题和标签" }),
    ).toBeEnabled();
  });

  it("applies AI metadata through the Workspace Record atomic save path", async () => {
    apiMocks.aiSettingsGet.mockResolvedValue({
      profiles: [],
      bindings: [],
      hasUsableDefault: true,
      hasUsableImageDefault: false,
      securityMode: "workspace",
      aiSecretsUnlocked: true,
      execution: { maxConcurrency: 1 },
      network: { mode: "system", proxyUrl: null, username: null, hasStoredPassword: false },
      editorSkills: [],
    });
    apiMocks.projectTagSettingsGet.mockResolvedValue({
      tags: [{ id: 12, label: "长期方法", colorKey: "teal", usageCount: 2, createdAt: "", updatedAt: "" }],
    });
    aiMetadataMocks.enqueueAndWait.mockResolvedValue({
      id: 9,
      kind: "record_metadata",
      targetKey: "record-ai-metadata:workspace:7",
      status: "succeeded",
      queuedAt: "",
      result: {
        kind: "record_metadata",
        metadata: { title: "Workspace 方法总结", existingTagIds: [12], newTags: ["复盘"] },
      },
    });
    renderPage(<WorkspaceRecordFocusPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "AI 填写标题和标签" }));

    await waitFor(() => expect(recordMocks.metadataApply).toHaveBeenCalledWith(expect.any(Object),{
      metadata: { target: { scope: { kind: "workspace" },recordId: 7 },title: "Workspace 方法总结",tagIds: [12],expectedRevision: expect.any(String) },
      newTags: [{ label: "复盘",colorKey: expect.any(String) }],
    },expect.any(String)));
    expect(aiMetadataMocks.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
      kind: "record_metadata",
      input: expect.objectContaining({ markdown: "正文 A" }),
    }));
    expect(screen.getByDisplayValue("Workspace 方法总结")).toBeInTheDocument();
  });

  it("exports the Workspace Record from committed content and excludes pending AI preview", async () => {
    const user = userEvent.setup();
    renderPage(<WorkspaceRecordFocusPage />);

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "测试导出" }));

    await waitFor(() => expect(recordExportMocks.sources).toHaveLength(1));
    expect(recordExportMocks.sources[0]).toMatchObject({
      recordKind: "workspace",
      committedHtml: "<p>正文 A</p>",
    });
    expect(recordExportMocks.sources[0]?.committedHtml).not.toContain("AI preview");
  });

  it("leaves persistence to the route coordinator when navigating to another record", async () => {
    const user = userEvent.setup();
    renderPage(<WorkspaceRecordFocusPage />);

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open record 8" }));

    expect(screen.getByTestId("location-display")).toHaveTextContent("/workspace/records/8");
    expect(recordMocks.saveWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("reuses the two most recent Workspace Record Focus editors without another workspace-page request", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.projects.all, []);
    queryClient.setQueryData(queryKeys.workspaceStatus, {
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route
              path="/workspace/records/:noteId"
              element={<ResidentWorkspaceFocusHarness />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByPlaceholderText("记录标题")).toBeEnabled());
    const editorA = screen.getByDisplayValue("正文 A");
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 B" }));
    await waitFor(() => expect(screen.getByDisplayValue("B")).toBeEnabled());
    const editorB = screen.getByDisplayValue("正文 B");
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(editorA.closest("[data-record-focus-resident-key]")).toHaveAttribute("data-record-focus-active", "false");
    expect(editorB.closest("[data-record-focus-resident-key]")).toHaveAttribute("data-record-focus-active", "true");
    expect(
      editorA.closest("[data-record-focus-resident-key]")?.querySelector(
        '[data-testid="todo-module-rail"]',
      ),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 A" }));
    expect(await screen.findByDisplayValue("正文 A")).toBe(editorA);
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开 Workspace 记录 C" }));
    expect(await screen.findByDisplayValue("正文 C")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(editorB).not.toBeInTheDocument();
  });

  it("shares the two-editor residency limit between Workspace and Project Record Focus", async () => {
    const user = userEvent.setup();
    const project: ProjectRecord = {
      id: 1,
      name: "Alpha",
      kind: "normal",
      status: "active",
      rootPath: "/tmp/alpha",
      quickNote: "",
      isArchived: false,
      createdAt: "",
      updatedAt: "",
    };
    const projectNote: NoteRecord = {
      id: 70,
      projectId: 1,
      title: "Project Record",
      contentMarkdown: "Project 正文",
      contentHtml: "<p>Project 正文</p>",
      tags: [],
      createdAt: "",
      updatedAt: "",
    };
    const projectPage: ProjectPageData = {
      project,
      records: [projectNote],
      unfinishedTodos: [],
      finishedTodos: [],
      projectDocuments: [],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    queryClient.setQueryData(queryKeys.workspaceStatus, {
      currentWorkspace: { rootPath: "/tmp/workspace", displayName: "workspace" },
      recentWorkspaces: [],
      aiSecretsUnlocked: true,
    });
    queryClient.setQueryData(queryKeys.projects.all, [project]);
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route path="*" element={<CrossScopeFocusHarness />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByDisplayValue("A")).toBeEnabled());
    const workspaceEditor = screen.getByDisplayValue("正文 A");
    await user.click(screen.getByRole("button", { name: "打开 Project Focus" }));
    await screen.findByDisplayValue("Project 正文");
    await user.click(screen.getByRole("button", { name: "打开 Workspace Focus" }));

    expect(await screen.findByDisplayValue("正文 A")).toBe(workspaceEditor);
    expect(document.querySelectorAll("[data-record-focus-resident-key]")).toHaveLength(2);
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("does not overwrite an initialized Workspace Record draft after Query cache refresh", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/records/7"]}>
          <Routes>
            <Route
              path="/workspace/records/:noteId"
              element={<WorkspaceRecordFocusPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const title = screen.getByPlaceholderText("记录标题");
    await waitFor(() => expect(title).toBeEnabled());
    await user.clear(title);
    await user.type(title, "Workspace 本地标题");
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
      ...buildWorkspacePage(),
      records: [
        { ...noteA, title: "后台刷新标题", contentMarkdown: "后台正文", contentHtml: "<p>后台正文</p>" },
        noteB,
        noteC,
      ],
    });

    expect(title).toHaveValue("Workspace 本地标题");
    expect(screen.getByDisplayValue("正文 A")).toBeInTheDocument();
  });

  it("initializes from a failed Workspace save snapshot before stale Query data", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.workspacePage, buildWorkspacePage());
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("save failed"); }) },
    });
    coordinator.submit({
      scope: "workspace",
      workspaceKey: "/tmp/workspace",
      recordId: 7,
      title: "失败快照标题",
      tagIds: [],
      defaultCodeLanguage: "typescript",
      committedContent: buildMockRichValue("失败快照最新正文"),
    });
    await vi.waitFor(() => {
      expect(coordinator.getRecordStatus("workspace:7").phase).toBe("error");
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RecordSaveCoordinatorProvider coordinator={coordinator}>
          <MemoryRouter initialEntries={["/workspace/records/7"]}>
            <Routes>
              <Route path="/workspace/records/:noteId" element={<WorkspaceRecordFocusPage />} />
            </Routes>
          </MemoryRouter>
        </RecordSaveCoordinatorProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText("记录标题")).toHaveValue("失败快照标题");
    expect(screen.getByDisplayValue("失败快照最新正文")).toBeInTheDocument();
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
  });
});
