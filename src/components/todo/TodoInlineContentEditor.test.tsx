import { fireEvent, render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { projectMindApi } from "../../services/projectMindApi";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

describe("TodoInlineContentEditor", () => {
  it("parses and displays an @ due date separately from the todo content", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <TodoInlineContentEditor value="提交方案" editable onSave={onSave} />,
    );

    await user.click(screen.getByRole("button", { name: "提交方案" }));
    const textbox = screen.getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "提交最终方案@20270315");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("提交最终方案", "2027-03-15");
    const dueDate = screen.getByText("3月15日").closest("time");
    expect(dueDate).toHaveClass("todo-due-date");
    expect(dueDate).toHaveAttribute("datetime", "2027-03-15");
    expect(dueDate).toHaveAttribute("title", "截止日期：2027-03-15");
    expect(screen.queryByText("@20270315")).not.toBeInTheDocument();
  });

  it("returns to display mode immediately while a save is still pending", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | null = null;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(
      <TodoInlineContentEditor
        value="和税务对齐相关方案"
        editable
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "和税务对齐相关方案" }));

    const textbox = screen.getByRole("textbox");
    textbox.textContent = "同步法务最终意见";
    fireEvent.input(textbox);
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("同步法务最终意见");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步法务最终意见" })).toBeInTheDocument();

    resolveSave?.();
  });

  it("uses a wrapping textarea and saves without manual line breaks", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <TodoInlineContentEditor
        value="和税务对齐相关方案"
        editable
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "和税务对齐相关方案" }));

    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveAttribute("contenteditable", "true");

    textbox.textContent = "第一段 第二段";
    fireEvent.input(textbox);
    expect(screen.getByRole("textbox")).toHaveTextContent("第一段 第二段");

    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("第一段 第二段");
  });

  it("inserts internal reference tokens while editing and renders clickable chips in display mode", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenInternalReference = vi.fn(async () => true);
    const searchSpy = vi
      .spyOn(projectMindApi, "internalReferenceSearch")
      .mockResolvedValue([
        {
          kind: "todo",
          id: 18,
          label: "推进预算审批",
          projectId: 1,
          subtitle: "Alpha · Kickoff",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ]);

    const { container, rerender } = render(
      <TodoInlineContentEditor
        value="处理事项"
        editable
        onSave={onSave}
        internalReferenceContext={{ scope: "project", projectId: 1 }}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    await user.click(screen.getByRole("button", { name: "处理事项" }));
    const textbox = screen.getByRole("textbox");
    textbox.textContent = "";
    fireEvent.input(textbox);
    await user.keyboard("[[[[");
    expect(await screen.findByRole("option", { name: /Todo.*推进预算审批/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox")).toHaveTextContent("Todo推进预算审批");
    expect(container.querySelector(".internal-reference-chip--todo")).toBeTruthy();
    await user.type(screen.getByRole("textbox"), "很重要");

    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledWith("[[todo:18|推进预算审批]] 很重要");

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TodoInlineContentEditor
          value="处理 [[todo:18|推进预算审批]] 很重要"
          editable
          onSave={onSave}
          internalReferenceContext={{ scope: "project", projectId: 1 }}
          onOpenInternalReference={onOpenInternalReference}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("link", { name: /Todo.*推进预算审批/u }));

    expect(onOpenInternalReference).toHaveBeenCalledWith({
      refKind: "todo",
      refId: 18,
      label: "推进预算审批",
    });
    searchSpy.mockRestore();
  });

  it("supports contact mention insertion while editing", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const searchSpy = vi.spyOn(projectMindApi, "contactSearch").mockResolvedValue([
      {
        id: 7,
        name: "张三",
        pinyinFull: "zhang san",
        pinyinAbbr: "zs",
        email: "",
        employeeId: "",
        role: "",
        department: "",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:00:00.000Z",
      },
    ]);

    render(
      <TodoInlineContentEditor
        value="联系"
        editable
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "联系" }));
    await user.type(screen.getByRole("textbox"), " @zh");
    expect(await screen.findByRole("option", { name: /张三/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("联系 @[contact:7|张三]");
    searchSpy.mockRestore();
  });
});
