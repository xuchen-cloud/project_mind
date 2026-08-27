import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiJobSnapshot, AiSettingsSnapshot, ProjectTagRecord } from "../../lib/types";
import { RecordAiMetadataAction } from "./RecordAiMetadataAction";

const mocks = vi.hoisted(() => ({
  enqueueAndWait: vi.fn(),
  projectRecordMetadataApply: vi.fn(),
  workspaceRecordMetadataApply: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../../lib/aiJobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/aiJobs")>()),
  enqueueAndWait: mocks.enqueueAndWait,
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectRecordMetadataApply: mocks.projectRecordMetadataApply,
    workspaceRecordMetadataApply: mocks.workspaceRecordMetadataApply,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({ pushToast: mocks.pushToast }),
}));

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

describe("RecordAiMetadataAction", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("uses Committed Content and atomically applies title, reused Tags, and new Tags", async () => {
    const beforeApply = vi.fn(async () => undefined);
    const onApplied = vi.fn();
    mocks.enqueueAndWait.mockResolvedValue(successfulJob());
    mocks.projectRecordMetadataApply.mockResolvedValue({
      id: 8,
      projectId: 5,
      title: "AI 生成标题",
      contentMarkdown: "正文",
      contentHtml: "<p>正文</p>",
      tags: [
        { id: 11, label: "已选择", colorKey: "blue" },
        { id: 12, label: "已有相关", colorKey: "teal" },
        { id: 33, label: "新标签", colorKey: "green" },
      ],
      createdAt: "",
      updatedAt: "",
    });

    render(
      <RecordAiMetadataAction
        target={{ scope: "project", projectId: 5, recordId: 8 }}
        aiSettings={aiSettings}
        availableTags={availableTags}
        currentTagIds={[11]}
        getCommittedMarkdown={() => "正文已确认[committed]"}
        beforeApply={beforeApply}
        onApplied={onApplied}
        onOpenAiSettings={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "AI 填写标题和标签" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({
      title: "AI 生成标题",
      tags: expect.arrayContaining([
        expect.objectContaining({ id: 11 }),
        expect.objectContaining({ id: 12 }),
        expect.objectContaining({ id: 33 }),
      ]),
    }));
    expect(mocks.enqueueAndWait.mock.calls[0]?.[0]).toEqual({
      kind: "record_metadata",
      targetKey: "record-ai-metadata:project:5:8",
      input: {
        markdown: "正文已确认[committed]",
        existingTags: [
          { id: 11, label: "已选择" },
          { id: 12, label: "已有相关" },
        ],
      },
    });
    expect(beforeApply).toHaveBeenCalledTimes(1);
    expect(mocks.projectRecordMetadataApply).toHaveBeenCalledWith({
      projectId: 5,
      noteId: 8,
      title: "AI 生成标题",
      tagIds: [11, 12],
      newTags: [{ label: "新标签", colorKey: expect.any(String) }],
    });
    expect(mocks.workspaceRecordMetadataApply).not.toHaveBeenCalled();
  });

  it("preserves Tags selected while the AI job is running", async () => {
    let resolveJob!: (job: AiJobSnapshot) => void;
    mocks.enqueueAndWait.mockImplementation(
      () => new Promise<AiJobSnapshot>((resolve) => { resolveJob = resolve; }),
    );
    mocks.projectRecordMetadataApply.mockResolvedValue({
      title: "AI 生成标题",
      tags: [],
    });
    const props = {
      target: { scope: "project" as const, projectId: 5, recordId: 8 },
      aiSettings,
      availableTags,
      getCommittedMarkdown: () => "正文",
      beforeApply: async () => undefined,
      onApplied: vi.fn(),
      onOpenAiSettings: vi.fn(),
    };
    const view = render(<RecordAiMetadataAction {...props} currentTagIds={[11]} />);

    await userEvent.click(screen.getByRole("button", { name: "AI 填写标题和标签" }));
    view.rerender(<RecordAiMetadataAction {...props} currentTagIds={[11, 44]} />);
    resolveJob(successfulJob());

    await waitFor(() => expect(mocks.projectRecordMetadataApply).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: [11, 44, 12] }),
    ));
  });

  it("opens settings when AI is unavailable and rejects an empty Record", async () => {
    const onOpenAiSettings = vi.fn();
    const props = {
      target: { scope: "workspace" as const, recordId: 8 },
      availableTags: [],
      currentTagIds: [],
      beforeApply: async () => undefined,
      onApplied: vi.fn(),
      onOpenAiSettings,
    };
    const view = render(
      <RecordAiMetadataAction
        {...props}
        aiSettings={{ ...aiSettings, hasUsableDefault: false }}
        getCommittedMarkdown={() => "正文"}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "AI 填写标题和标签" }));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAndWait).not.toHaveBeenCalled();

    view.rerender(
      <RecordAiMetadataAction
        {...props}
        aiSettings={aiSettings}
        getCommittedMarkdown={() => "   "}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "AI 填写标题和标签" }));
    expect(mocks.enqueueAndWait).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "正文为空" }));
  });
});
