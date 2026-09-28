import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EntityTagEditor } from "./EntityTagEditor";

const apiMocks = vi.hoisted(() => ({
  projectTagUpsert: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

describe("EntityTagEditor", () => {
  beforeEach(() => {
    apiMocks.projectTagUpsert.mockReset();
  });

  it("uses the same hash chip in display and edit modes, with removal only when editing", () => {
    const tags = [{ id: 7, label: "人生意义", colorKey: "red" as const }];
    const { rerender, container } = render(<EntityTagEditor tags={tags} availableTags={[]} mode="display" onChange={vi.fn()} />);
    expect(container.querySelector(".entity-tag-chip")?.textContent).toBe("#人生意义");
    expect(screen.queryByRole("button", { name: "移除标签 人生意义" })).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    rerender(<EntityTagEditor tags={tags} availableTags={[]} mode="full" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "移除标签 人生意义" })).toHaveClass("entity-tag-chip");
    expect(screen.getByPlaceholderText("新增标签").closest("label")).toHaveClass("entity-tag-chip");
  });

  it("renders recommendations outside the clipping card and keeps selection working", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<div style={{ overflow: "clip", isolation: "isolate" }}>
      <EntityTagEditor availableTags={[{ id: 7, label: "人生意义", colorKey: "red", usageCount: 0, createdAt: "", updatedAt: "" }]}
        tags={[]} onChange={onChange} />
    </div>);
    await user.type(screen.getByPlaceholderText("新增标签"), "人");
    const suggestion = screen.getByRole("button", { name: "人生意义" });
    expect(container.contains(suggestion)).toBe(false);
    await user.click(suggestion);
    expect(onChange).toHaveBeenCalledWith([7]);
    expect(apiMocks.projectTagUpsert).not.toHaveBeenCalled();
  });

  it("creates workspace-scoped tags with a null project id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreated = vi.fn();
    apiMocks.projectTagUpsert.mockResolvedValueOnce({
      id: 7,
      label: "预算",
      colorKey: "amber",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    });

    render(
      <EntityTagEditor
        projectId={null}
        availableTags={[]}
        tags={[]}
        onChange={onChange}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByPlaceholderText("新增标签"), "预算{Enter}");

    await waitFor(() => {
      expect(apiMocks.projectTagUpsert).toHaveBeenCalledWith({
        projectId: null,
        label: "预算",
        colorKey: "amber",
      });
    });
    expect(onChange).toHaveBeenCalledWith([7]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 7, label: "预算" }));
  });

  it("commits a tag with Tab and keeps focus on the tag input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommitNavigation = vi.fn();
    apiMocks.projectTagUpsert.mockResolvedValueOnce({
      id: 8,
      label: "合同",
      colorKey: "blue",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    });

    render(
      <EntityTagEditor
        projectId={1}
        availableTags={[]}
        tags={[]}
        onChange={onChange}
        onCommitNavigation={onCommitNavigation}
      />,
    );

    const input = screen.getByPlaceholderText("新增标签");
    await user.type(input, "合同{Tab}");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([8]);
    });
    expect(onCommitNavigation).toHaveBeenCalledWith("tab");
    expect(input).toHaveFocus();
  });

  it("commits a tag with Enter and requests enter navigation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommitNavigation = vi.fn();
    apiMocks.projectTagUpsert.mockResolvedValueOnce({
      id: 9,
      label: "复盘",
      colorKey: "teal",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    });

    render(
      <EntityTagEditor
        projectId={1}
        availableTags={[]}
        tags={[]}
        onChange={onChange}
        onCommitNavigation={onCommitNavigation}
      />,
    );

    await user.type(screen.getByPlaceholderText("新增标签"), "复盘{Enter}");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([9]);
    });
    expect(onCommitNavigation).toHaveBeenCalledWith("enter");
  });

  it("does not navigate when Tag creation fails", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommitNavigation = vi.fn();
    const onCommitSettled = vi.fn();
    apiMocks.projectTagUpsert.mockRejectedValueOnce(new Error("保存失败"));

    render(
      <EntityTagEditor
        projectId={1}
        availableTags={[]}
        tags={[]}
        onChange={onChange}
        onCommitNavigation={onCommitNavigation}
        onCommitSettled={onCommitSettled}
      />,
    );

    await user.type(screen.getByPlaceholderText("新增标签"), "失败标签{Enter}");

    await waitFor(() =>
      expect(onCommitSettled).toHaveBeenCalledWith(expect.objectContaining({ message: "保存失败" })),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommitNavigation).not.toHaveBeenCalled();
  });

  it("keeps empty Tab as normal browser focus navigation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommitNavigation = vi.fn();

    render(
      <>
        <EntityTagEditor
          projectId={1}
          availableTags={[]}
          tags={[]}
          onChange={onChange}
          onCommitNavigation={onCommitNavigation}
        />
        <button type="button">下一个控件</button>
      </>,
    );

    screen.getByPlaceholderText("新增标签").focus();
    await user.keyboard("{Tab}");

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommitNavigation).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "下一个控件" })).toHaveFocus();
  });
});
