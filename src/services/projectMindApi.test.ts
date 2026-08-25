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
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("project_create", {
      input: {
        name: "Project",
      },
    });
  });

  it("maps project summary update with rename payload to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 1,
      name: "Project Prime",
    });

    await projectMindApi.projectUpdate({
      projectId: 1,
      name: "Project Prime",
      summary: "最新项目简介",
      summaryMarkdown: "## 最新项目简介",
      summaryHtml: "<h2>最新项目简介</h2>",
      status: "active",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("project_update", {
      input: {
        projectId: 1,
        name: "Project Prime",
        summary: "最新项目简介",
        summaryMarkdown: "## 最新项目简介",
        summaryHtml: "<h2>最新项目简介</h2>",
        status: "active",
      },
    });
  });

  it("maps workspace search to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.workspaceSearch({ query: "todo", projectId: 3 });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_search", {
      input: { query: "todo", projectId: 3 },
    });
  });

  it("maps internal reference commands to the correct names", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);
    await projectMindApi.internalReferenceSearch({
      query: "[[",
      projectId: 1,
      scope: "project",
      limit: 8,
    });
    expect(serviceMocks.commandMock).toHaveBeenCalledWith("internal_reference_search", {
      input: {
        query: "[[",
        projectId: 1,
        scope: "project",
        limit: 8,
      },
    });

    serviceMocks.commandMock.mockResolvedValueOnce(null);
    await projectMindApi.internalReferenceResolve({
      kind: "todo",
      id: 18,
    });
    expect(serviceMocks.commandMock).toHaveBeenCalledWith("internal_reference_resolve", {
      input: {
        kind: "todo",
        id: 18,
      },
    });
  });

  it("maps workspace overview to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      overviewNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    });

    await projectMindApi.workspacePageGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_page_get");
  });

  it("maps today quick note commands to the correct command names", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce(null);
    await projectMindApi.workspaceQuickNoteGet();
    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_quick_note_get");

    serviceMocks.commandMock.mockResolvedValueOnce({ id: 9 });
    await projectMindApi.workspaceQuickNoteUpsert({
      markdown: "今日快记",
      html: "<p>今日快记</p>",
    });
    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_quick_note_upsert", {
      input: {
        markdown: "今日快记",
        html: "<p>今日快记</p>",
      },
    });
  });

  it("maps workspace note upsert to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 3 });

    await projectMindApi.workspaceRecordUpsert({
      title: "工作区记录",
      markdown: "整理一下今天的判断",
      html: "<p>整理一下今天的判断</p>",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_record_upsert", {
      input: {
        title: "工作区记录",
        markdown: "整理一下今天的判断",
        html: "<p>整理一下今天的判断</p>",
      },
    });
  });

  it("maps workspace note delete to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 3 });

    await projectMindApi.workspaceRecordDelete({ noteId: 3 });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("workspace_record_delete", {
      input: {
        noteId: 3,
      },
    });
  });

  it("maps todo priority update to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 5,
      priority: "urgent_important",
    });

    await projectMindApi.todoUpdatePriority({
      todoId: 5,
      priority: "urgent_important",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("todo_update_priority", {
      input: {
        todoId: 5,
        priority: "urgent_important",
      },
    });
  });

  it("maps todo delete to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 5 });

    await projectMindApi.todoDelete({
      todoId: 5,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("todo_delete", {
      input: {
        todoId: 5,
      },
    });
  });

  it("maps todo progress update to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 9,
      content: "已更新进展",
    });

    await projectMindApi.todoUpdateProgress({
      progressId: 9,
      content: "已更新进展",
      progressDate: "2026-04-06",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("todo_update_progress", {
      input: {
        progressId: 9,
        content: "已更新进展",
        progressDate: "2026-04-06",
      },
    });
  });

  it("maps todo progress delete to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 9 });

    await projectMindApi.todoDeleteProgress({
      progressId: 9,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("todo_delete_progress", {
      input: {
        progressId: 9,
      },
    });
  });

  it("maps ai settings fetch without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      editorRewriteActions: [],
    });

    await projectMindApi.aiSettingsGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_settings_get");
  });

  it("maps project tag settings fetch with project payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      tags: [],
    });

    await projectMindApi.projectTagSettingsGet({ projectId: 7 });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("file_tag_settings_get", { input: { projectId: 7 } });
  });

  it("maps contact search to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.contactSearch({ query: "zs", limit: 8 });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("contact_search", {
      input: { query: "zs", limit: 8 },
    });
  });

  it("maps contact upsert to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 7,
      name: "张三",
      pinyinFull: "zhangsan",
      pinyinAbbr: "zs",
      email: "zhangsan@example.com",
      employeeId: "E007",
      role: "PM",
      department: "Product",
      createdAt: "",
      updatedAt: "",
    });

    await projectMindApi.contactUpsert({
      name: "张三",
      pinyinFull: "zhangsan",
      pinyinAbbr: "zs",
      email: "zhangsan@example.com",
      employeeId: "E007",
      role: "PM",
      department: "Product",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("contact_upsert", {
      input: {
        name: "张三",
        pinyinFull: "zhangsan",
        pinyinAbbr: "zs",
        email: "zhangsan@example.com",
        employeeId: "E007",
        role: "PM",
        department: "Product",
      },
    });
  });

  it("maps project tag save to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 4,
      label: "法务",
      colorKey: "blue",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    });

    await projectMindApi.projectTagUpsert({
      projectId: 7,
      id: 4,
      label: "法务",
      colorKey: "blue",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("file_tag_option_upsert", {
      input: {
        projectId: 7,
        id: 4,
        label: "法务",
        colorKey: "blue",
      },
    });
  });

  it("maps document import with tag ids to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 12 });

    await projectMindApi.documentImport({
      projectId: 1,
      sourcePath: "/tmp/brief.pdf",
      isStarred: false,
      tagIds: [3, 5],
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_import", {
      input: {
        projectId: 1,
        sourcePath: "/tmp/brief.pdf",
        isStarred: false,
        tagIds: [3, 5],
      },
    });
  });

  it("maps note image import to the dedicated command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 18 });

    await projectMindApi.documentImportNoteImage({
      projectId: 1,
      sourcePath: "/tmp/clip.png",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_import_note_image", {
      input: {
        projectId: 1,
        sourcePath: "/tmp/clip.png",
      },
    });
  });

  it("maps clipboard note image import to the dedicated command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 19 });

    await projectMindApi.documentImportClipboardNoteImage({
      projectId: 1,
      fileName: "pasted-image.png",
      mimeType: "image/png",
      dataBase64: "ZmFrZQ==",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_import_clipboard_note_image", {
      input: {
        projectId: 1,
        fileName: "pasted-image.png",
        mimeType: "image/png",
        dataBase64: "ZmFrZQ==",
      },
    });
  });

  it("maps document add version without source path to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 12 });

    await projectMindApi.documentAddVersion({
      documentId: 12,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_add_version", {
      input: {
        documentId: 12,
      },
    });
  });

  it("maps document add version with source path to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 12 });

    await projectMindApi.documentAddVersion({
      documentId: 12,
      sourcePath: "/tmp/brief-v2.pdf",
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_add_version", {
      input: {
        documentId: 12,
        sourcePath: "/tmp/brief-v2.pdf",
      },
    });
  });

  it("maps document delete to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ id: 12 });

    await projectMindApi.documentDelete({
      documentId: 12,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("document_delete", {
      input: {
        documentId: 12,
      },
    });
  });

  it("maps rich text style fetch without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      body: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
      headings: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        lineHeight: 1.35,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
        h1SizePx: 24,
        h2SizePx: 20,
        h3SizePx: 16,
      },
      list: {
        fontFamily: { source: "preset", value: "workspace_sans" },
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
    });

    await projectMindApi.richTextStyleGet();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("rich_text_style_get");
  });

  it("maps rich text style save to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({});

    await projectMindApi.richTextStyleUpsert({
      body: {
        fontFamily: { source: "preset", value: "work_sans" },
        fontSizePx: 15,
        lineHeight: 1.7,
        paragraphSpacingBeforePx: 14,
        paragraphSpacingAfterPx: 2,
      },
      headings: {
        fontFamily: { source: "preset", value: "source_serif" },
        lineHeight: 1.3,
        paragraphSpacingBeforePx: 10,
        paragraphSpacingAfterPx: 4,
        h1SizePx: 28,
        h2SizePx: 22,
        h3SizePx: 18,
      },
      list: {
        fontFamily: { source: "preset", value: "noto_sans_sc" },
        fontSizePx: 15,
        lineHeight: 1.65,
        paragraphSpacingBeforePx: 10,
        paragraphSpacingAfterPx: 3,
      },
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("rich_text_style_upsert", {
      input: {
        body: {
          fontFamily: { source: "preset", value: "work_sans" },
          fontSizePx: 15,
          lineHeight: 1.7,
          paragraphSpacingBeforePx: 14,
          paragraphSpacingAfterPx: 2,
        },
        headings: {
          fontFamily: { source: "preset", value: "source_serif" },
          lineHeight: 1.3,
          paragraphSpacingBeforePx: 10,
          paragraphSpacingAfterPx: 4,
          h1SizePx: 28,
          h2SizePx: 22,
          h3SizePx: 18,
        },
        list: {
          fontFamily: { source: "preset", value: "noto_sans_sc" },
          fontSizePx: 15,
          lineHeight: 1.65,
          paragraphSpacingBeforePx: 10,
          paragraphSpacingAfterPx: 3,
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

  it("maps editor skill upserts to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: "translate",
      name: "翻译成英文",
      icon: "🌐",
      description: "翻译选区",
      prompt: "请翻译成自然英文",
      resultMode: "answer",
      showInTextMenu: true,
      sortOrder: 1,
      enabled: true,
      createdAt: "",
      updatedAt: "",
    });

    await projectMindApi.aiEditorSkillUpsert({
      name: "翻译成英文",
      icon: "🌐",
      description: "翻译选区",
      prompt: "请翻译成自然英文",
      resultMode: "answer",
      showInTextMenu: true,
      enabled: true,
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_editor_skill_upsert", {
      input: {
        name: "翻译成英文",
        icon: "🌐",
        description: "翻译选区",
        prompt: "请翻译成自然英文",
        resultMode: "answer",
        showInTextMenu: true,
        enabled: true,
      },
    });
  });

  it("maps editor skill deletes to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.aiEditorSkillDelete({ skillId: "translate" });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_editor_skill_delete", {
      input: {
        skillId: "translate",
      },
    });
  });

  it("maps editor skill reorders to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.aiEditorSkillReorder({ skillIds: ["b", "a"] });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_editor_skill_reorder", {
      input: {
        skillIds: ["b", "a"],
      },
    });
  });

  it("maps ai job enqueue to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({
      id: 1,
      kind: "editor_skill",
      targetKey: "editor-rewrite:test",
      status: "queued",
      queuedAt: "",
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      result: null,
    });

    await projectMindApi.aiJobEnqueue({
      kind: "editor_skill",
      targetKey: "editor-rewrite:test",
      input: {
        skillId: "proofread",
        skillName: "校对",
        prompt: "请校对",
        resultMode: "modify",
        selectedText: "原文",
      },
    });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_job_enqueue", {
      input: {
        kind: "editor_skill",
        targetKey: "editor-rewrite:test",
        input: {
          skillId: "proofread",
          skillName: "校对",
          prompt: "请校对",
          resultMode: "modify",
          selectedText: "原文",
        },
      },
    });
  });

  it("maps ai job get to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce(null);

    await projectMindApi.aiJobGet(12);

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_job_get", {
      jobId: 12,
    });
  });

  it("maps ai jobs list active without payload", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce([]);

    await projectMindApi.aiJobsListActive();

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_jobs_list_active");
  });

  it("maps ai execution settings updates to the correct command", async () => {
    serviceMocks.commandMock.mockResolvedValueOnce({ maxConcurrency: 3 });

    await projectMindApi.aiExecutionSettingsUpsert({ maxConcurrency: 3 });

    expect(serviceMocks.commandMock).toHaveBeenCalledWith("ai_execution_settings_upsert", {
      input: { maxConcurrency: 3 },
    });
  });
});
