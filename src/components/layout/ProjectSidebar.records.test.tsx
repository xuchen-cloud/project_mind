import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "../../state/ui-store";
import { ProjectSidebar } from "./ProjectSidebar";

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ProjectSidebar records", () => {
  beforeEach(() => {
    useUiStore.setState({
      createProjectOpen: false,
      settingsOpen: false,
      settingsSection: "page-width",
      settingsProjectId: null,
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
      openProjectIds: [],
      projectRecentPaths: {},
      noteEditorWidthPx: 880,
      pageWidthMode: "adaptive",
      todoRailWidthPx: 352,
      projectSidebarWidthPx: 288,
    });
  });

  it("calls onOpenRecord when a record title is clicked", async () => {
    const user = userEvent.setup();
    const onOpenRecord = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        activeRecordId={null}
        onOpenProject={vi.fn()}
        onOpenRecord={onOpenRecord}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    await user.click(screen.getByText("Kickoff Review"));
    expect(onOpenRecord).toHaveBeenCalledWith(11);
  });

  it("calls onFocusRecord when a record item is double clicked", () => {
    const onOpenRecord = vi.fn();
    const onFocusRecord = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        activeRecordId={null}
        onOpenProject={vi.fn()}
        onOpenRecord={onOpenRecord}
        onFocusRecord={onFocusRecord}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Kickoff Review").closest("button")!);

    expect(onFocusRecord).toHaveBeenCalledWith(11);
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it("uses controlled record search and tag filter props", async () => {
    const user = userEvent.setup();
    const onRecordQueryChange = vi.fn();
    const onActiveRecordTagIdChange = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [{ id: 7, label: "预算", colorKey: "amber" as const }],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        activeRecordId={null}
        recordQuery="kick"
        onRecordQueryChange={onRecordQueryChange}
        activeRecordTagId={7}
        onActiveRecordTagIdChange={onActiveRecordTagIdChange}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("搜索记录")).toHaveValue("kick");

    await user.type(screen.getByLabelText("搜索记录"), "off");
    expect(onRecordQueryChange).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "预算" }));
    expect(onActiveRecordTagIdChange).toHaveBeenCalledWith(null);
  });

  it("renames a record from the context menu", async () => {
    const user = userEvent.setup();
    const onRenameRecord = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            projectId: 1,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            contentHtml: "<p>记录内容</p>",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        activeRecordId={null}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onRenameRecord={onRenameRecord}
        onOpenDocument={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Kickoff Review"));
    await user.click(screen.getByRole("menuitem", { name: /重命名/ }));
    const input = screen.getByDisplayValue("Kickoff Review");
    await user.clear(input);
    await user.type(input, "Renamed Review{Enter}");

    expect(onRenameRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }),
      "Renamed Review",
    );
  });

  it("deletes a record from the context menu", async () => {
    const user = userEvent.setup();
    const onDeleteRecord = vi.fn();

    renderWithProviders(
      <ProjectSidebar
        project={{
          id: 1,
          name: "Alpha Project",
          rootPath: "/tmp/alpha-project",
          isArchived: false,
        }}
        records={[
          {
            id: 11,
            title: "Kickoff Review",
            typeLabel: "会议记录",
            contentMarkdown: "记录内容",
            tags: [],
            updatedAt: "2026-04-06T08:00:00.000Z",
          },
        ]}
        documents={[]}
        activeRecordId={null}
        onOpenProject={vi.fn()}
        onOpenRecord={vi.fn()}
        onCreateRecord={vi.fn()}
        onDeleteRecord={onDeleteRecord}
        onOpenDocument={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Kickoff Review"));
    await user.click(screen.getByRole("menuitem", { name: /删除/ }));

    expect(onDeleteRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }));
  });
});
