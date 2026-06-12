import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bold, Copy, Trash2 } from "lucide-react";
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

  it("opens a submenu and runs nested actions", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNestedSelect = vi.fn();

    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        onClose={onClose}
        actions={[
          {
            type: "submenu",
            key: "format",
            label: "格式",
            actions: [
              {
                key: "bold",
                label: "加粗",
                icon: Copy,
                onSelect: onNestedSelect,
              },
            ],
          },
        ]}
      />,
    );

    await user.hover(screen.getByRole("menuitem", { name: "格式" }));
    await user.click(await screen.findByRole("menuitem", { name: "加粗" }));

    expect(onNestedSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders featured rows, selected state, and inline action groups", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onBold = vi.fn();

    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        onClose={onClose}
        actions={[
          {
            type: "submenu",
            key: "block",
            label: "正文",
            icon: Copy,
            featured: true,
            selected: true,
            actions: [
              {
                key: "paragraph",
                label: "正文",
                icon: Copy,
                selected: true,
                onSelect: vi.fn(),
              },
            ],
          },
          { type: "separator", key: "separator-1" },
          {
            type: "inline-actions",
            key: "inline-format",
            ariaLabel: "文本格式",
            actions: [
              {
                key: "bold",
                label: "加粗",
                icon: Bold,
                active: true,
                onSelect: onBold,
              },
            ],
          },
        ]}
      />,
    );

    const featuredItem = screen.getByRole("menuitem", { name: "正文" });
    expect(featuredItem.dataset.featured).toBe("true");
    expect(featuredItem.dataset.selected).toBe("true");
    expect(screen.getByRole("group", { name: "文本格式" })).toBeInTheDocument();

    const boldButton = screen.getByRole("button", { name: "加粗" });
    expect(boldButton.className).toContain("context-menu__inline-action");

    await user.click(boldButton);
    expect(onBold).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus when autoFocus is disabled", () => {
    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        autoFocus={false}
        onClose={vi.fn()}
        actions={[
          {
            key: "copy",
            label: "复制",
            icon: Copy,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    expect(screen.getByRole("menu", { name: "测试菜单" })).not.toHaveFocus();
  });
});
