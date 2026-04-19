import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { projectMindApi } from "../../services/projectMindApi";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";

describe("TodoInlineContentEditor", () => {
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
          activityId: 2,
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
      <TodoInlineContentEditor
        value="处理 [[todo:18|推进预算审批]] 很重要"
        editable
        onSave={onSave}
        internalReferenceContext={{ scope: "project", projectId: 1 }}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    await user.click(screen.getByRole("link", { name: /Todo.*推进预算审批/u }));

    expect(onOpenInternalReference).toHaveBeenCalledWith({
      refKind: "todo",
      refId: 18,
      label: "推进预算审批",
    });
    searchSpy.mockRestore();
  });
});
