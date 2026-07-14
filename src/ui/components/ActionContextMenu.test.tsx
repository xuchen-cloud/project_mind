import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bold, Copy, Trash2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionContextMenu } from "./ActionContextMenu";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("closes on scroll, resize, and window blur", () => {
    const onClose = vi.fn();

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
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.blur(window);
    expect(onClose).toHaveBeenCalledTimes(3);
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

    const { container } = render(
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
    expect(container.querySelector(".context-menu__panel")?.className).toContain("w-[11rem]");
    expect(featuredItem.dataset.featured).toBe("true");
    expect(featuredItem.dataset.selected).toBe("true");
    expect(screen.getByRole("group", { name: "文本格式" })).toBeInTheDocument();

    const boldButton = screen.getByRole("button", { name: "加粗" });
    expect(boldButton.className).toContain("context-menu__inline-action");
    expect(boldButton.className).toContain("aspect-square");
    expect(boldButton.className).toContain("w-full");
    expect(boldButton.querySelector("svg")).toHaveAttribute("width", "12");
    expect(boldButton.querySelector("svg")).toHaveAttribute("height", "12");

    await user.click(boldButton);
    expect(onBold).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders scroll action groups with constrained height", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        onClose={onClose}
        actions={[
          {
            type: "scroll-actions",
            key: "skills",
            ariaLabel: "AI 技能列表",
            maxVisibleItems: 3,
            actions: Array.from({ length: 6 }, (_, index) => ({
              key: `skill-${index}`,
              label: `技能 ${index + 1}`,
              onSelect,
            })),
          },
        ]}
      />,
    );

    const group = screen.getByRole("group", { name: "AI 技能列表" });
    expect(group).toHaveStyle({ maxHeight: "84px" });
    expect(screen.getByRole("menuitem", { name: "技能 6" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "技能 6" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when a scroll action group is scrolled", () => {
    const onClose = vi.fn();

    render(
      <ActionContextMenu
        x={24}
        y={32}
        ariaLabel="测试菜单"
        onClose={onClose}
        actions={[
          {
            type: "scroll-actions",
            key: "skills",
            ariaLabel: "AI 技能列表",
            maxVisibleItems: 3,
            actions: Array.from({ length: 6 }, (_, index) => ({
              key: `skill-${index}`,
              label: `技能 ${index + 1}`,
              onSelect: vi.fn(),
            })),
          },
        ]}
      />,
    );

    fireEvent.scroll(screen.getByRole("group", { name: "AI 技能列表" }));

    expect(onClose).not.toHaveBeenCalled();
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

  it("opens submenus to the left near the right viewport edge", async () => {
    const user = userEvent.setup();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 700,
    });

    render(
      <ActionContextMenu
        x={650}
        y={32}
        ariaLabel="测试菜单"
        onClose={vi.fn()}
        actions={[
          {
            type: "submenu",
            key: "format",
            label: "格式",
            actions: [
              {
                key: "bold",
                label: "加粗",
                icon: Bold,
                onSelect: vi.fn(),
              },
            ],
          },
        ]}
      />,
    );

    const menu = screen.getByRole("menu", { name: "测试菜单" });
    const formatItem = screen.getByRole("menuitem", { name: "格式" });
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(rect({ left: 392, top: 32, right: 688, bottom: 80 }));
    vi.spyOn(formatItem, "getBoundingClientRect").mockReturnValue(rect({ left: 404, top: 40, right: 688, bottom: 78 }));

    await user.hover(formatItem);

    const submenu = await screen.findByRole("menu", { name: "格式 子菜单" });
    const submenuWrapper = submenu.closest(".context-menu__submenu-panel")?.parentElement as HTMLElement;
    expect(submenuWrapper.style.right).toBe("calc(100% + 5px)");
    expect(submenuWrapper.style.left).toBe("");
  });

  it("shifts submenus upward near the bottom viewport edge", async () => {
    const user = userEvent.setup();

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 260,
    });

    render(
      <ActionContextMenu
        x={24}
        y={180}
        ariaLabel="测试菜单"
        onClose={vi.fn()}
        actions={[
          {
            type: "submenu",
            key: "style",
            label: "样式",
            actions: Array.from({ length: 8 }, (_, index) => ({
              key: `style-${index}`,
              label: `样式 ${index + 1}`,
              onSelect: vi.fn(),
            })),
          },
        ]}
      />,
    );

    const menu = screen.getByRole("menu", { name: "测试菜单" });
    const styleItem = screen.getByRole("menuitem", { name: "样式" });
    Object.defineProperty(styleItem, "offsetTop", {
      configurable: true,
      value: 120,
    });
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(rect({ left: 24, top: 180, right: 320, bottom: 230 }));
    vi.spyOn(styleItem, "getBoundingClientRect").mockReturnValue(rect({ left: 32, top: 196, right: 300, bottom: 234 }));

    await user.hover(styleItem);

    const submenu = await screen.findByRole("menu", { name: "样式 子菜单" });
    const submenuWrapper = submenu.closest(".context-menu__submenu-panel")?.parentElement as HTMLElement;
    expect(Number.parseFloat(submenuWrapper.style.top)).toBeLessThan(112);
  });
});

function rect({
  left,
  top,
  right,
  bottom,
}: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => {},
  } as DOMRect;
}
