import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { RecordListItem } from "./RecordListItem";
import { createRecordSaveCoordinator, RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fixtureBodySave, fixtureEditorState } from "../../test/recordDocumentFixture";
import { AgentApiError } from "../../services/agentApi";

vi.mock("../../services/agentApi", async (original) => ({ ...await original<typeof import("../../services/agentApi")>(), agentApi: { statusGet: vi.fn(async () => ({ binding: { workspaceId: "workspace", generation: "opened" } })) } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { editorGet: vi.fn(), bodySave: vi.fn(), checkpoint: vi.fn(async () => undefined) } }));
vi.mock("../../lib/record-editor-registration", () => ({ registerCanonicalRecordEditor: vi.fn(async () => () => undefined) }));
vi.mock("../../lib/record-document-events", () => ({ subscribeRecordHeadChanges: vi.fn(async () => () => undefined) }));
vi.mock("../rich-editor", async (original) => {
  const actual = await original<typeof import("../rich-editor")>();
  const React = await import("react");
  const { fixtureDocument } = await import("../../test/recordDocumentFixture");
  return { ...actual, RichEditor: (props: { html: string; readOnly: boolean; controllerRef: { current: unknown }; onSave: (value: unknown) => Promise<void>; onBeforeAiCommit?: () => boolean; onAiCommit?: (value: unknown) => void }) => {
    const plain = (html: string) => html.replace(/<[^>]*>/g, "");
    const [body, setBody] = React.useState(plain(props.html));
    const current = React.useRef(body); current.current = body;
    const pending = React.useRef(0);
    React.useEffect(() => { setBody(plain(props.html)); }, [props.html]);
    const committed = () => ({ html: `<p data-block-id="${"1".repeat(32)}">${current.current}</p>`, markdown: current.current, text: current.current });
    props.controllerRef.current = { getValue: () => { throw new Error("Live preview must never be saved"); }, getCommittedValue: committed,
      getCommittedDocumentJson: () => fixtureDocument(current.current), getPendingAiReviewCount: () => pending.current,
      hasUnsavedCommittedContent: () => true, applyIncomingContent: () => false };
    return <div><textarea aria-label="Inline body" disabled={props.readOnly} value={body} onChange={(event) => setBody(event.target.value)} />
      <button type="button" disabled={props.readOnly} onClick={() => void props.onSave(committed()).catch(() => undefined)}>Save inline</button>
      <button type="button" onClick={() => { pending.current = 1; }}>Add AI candidate</button>
      <button type="button" onClick={() => { if (!props.onBeforeAiCommit?.()) return; current.current = "Accepted AI body"; pending.current = 0; setBody(current.current); props.onAiCommit?.(committed()); }}>Accept AI candidate</button>
    </div>;
  } };
});
const record = { id: 7, title: "Server title", contentHtml: "<p>Server body</p>", contentMarkdown: "Server body", defaultCodeLanguage: null, tags: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
const target = { scope: { kind: "workspace" as const }, recordId: 7 };
const initial = fixtureEditorState(target, record, 7);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValue(initial);
  vi.mocked(recordDocumentApi.bodySave).mockImplementation((_binding, input) => fixtureBodySave(input, record, async (fields) => ({ ...record, title: fields.title, contentHtml: fields.html, contentMarkdown: fields.markdown, updatedAt: "2026-10-01T00:01:00Z" })));
});
function show() {
  const queryClient = new QueryClient();
  const coordinator = createRecordSaveCoordinator({ workspaceKey: "/workspace", queryClient });
  const onOpenFocusPage = vi.fn();
  const tree = (active: boolean) => <QueryClientProvider client={queryClient}><RecordSaveCoordinatorProvider coordinator={coordinator}>
    <RecordListItem record={record} scope={{ kind: "workspace" }} focused={false} availableTags={[]} busy={false} active={active} aiSettings={null}
      contactMentionOptions={{}} scrollParentSelector="body" onOpenFocusPage={onOpenFocusPage} onOpenContextMenu={vi.fn()} onOpenInternalReference={() => false} onOpenAiSettings={vi.fn()} />
  </RecordSaveCoordinatorProvider></QueryClientProvider>;
  const view = render(tree(true));
  fireEvent.keyDown(view.container.querySelector(".project-history-record__surface")!, { key: "Enter" });
  return { ...view, coordinator, onOpenFocusPage, setActive: (active: boolean) => view.rerender(tree(active)) };
}
it("a save finishing after the page becomes hidden cannot close or navigate the editor", async () => {
  let finish!: (value: typeof record) => void;
  vi.mocked(recordDocumentApi.bodySave).mockImplementationOnce((_binding, input) => fixtureBodySave(input, record, async () => new Promise((resolve) => { finish = resolve; })));
  const view = show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Saving draft" } });
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.setActive(false);
  await act(async () => { finish({ ...record, contentMarkdown: "Saving draft" }); await view.coordinator.flush(); });
  expect(screen.getByRole("textbox", { name: "Inline body" })).toHaveValue("Saving draft");
  expect(screen.getByRole("textbox", { name: "Inline body" })).toBeDisabled();
  expect(recordDocumentApi.checkpoint).not.toHaveBeenCalled();
  expect(view.onOpenFocusPage).not.toHaveBeenCalled();
});
it("loads a canonical baseline before editing and advances it across sequential inline saves", async () => {
  let complete!: (value: typeof initial) => void;
  vi.mocked(recordDocumentApi.editorGet).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  show();
  expect(screen.getByRole("textbox", { name: "Inline body" })).toBeDisabled();
  await act(async () => { complete(initial); });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "First edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save inline" }));
  await waitFor(() => expect(recordDocumentApi.bodySave).toHaveBeenCalledOnce());
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[0][1]).toMatchObject({ target, baseRevision: 7, document: { content: [{ attrs: { blockId: "1".repeat(32) }, content: [{ text: "First edit" }] }] } });
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Second edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save inline" }));
  await waitFor(() => expect(recordDocumentApi.bodySave).toHaveBeenCalledTimes(2));
  expect(vi.mocked(recordDocumentApi.bodySave).mock.calls[1][1].baseRevision).toBe(8);
});
it("a delayed save response cannot replace newer typing", async () => {
  let finish!: (value: typeof record) => void;
  vi.mocked(recordDocumentApi.bodySave).mockImplementationOnce((_binding, input) => fixtureBodySave(input, record, async () => new Promise((resolve) => { finish = resolve; })));
  const { coordinator } = show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Saving body" } });
  fireEvent.click(screen.getByRole("button", { name: "Save inline" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Newer typing" } });
  await act(async () => { finish({ ...record, contentHtml: "<p>Saving body</p>", contentMarkdown: "Saving body" }); await coordinator.flush(); });
  expect(screen.getByRole("textbox", { name: "Inline body" })).toHaveValue("Newer typing");
});
it("reopening inline editing reloads the current canonical body", async () => {
  const view = show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Inline body" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Inline body" })).not.toBeInTheDocument());
  const updated = { ...record, contentHtml: "<p>Changed in another window</p>", contentMarkdown: "Changed in another window" };
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValueOnce(fixtureEditorState(target, updated, 8));
  fireEvent.keyDown(view.container.querySelector(".project-history-record__surface")!, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toHaveValue("Changed in another window"));
});
it("CAS failure and outside clicks keep the inline draft and expose conflict actions", async () => {
  vi.mocked(recordDocumentApi.bodySave).mockRejectedValue(new AgentApiError({ code: "REVISION_CONFLICT", message: "Another window saved", retryable: false }));
  show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Keep local draft" } });
  fireEvent.pointerDown(document.body);
  expect(await screen.findByRole("button", { name: "查看差异" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Inline body" })).toHaveValue("Keep local draft");
  expect(screen.getByText("Another window saved")).toBeInTheDocument();
});
it("typing during an outside-click save prevents the editor from closing", async () => {
  let finish!: (value: typeof record) => void;
  vi.mocked(recordDocumentApi.bodySave).mockImplementationOnce((_binding, input) => fixtureBodySave(input, record, async () => new Promise((resolve) => { finish = resolve; })));
  show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "First draft" } });
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(screen.getByRole("textbox", { name: "Inline body" }), { target: { value: "Keep newer draft" } });
  await act(async () => { finish({ ...record, contentMarkdown: "First draft" }); });
  expect(await screen.findByText(/保存期间内容有更新/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Inline body" })).toHaveValue("Keep newer draft");
  expect(recordDocumentApi.checkpoint).not.toHaveBeenCalled();
});
it("pending AI content blocks leaving and explicit acceptance creates an editor_ai boundary", async () => {
  show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Inline body" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Add AI candidate" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Inline body" }), { key: "Enter", ctrlKey: true });
  expect(await screen.findByText(/请先接受或取消待确认的 AI 内容/)).toBeInTheDocument();
  expect(recordDocumentApi.bodySave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Accept AI candidate" }));
  await waitFor(() => expect(vi.mocked(recordDocumentApi.bodySave).mock.calls.some(([, input]) => input.origin === "editor_ai")).toBe(true));
  const input = vi.mocked(recordDocumentApi.bodySave).mock.calls.find(([, input]) => input.origin === "editor_ai")![1];
  expect(input.document.content![0].content![0].text).toBe("Accepted AI body");
});
