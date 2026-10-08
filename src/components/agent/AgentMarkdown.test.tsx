import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { openExternalUrl: mocks.open } }));
beforeEach(() => { mocks.open.mockReset().mockResolvedValue(undefined); });

it("renders real Markdown headings, lists, tables, code and links as reading nodes", () => {
  const { container } = render(<AgentMarkdown text={'# 阶段计划\n\n重点是 **核对** 和 *确认*。\n\n- 第一项\n- 第二项\n\n3. 第三步\n4. 第四步\n\n| 名称 | 状态 |\n| --- | --- |\n| 依据 | 已确认 |\n\n> 引用原文\n\n```ts\nconst value = "<script>";\n```\n\n[资料](https://example.test/source)'} />);
  expect(screen.getByRole("heading", { name: "阶段计划", level: 1 })).toBeInTheDocument();
  expect(container.querySelectorAll("li")).toHaveLength(4);
  expect(container.querySelector("ol")).toHaveAttribute("start", "3");
  expect(screen.getByRole("cell", { name: "依据" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "已确认" })).toBeInTheDocument();
  expect(container.querySelector("strong")).toHaveTextContent("核对");
  expect(container.querySelector("em")).toHaveTextContent("确认");
  expect(container.querySelector("blockquote")).toHaveTextContent("引用原文");
  expect(container.querySelector("pre code")).toHaveTextContent('const value = "<script>";');
  expect(screen.getByRole("link", { name: "资料" })).toHaveAttribute("href", "https://example.test/source");
  expect(mocks.open).not.toHaveBeenCalled();
});

it("keeps raw HTML and script inert and never creates image or other network-resource nodes", () => {
  const { container } = render(<AgentMarkdown text={'<script>window.pwned=true</script>\n\n<img src="https://track.test/raw.png" onerror="alert(1)">\n\n<iframe src="https://track.test/frame"></iframe>\n\n![依据图片](https://track.test/image.png)\n\n[危险](javascript:alert(1))\n\n[数据](data:text/html,evil)'} />);
  expect(container.querySelector("script,img,iframe,object,embed,svg,link,style")).toBeNull();
  expect(container.querySelector("[src],[onerror],[onclick]")).toBeNull();
  expect(container.textContent).toContain('<script>window.pwned=true</script>');
  expect(screen.getByText("[图片：依据图片，点击打开]")).toBeInTheDocument();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://track.test/image.png");
  expect(mocks.open).not.toHaveBeenCalled();
});

it("opens only explicit HTTP(S) links on user click through the desktop URL API", async () => {
  render(<AgentMarkdown text={'[安全资料](https://example.test/guide) [内页](/projects/7) [邮件](mailto:person@example.test)'} />);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(mocks.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "安全资料" }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.test/guide"));
});

it("keeps ordinary Chinese text readable and reports failed link opening without navigating", async () => {
  mocks.open.mockRejectedValueOnce(new Error("opener failed"));
  const { container } = render(<AgentMarkdown text={'普通文字，保留中文内容。\n\n[资料](http://example.test/)'} />);
  expect(container.querySelector("p")).toHaveTextContent("普通文字，保留中文内容。");
  fireEvent.click(screen.getByRole("link", { name: "资料" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("链接无法打开");
});


it("opens a Markdown image only as an explicit external-link click, never an image resource", async () => {
  const { container } = render(<AgentMarkdown text="![现场资料](https://example.test/evidence.png)" />);
  expect(container.querySelector("img,[src]")).toBeNull();
  expect(mocks.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "[图片：现场资料，点击打开]" }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.test/evidence.png"));
});
