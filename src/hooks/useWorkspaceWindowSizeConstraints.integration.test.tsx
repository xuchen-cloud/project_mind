import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceWindowSizeConstraints } from "./useWorkspaceWindowSizeConstraints";

function ResponsivePanelsHarness({ floating = false }: { floating?: boolean }) {
  const [projectSidebarCollapsed, setProjectSidebarCollapsed] = useState(false);
  const [todoRailCollapsed, setTodoRailCollapsed] = useState(true);
  const [pinned, setPinned] = useState(!floating);

  useWorkspaceWindowSizeConstraints({
    overlayHomePanels: true,
    showProjectSidebar: true,
    projectSidebarCollapsed,
    projectSidebarWidthPx: 420,
    showTodoRail: pinned,
    todoRailCollapsed,
    todoRailWidthPx: 440,
    setProjectSidebarCollapsed,
    setTodoRailCollapsed,
  });

  return (
    <div>
      <button type="button" onClick={() => setPinned(true)}>固定右栏</button>
      {projectSidebarCollapsed ? null : <aside data-testid="project-sidebar" />}
      {todoRailCollapsed ? (
        <button type="button" onClick={() => setTodoRailCollapsed(false)}>
          展开 Todo Rail
        </button>
      ) : (
        <aside data-testid="todo-rail" />
      )}
    </div>
  );
}

describe("useWorkspaceWindowSizeConstraints panel intent", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("keeps an explicitly opened Todo Rail visible by yielding the other sidebar", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1180,
    });
    render(<ResponsivePanelsHarness />);

    fireEvent.click(screen.getByRole("button", { name: "展开 Todo Rail" }));

    expect(screen.getByTestId("todo-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("project-sidebar")).not.toBeInTheDocument();
  });

  it("keeps a newly pinned rail visible by yielding the left sidebar", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1180 });
    render(<ResponsivePanelsHarness floating />);
    fireEvent.click(screen.getByRole("button", { name: "展开 Todo Rail" }));
    expect(screen.getByTestId("project-sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "固定右栏" }));
    expect(screen.getByTestId("todo-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("project-sidebar")).not.toBeInTheDocument();
  });

  it("does not collapse a floating rail when the viewport narrows", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1180 });
    render(<ResponsivePanelsHarness floating />);
    fireEvent.click(screen.getByRole("button", { name: "展开 Todo Rail" }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("todo-rail")).toBeInTheDocument();
  });
});
