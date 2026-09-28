import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../state/ui-store";
import { HomeWorkspaceRail } from "./HomeWorkspaceRail";

afterEach(() => vi.unstubAllGlobals());

it("hides the brand when tasks overflow, stays hidden with reclaimed space, and restores when they fit", async () => {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {} disconnect() {} unobserve() {}
  });
  useUiStore.setState({ todoRailCollapsed: false });
  const { container } = render(<HomeWorkspaceRail><div className="todo-rail__list-scroll"><div>Tasks</div></div></HomeWorkspaceRail>);
  const root = container.firstElementChild!;
  expect(root.querySelector(".home-brand small")).toHaveTextContent("— NoriMind");
  const list = root.querySelector<HTMLElement>(".todo-rail__list-scroll")!;
  const brand = root.querySelector<HTMLElement>(".home-brand")!;
  let contentHeight = 150;
  Object.defineProperty(list, "clientHeight", { get: () => root.hasAttribute("data-brand-hidden") ? 180 : 100 });
  Object.defineProperty(brand, "offsetHeight", { value: 80 });
  vi.spyOn(list.firstElementChild!, "getBoundingClientRect").mockImplementation(() => ({ bottom: contentHeight }) as DOMRect);
  act(() => callbacks.forEach((callback) => callback()));
  await waitFor(() => expect(root).toHaveAttribute("data-brand-hidden", "true"));
  act(() => callbacks.forEach((callback) => callback()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(root).toHaveAttribute("data-brand-hidden", "true");
  contentHeight = 60;
  act(() => callbacks.forEach((callback) => callback()));
  await waitFor(() => expect(root).not.toHaveAttribute("data-brand-hidden"));
  expect(root.querySelector(':scope > [role="separator"]')).toBeInTheDocument();
});
