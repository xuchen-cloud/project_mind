import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Copy, Trash2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { ActionContextMenu } from "./ActionContextMenu";

describe("ActionContextMenu", () => {
  it("renders separators, focuses the menu container, and supports keyboard navigation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCopy = vi.fn();
    const onDelete = vi.fn();

    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        onClose={onClose}
        actions={[
          {
            key: "copy",
            label: "复制",
            icon: Copy,
            shortcut: "Mod+C",
            onSelect: onCopy,
          },
          {
            key: "disabled",
            label: "不可用项",
            disabled: true,
            onSelect: vi.fn(),
          },
          { type: "separator", key: "separator-1" },
          {
            key: "delete",
            label: "删除",
            icon: Trash2,
            tone: "danger",
            onSelect: onDelete,
          },
        ]}
      />,
    );

    const menu = screen.getByRole("menu", { name: "测试菜单" });
    const copyItem = screen.getByRole("menuitem", { name: /复制/i });
    const deleteItem = screen.getByRole("menuitem", { name: /删除/i });

    expect(menu).toHaveFocus();
    expect(copyItem.className).toContain("context-menu__item");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(deleteItem.className).toContain("text-danger");

    await user.keyboard("{ArrowDown}");
    expect(copyItem).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(deleteItem).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(copyItem).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("closes on escape and outside click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <div>
        <button type="button">outside</button>
        <ActionContextMenu
          x={24}
          y={32}
          ariaLabel="测试菜单"
          onClose={onClose}
          actions={[
            {
              key: "copy",
              label: "复制",
              icon: Copy,
              onSelect: vi.fn(),
            },
          ]}
        />
      </div>,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
