import { describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  commandMock: vi.fn(),
}));

vi.mock("./desktopApi", () => ({
  desktopApi: {
    command: serviceMocks.commandMock,
  },
}));

import { projectMindApi } from "./projectMindApi";

describe("projectMindApi", () => {
  it("maps project create to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 1, name: "Project" });

    await projectMindApi.projectCreate({
      name: "Project",
      workspaceRoot: "/tmp/project",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("project_create", {
      input: {
        name: "Project",
        workspaceRoot: "/tmp/project",
      },
    });
  });

  it("maps workspace search to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.workspaceSearch({ query: "todo" });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_search", {
      input: { query: "todo" },
    });
  });

  it("maps note upsert to the unified note command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 7, noteType: "quick_note" });

    await projectMindApi.noteUpsert({
      projectId: 1,
      activityId: 2,
      noteType: "quick_note",
      title: "原始记录",
      markdown: "Captured detail",
      html: "<p>Captured detail</p>",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("note_upsert", {
      input: {
        projectId: 1,
        activityId: 2,
        noteType: "quick_note",
        title: "原始记录",
        markdown: "Captured detail",
        html: "<p>Captured detail</p>",
      },
    });
  });

  it("maps conclusion create to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 11 });

    await projectMindApi.conclusionCreate({
      projectId: 1,
      activityId: 2,
      markdown: "## 已确认结论",
      html: "<h2>已确认结论</h2>",
      promotedToProject: true,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("conclusion_create", {
      input: {
        projectId: 1,
        activityId: 2,
        markdown: "## 已确认结论",
        html: "<h2>已确认结论</h2>",
        promotedToProject: true,
      },
    });
  });

  it("maps conclusion update to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 11 });

    await projectMindApi.conclusionUpdate({
      conclusionId: 11,
      markdown: "> 调整后的结论",
      html: "<blockquote><p>调整后的结论</p></blockquote>",
      promotedToProject: false,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("conclusion_update", {
      input: {
        conclusionId: 11,
        markdown: "> 调整后的结论",
        html: "<blockquote><p>调整后的结论</p></blockquote>",
        promotedToProject: false,
      },
    });
  });

  it("maps ai settings fetch without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "device_bound_encrypted",
    });

    await projectMindApi.aiSettingsGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_settings_get");
  });

  it("maps activity settings fetch without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      activityAttributeOptions: [],
      activityStatusOptions: [],
    });

    await projectMindApi.activitySettingsGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("activity_settings_get");
  });

  it("maps activity status save to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 3, label: "待法务确认" });

    await projectMindApi.activityStatusOptionUpsert({
      id: 3,
      label: "待法务确认",
      needsAttention: true,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("activity_status_option_upsert", {
      input: {
        id: 3,
        label: "待法务确认",
        needsAttention: true,
      },
    });
  });

  it("maps rich text style fetch without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      body: {
        fontPreset: "workspace_sans",
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingPx: 12,
      },
      headings: {
        fontPreset: "workspace_sans",
        lineHeight: 1.35,
        paragraphSpacingPx: 12,
        h1SizePx: 24,
        h2SizePx: 20,
        h3SizePx: 16,
      },
      list: {
        fontPreset: "workspace_sans",
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingPx: 12,
      },
    });

    await projectMindApi.richTextStyleGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("rich_text_style_get");
  });

  it("maps rich text style save to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({});

    await projectMindApi.richTextStyleUpsert({
      body: {
        fontPreset: "work_sans",
        fontSizePx: 15,
        lineHeight: 1.7,
        paragraphSpacingPx: 14,
      },
      headings: {
        fontPreset: "source_serif",
        lineHeight: 1.3,
        paragraphSpacingPx: 10,
        h1SizePx: 28,
        h2SizePx: 22,
        h3SizePx: 18,
      },
      list: {
        fontPreset: "noto_sans_sc",
        fontSizePx: 15,
        lineHeight: 1.65,
        paragraphSpacingPx: 10,
      },
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("rich_text_style_upsert", {
      input: {
        body: {
          fontPreset: "work_sans",
          fontSizePx: 15,
          lineHeight: 1.7,
          paragraphSpacingPx: 14,
        },
        headings: {
          fontPreset: "source_serif",
          lineHeight: 1.3,
          paragraphSpacingPx: 10,
          h1SizePx: 28,
          h2SizePx: 22,
          h3SizePx: 18,
        },
        list: {
          fontPreset: "noto_sans_sc",
          fontSizePx: 15,
          lineHeight: 1.65,
          paragraphSpacingPx: 10,
        },
      },
    });
  });

  it("maps ai binding updates to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      capability: "summary",
      useDefault: false,
      profileId: 3,
      model: "gpt-4.1-mini",
      updatedAt: "",
    });

    await projectMindApi.aiBindingUpsert({
      capability: "summary",
      useDefault: false,
      profileId: 3,
      model: "gpt-4.1-mini",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_binding_upsert", {
      input: {
        capability: "summary",
        useDefault: false,
        profileId: 3,
        model: "gpt-4.1-mini",
      },
    });
  });
});
