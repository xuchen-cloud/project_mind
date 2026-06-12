import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
});
