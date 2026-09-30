import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AiJobSnapshot, AiSettingsSnapshot, ProjectTagRecord } from "../../lib/types";
import { RecordAiMetadataAction } from "./RecordAiMetadataAction";
const mocks = vi.hoisted(() => ({ enqueueAndWait: vi.fn(), metadataGet: vi.fn(), metadataApply: vi.fn(), pushToast: vi.fn() }));
vi.mock("../../lib/aiJobs", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/aiJobs")>(), enqueueAndWait: mocks.enqueueAndWait }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { metadataGet: mocks.metadataGet, metadataApply: mocks.metadataApply } }));
vi.mock("../../state/feedback-store", () => ({ useFeedbackStore: () => ({ pushToast: mocks.pushToast }) }));
const binding = { workspaceId: "workspace", generation: "opened" };
const target = { scope: "project" as const, projectId: 5, recordId: 8 };
const baseline = { title: "Old", tagIds: [11], revision: "metadata-1", updatedAt: "now" };
const aiSettings: AiSettingsSnapshot = {
  profiles: [],
  bindings: [],
  hasUsableDefault: true,
  hasUsableImageDefault: false,
  securityMode: "workspace",
  aiSecretsUnlocked: true,
  execution: { maxConcurrency: 1 },
  editorSkills: [],
};

const availableTags: ProjectTagRecord[] = [
  { id: 11, label: "已选择", colorKey: "blue", usageCount: 2, createdAt: "", updatedAt: "" },
  { id: 12, label: "已有相关", colorKey: "teal", usageCount: 1, createdAt: "", updatedAt: "" },
];

function successfulJob(): AiJobSnapshot {
  return {
    id: 4,
    kind: "record_metadata",
    targetKey: "record-ai-metadata:project:5:8",
    status: "succeeded",
    queuedAt: "",
    result: {
      kind: "record_metadata",
      metadata: {
        title: "AI 生成标题",
        existingTagIds: [12],
        newTags: ["新标签"],
      },
    },
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.metadataGet.mockResolvedValue(baseline);
});
it("uses Committed Content and atomically applies title and tags against a bound metadata revision", async () => {
  const beforeApply = vi.fn(async () => undefined);
  const onApplied = vi.fn();
  const onSubmitted = vi.fn();
  mocks.enqueueAndWait.mockResolvedValue(successfulJob());
  const metadata = { ...baseline, title: "AI 生成标题", tagIds: [11,12,33], revision: "metadata-2" };
  const tags = [{ id: 11,label: "已选择",colorKey: "blue" },{ id: 12,label: "已有相关",colorKey: "teal" },{ id: 33,label: "新标签",colorKey: "green" }];
  mocks.metadataApply.mockResolvedValue({ metadata,tags });
  render(<RecordAiMetadataAction binding={binding} target={target} aiSettings={aiSettings} availableTags={availableTags} currentTagIds={[11]}
    getCommittedMarkdown={() => "正文已确认[committed]"} beforeApply={beforeApply} onApplied={onApplied} onSubmitted={onSubmitted} onOpenAiSettings={vi.fn()} />);
  await userEvent.click(screen.getByRole("button",{ name: "AI 填写标题和标签" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ title: "AI 生成标题",tags,metadata,expectedRevision: baseline.revision }));
  expect(beforeApply).toHaveBeenCalledTimes(2);
  expect(mocks.enqueueAndWait.mock.calls[0][0].input.markdown).toBe("正文已确认[committed]");
  expect(mocks.metadataApply).toHaveBeenCalledWith(binding,{
    metadata: { target: { scope: { kind: "project",projectId: 5 },recordId: 8 },title: "AI 生成标题",tagIds: [11,12],expectedRevision: baseline.revision },
    newTags: [{ label: "新标签",colorKey: expect.any(String) }],
  },expect.any(String));
  expect(onSubmitted).toHaveBeenCalledWith(mocks.metadataApply.mock.calls[0][2]);
});
it("preserves concurrent metadata edits by reporting a revision conflict", async () => {
  let resolveJob!: (job: AiJobSnapshot) => void;
  mocks.enqueueAndWait.mockImplementation(() => new Promise((resolve) => { resolveJob = resolve; }));
  mocks.metadataApply.mockRejectedValue(new Error("Record metadata changed before AI apply"));
  const onApplied = vi.fn();
  const props = { binding,target,aiSettings,availableTags,getCommittedMarkdown: () => "正文",beforeApply: async () => undefined,onApplied,onOpenAiSettings: vi.fn() };
  const view = render(<RecordAiMetadataAction {...props} currentTagIds={[11]} />);
  await userEvent.click(screen.getByRole("button",{ name: "AI 填写标题和标签" }));
  view.rerender(<RecordAiMetadataAction {...props} currentTagIds={[11,44]} />);
  resolveJob(successfulJob());
  await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "AI 填写失败" })));
  expect(onApplied).not.toHaveBeenCalled();
  expect(mocks.metadataApply.mock.calls[0][1].metadata.expectedRevision).toBe(baseline.revision);
});
it("opens settings when AI is unavailable and rejects an empty Record", async () => {
  const onOpenAiSettings = vi.fn();
  const props = { binding,target,availableTags: [],currentTagIds: [],beforeApply: async () => undefined,onApplied: vi.fn(),onOpenAiSettings };
  const view = render(<RecordAiMetadataAction {...props} aiSettings={{ ...aiSettings,hasUsableDefault: false }} getCommittedMarkdown={() => "正文"} />);
  await userEvent.click(screen.getByRole("button",{ name: "AI 填写标题和标签" }));
  expect(onOpenAiSettings).toHaveBeenCalledOnce();
  view.rerender(<RecordAiMetadataAction {...props} aiSettings={aiSettings} getCommittedMarkdown={() => " "} />);
  await userEvent.click(screen.getByRole("button",{ name: "AI 填写标题和标签" }));
  expect(mocks.enqueueAndWait).not.toHaveBeenCalled();
  expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "正文为空" }));
});
