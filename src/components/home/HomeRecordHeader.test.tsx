import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HomeRecordHeader } from "./HomeRecordHeader";

vi.mock("./HomeCover", () => ({
  HomeCover: ({ title }: { title: ReactNode }) => <header className="home-cover"><div className="home-cover__identity"><div className="home-cover__title">{title}</div></div></header>,
  HomeIdentityIcon: () => <svg aria-hidden="true" />,
  ProjectHomeIcon: () => <svg aria-hidden="true" />,
}));

it.each([
  { scopeName: "我的工作区", projectRoot: undefined, showCover: true },
  { scopeName: "我的工作区", projectRoot: undefined, showCover: false },
  { scopeName: "设计项目", projectRoot: "/project", showCover: false },
])("keeps $scopeName navigation available before and after docking", ({ scopeName, projectRoot, showCover }) => {
  const onOpenHome = vi.fn();
  const { container } = render(<div className="project-overview-focus__scroll">
    <HomeRecordHeader identityKey={scopeName} scopeName={scopeName} title="当前笔记" projectRoot={projectRoot} showCover={showCover} onOpenHome={onOpenHome}>
      <input aria-label="笔记标题" defaultValue="当前笔记" />
    </HomeRecordHeader>
  </div>);
  expect(container.querySelector(".home-cover") !== null).toBe(showCover);
  const cover = container.querySelector<HTMLElement>(showCover ? ".home-cover__identity" : ".home-record-header")!;
  const rect = vi.spyOn(cover, "getBoundingClientRect");
  rect.mockReturnValue({ top: 120, left: 0, width: 600 } as DOMRect);
  fireEvent.scroll(container.firstElementChild!);
  fireEvent.click(screen.getByRole("button", { name: `返回${scopeName}主页` }));
  expect(onOpenHome).toHaveBeenCalledTimes(1);
  rect.mockReturnValue({ top: -10, left: 0, width: 600 } as DOMRect);
  fireEvent.scroll(container.firstElementChild!);
  expect(screen.getByRole("heading", { name: "当前笔记" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: `返回${scopeName}主页` }));
  expect(onOpenHome).toHaveBeenCalledTimes(2);
  rect.mockReturnValue({ top: 120, left: 0, width: 600 } as DOMRect);
  fireEvent.scroll(container.firstElementChild!);
  fireEvent.click(screen.getByRole("button", { name: `返回${scopeName}主页` }));
  expect(onOpenHome).toHaveBeenCalledTimes(3);
  rect.mockRestore();
});
