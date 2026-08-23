import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SidebarFilters, SidebarTabs } from "./SidebarChoiceGroup";

describe("SidebarTabs", () => {
  it("exposes the selected view as the only tab in the roving tab stop", () => {
    render(
      <SidebarTabs
        ariaLabel="项目侧边栏视图"
        value="records"
        options={[
          { value: "records", label: "记录" },
          { value: "files", label: "文件" },
        ]}
        onValueChange={vi.fn()}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "项目侧边栏视图" });
    const recordsTab = screen.getByRole("tab", { name: "记录" });
    const filesTab = screen.getByRole("tab", { name: "文件" });

    expect(tablist).toContainElement(recordsTab);
    expect(tablist).toContainElement(filesTab);
    expect(recordsTab).toHaveAttribute("aria-selected", "true");
    expect(recordsTab).toHaveAttribute("tabindex", "0");
    expect(filesTab).toHaveAttribute("aria-selected", "false");
    expect(filesTab).toHaveAttribute("tabindex", "-1");
  });

  it("moves selection and focus to the next tab with ArrowRight", async () => {
    const user = userEvent.setup();

    function ProjectViews() {
      const [value, setValue] = useState("records");
      return (
        <SidebarTabs
          ariaLabel="项目侧边栏视图"
          value={value}
          options={[
            { value: "records", label: "记录" },
            { value: "files", label: "文件" },
          ]}
          onValueChange={setValue}
        />
      );
    }

    render(<ProjectViews />);
    const recordsTab = screen.getByRole("tab", { name: "记录" });
    const filesTab = screen.getByRole("tab", { name: "文件" });
    recordsTab.focus();

    await user.keyboard("{ArrowRight}");

    expect(filesTab).toHaveFocus();
    expect(filesTab).toHaveAttribute("aria-selected", "true");
    expect(filesTab).toHaveAttribute("tabindex", "0");
    expect(recordsTab).toHaveAttribute("tabindex", "-1");
  });

  it("wraps with ArrowLeft and jumps with Home and End", async () => {
    const user = userEvent.setup();

    function WorkspaceViews() {
      const [value, setValue] = useState("records");
      return (
        <SidebarTabs
          ariaLabel="工作区侧边栏视图"
          value={value}
          options={[
            { value: "projects", label: "项目" },
            { value: "records", label: "记录" },
            { value: "archive", label: "归档" },
          ]}
          onValueChange={setValue}
        />
      );
    }

    render(<WorkspaceViews />);
    const projectsTab = screen.getByRole("tab", { name: "项目" });
    const recordsTab = screen.getByRole("tab", { name: "记录" });
    const archiveTab = screen.getByRole("tab", { name: "归档" });
    recordsTab.focus();

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(archiveTab).toHaveFocus();
    expect(archiveTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(projectsTab).toHaveFocus();
    expect(projectsTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(archiveTab).toHaveFocus();
    expect(archiveTab).toHaveAttribute("aria-selected", "true");
  });
});

describe("SidebarFilters", () => {
  it("exposes selection and clears an active tag back to the fallback filter", async () => {
    const user = userEvent.setup();

    function RecordTags() {
      const [value, setValue] = useState<number | null>(2);
      return (
        <SidebarFilters
          ariaLabel="记录标签筛选"
          value={value}
          options={[
            { value: 2, label: "设计" },
          ]}
          onValueChange={setValue}
        />
      );
    }

    render(<RecordTags />);
    const allFilter = screen.getByRole("button", { name: "全部" });
    const designFilter = screen.getByRole("button", { name: "设计" });
    expect(allFilter).toHaveAttribute("aria-pressed", "false");
    expect(designFilter).toHaveAttribute("aria-pressed", "true");

    await user.click(designFilter);

    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(designFilter).toHaveAttribute("aria-pressed", "false");
  });
});
