import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceWindowSizeConstraints } from "./useWorkspaceWindowSizeConstraints";

function ResponsivePanelsHarness() {
  const [projectSidebarCollapsed, setProjectSidebarCollapsed] = useState(false);
  const [todoRailCollapsed, setTodoRailCollapsed] = useState(true);

  useWorkspaceWindowSizeConstraints({
    showProjectSidebar: true,
    projectSidebarCollapsed,
    projectSidebarWidthPx: 420,
    showTodoRail: true,
    todoRailCollapsed,
    todoRailWidthPx: 440,
    setProjectSidebarCollapsed,
    setTodoRailCollapsed,
  });

  return (
    <div>
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
});
