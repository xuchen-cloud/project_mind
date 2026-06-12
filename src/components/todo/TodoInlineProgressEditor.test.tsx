import { fireEvent, render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { projectMindApi } from "../../services/projectMindApi";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

describe("TodoInlineProgressEditor", () => {
  it("shows an inline placeholder and saves a new sub item when empty", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} onError={vi.fn()} />,
    );

    expect(screen.queryByText(/\+\s*进展/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");

    await user.type(screen.getByRole("textbox"), "@0315 已确认方案");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      content: "已确认方案",
      progressDate: expect.stringMatching(/^\d{4}-03-15$/u),
    });
  });

  it("uses the existing progress content as the trigger surface", async () => {
    const user = userEvent.setup();

    render(
      <TodoInlineProgressEditor
        latestProgress={{ id: 8, content: "完成问题答复", progressDate: "2026-04-06" }}
        editable
        onSave={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "完成问题答复" }));

    expect(screen.getByText("@0315 已与财务确认方案")).toBeInTheDocument();
  });

  it("normalizes pasted line breaks before saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));

    const textbox = screen.getByRole("textbox");
    textbox.textContent = "@0315 已确认\n方案";
    fireEvent.input(textbox);

    expect(screen.getByRole("textbox")).toHaveTextContent("@0315 已确认 方案");

    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      content: "已确认 方案",
      progressDate: expect.stringMatching(/^\d{4}-03-15$/u),
    });
  });

  it("closes without saving when the new sub item content is empty", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onError = vi.fn();

    render(
      <TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} onError={onError} />,
    );

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));
    await user.type(screen.getByRole("textbox"), "   ");
    await user.keyboard("{Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("closes without saving when only a date prefix is entered", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onError = vi.fn();

    render(
      <TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} onError={onError} />,
    );

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));
    await user.type(screen.getByRole("textbox"), "@0315");
    await user.keyboard("{Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("edits the latest sub item from the context menu and preserves its date by default", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onUpdateLatestProgress = vi.fn();

    render(
      <TodoInlineProgressEditor
        latestProgress={{ id: 18, content: "完成问题答复", progressDate: "2026-04-06" }}
        editable
        onSave={onSave}
        onUpdateLatestProgress={onUpdateLatestProgress}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "完成问题答复" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑子项" }));

    const textbox = screen.getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "补充最终答复");
    await user.keyboard("{Enter}");

    expect(onUpdateLatestProgress).toHaveBeenCalledWith(18, {
      content: "补充最终答复",
      progressDate: "2026-04-06",
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("deletes the latest sub item from the context menu", async () => {
    const user = userEvent.setup();
    const onDeleteLatestProgress = vi.fn();

    render(
      <TodoInlineProgressEditor
        latestProgress={{ id: 23, content: "完成问题答复", progressDate: "2026-04-06" }}
        editable
        onSave={vi.fn()}
        onDeleteLatestProgress={onDeleteLatestProgress}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "完成问题答复" }));
    await user.click(screen.getByRole("menuitem", { name: "删除子项" }));

    expect(onDeleteLatestProgress).toHaveBeenCalledWith(23);
  });

  it("supports internal reference insertion and display for progress content", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenInternalReference = vi.fn(async () => true);
    const searchSpy = vi
      .spyOn(projectMindApi, "internalReferenceSearch")
      .mockResolvedValue([
        {
          kind: "document",
          id: 51,
          label: "project-brief.pdf",
          projectId: 1,
          activityId: 2,
          subtitle: "Alpha · Kickoff",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ]);

    const { container } = render(
      <TodoInlineProgressEditor
        latestProgress={null}
        editable
        onSave={onSave}
        onError={vi.fn()}
        internalReferenceContext={{ scope: "project", projectId: 1 }}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));
    await user.keyboard("[[[[");
    expect(await screen.findByRole("option", { name: /文件.*project-brief\.pdf/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox")).toHaveTextContent("文件project-brief.pdf");
    expect(container.querySelector(".internal-reference-chip--todo")).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledWith({
      content: "[[document:51|project-brief.pdf]]",
      progressDate: expect.any(String),
    });

    searchSpy.mockRestore();
  });

  it("supports contact mention insertion for progress content", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const searchSpy = vi.spyOn(projectMindApi, "contactSearch").mockResolvedValue([
      {
        id: 15,
        name: "李四",
        pinyinFull: "li si",
        pinyinAbbr: "ls",
        email: "",
        employeeId: "",
        role: "",
        department: "",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:00:00.000Z",
      },
    ]);

    render(
      <TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} onError={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "点击添加子项..." }));
    await user.type(screen.getByRole("textbox"), "@li");
    expect(await screen.findByRole("option", { name: /李四/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      content: "@[contact:15|李四]",
      progressDate: expect.any(String),
    });
    searchSpy.mockRestore();
  });
});
