import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ContactRecord } from "../../lib/types";

const mocks = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn(), upsert: vi.fn(), remove: vi.fn(), status: vi.fn(), toast: vi.fn() }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { contactList: mocks.list, contactSearch: mocks.search, contactUpsert: mocks.upsert, contactDelete: mocks.remove } }));
vi.mock("../../state/feedback-store", () => ({ useFeedbackStore: () => ({ setStatus: mocks.status, pushToast: mocks.toast }) }));
import { ContactSettingsPanel } from "./ContactSettingsPanel";

const contact: ContactRecord = { id: 7, name: "王明", nicknames: "王总;老王,客户|供应商", notes: "第一行备注\n第二行备注", revision: 3,
  pinyinFull: "wangming", pinyinAbbr: "wm", email: "wang@example.com", employeeId: "007", role: "经理", department: "客户部", createdAt: "2026-10-29", updatedAt: "2026-10-29" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue([]);
  mocks.search.mockResolvedValue([]);
  mocks.upsert.mockImplementation(async (input) => ({ ...contact, ...input, revision: 4 }));
});

function panel(open = true, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const result = render(<QueryClientProvider client={client}><ContactSettingsPanel open={open} /></QueryClientProvider>);
  return { ...result, client };
}

it("creates a contact with semicolon nicknames, literal comma/pipe and multiline notes", async () => {
  const user = userEvent.setup();
  panel();
  await user.click(await screen.findByRole("button", { name: "新建联系人" }));
  await user.type(screen.getByPlaceholderText("姓名（必填）"), "李四");
  await user.type(screen.getByRole("textbox", { name: "昵称" }), "老李；Lee,销售|合作方;李经理");
  await user.type(screen.getByRole("textbox", { name: "备注" }), "负责销售\n周五联系");
  expect(screen.getByText(/中文分号/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "创建联系人" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ name: "李四", nicknames: "老李；Lee,销售|合作方;李经理", notes: "负责销售\n周五联系" }), expect.anything()));
});

it("preserves nicknames and multiline notes when editing only an old field", async () => {
  const user = userEvent.setup();
  mocks.list.mockResolvedValue([contact]);
  panel();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  expect(screen.getByRole("textbox", { name: "昵称" })).toHaveValue(contact.nicknames);
  expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue(contact.notes);
  await user.clear(screen.getByRole("textbox", { name: "邮箱" }));
  await user.type(screen.getByRole("textbox", { name: "邮箱" }), "new@example.com");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: contact.id, baseRevision: contact.revision, email: "new@example.com", nicknames: contact.nicknames, notes: contact.notes }), expect.anything()));
});

it("refreshes both name and nickname pinyin when the edited contact is saved", async () => {
  const user = userEvent.setup();
  mocks.list.mockResolvedValue([contact]);
  panel();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  await user.clear(screen.getByRole("textbox", { name: "姓名" }));
  await user.type(screen.getByRole("textbox", { name: "姓名" }), "张三");
  await user.clear(screen.getByRole("textbox", { name: "昵称" }));
  await user.type(screen.getByRole("textbox", { name: "昵称" }), "老张;重庆");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
    id: contact.id, baseRevision: 3, name: "张三", nicknames: "老张;重庆", email: contact.email,
    pinyinFull: "zhangsan", pinyinAbbr: "zs", nicknamePinyin: "laozhang lz chongqing cq",
  }), expect.anything()));
});

it("keeps the draft and its captured revision when a CLI update refreshes the list during editing", async () => {
  const user = userEvent.setup();
  mocks.list.mockResolvedValue([contact]);
  const { client } = panel();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  await user.clear(screen.getByRole("textbox", { name: "邮箱" }));
  await user.type(screen.getByRole("textbox", { name: "邮箱" }), "my-draft@example.com");
  client.setQueryData(["contacts", "all"], [{ ...contact, revision: 4, nicknames: "CLI新昵称", notes: "CLI新备注" }]);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "邮箱" })).toHaveValue("my-draft@example.com"));
  expect(screen.getByRole("textbox", { name: "昵称" })).toHaveValue(contact.nicknames);
  expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue(contact.notes);
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 3, email: "my-draft@example.com", nicknames: contact.nicknames, notes: contact.notes }), expect.anything()));
});

it("keeps a conflicting draft while explicitly re-reading the latest contact, never rebasing it automatically", async () => {
  const user = userEvent.setup();
  let stored = contact;
  mocks.list.mockImplementation(async () => [stored]);
  mocks.upsert.mockImplementation(async (input) => {
    if (input.baseRevision !== stored.revision) throw new Error("REVISION_CONFLICT: Contact changed");
    stored = { ...stored, ...input, revision: stored.revision + 1 };
    return stored;
  });
  panel();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  await user.clear(screen.getByRole("textbox", { name: "邮箱" }));
  await user.type(screen.getByRole("textbox", { name: "邮箱" }), "my-draft@example.com");
  stored = { ...contact, revision: 4, nicknames: "CLI新昵称", notes: "CLI新备注" };
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("草稿已保留");
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "联系人已被修改", detail: expect.stringContaining("重新读取") }));
  expect(stored.email).toBe(contact.email);
  expect(screen.getByRole("textbox", { name: "邮箱" })).toHaveValue("my-draft@example.com");
  await user.click(screen.getByRole("button", { name: "重新读取最新资料" }));
  const latest = await screen.findByRole("group", { name: "最新联系人资料" });
  expect(within(latest).getByText("CLI新昵称")).toBeInTheDocument();
  expect(within(latest).getByText("CLI新备注")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "昵称" })).toHaveValue(contact.nicknames);
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(2));
  expect(mocks.upsert.mock.calls[1][0].baseRevision).toBe(3);
  expect(stored.revision).toBe(4);
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  expect(screen.getByRole("textbox", { name: "昵称" })).toHaveValue("CLI新昵称");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert.mock.calls[2][0].baseRevision).toBe(4));
});

it("keeps the editor when a CLI change removes the contact from the active backend search", async () => {
  const user = userEvent.setup();
  mocks.search.mockResolvedValue([contact]);
  const { client } = panel();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索联系人" }), { target: { value: "老王" } });
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  await user.type(screen.getByRole("textbox", { name: "备注" }), "我的补充草稿");
  client.setQueryData(["contacts", "search", "老王"], []);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue(`${contact.notes}我的补充草稿`));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 3, notes: `${contact.notes}我的补充草稿` }), expect.anything()));
});

it("searches through the backend before the initial full list finishes, keeping the search and composer usable", async () => {
  mocks.list.mockImplementation(() => new Promise(() => {}));
  mocks.search.mockResolvedValue([contact]);
  panel();
  const search = screen.getByRole("searchbox", { name: "搜索联系人" });
  expect(search).toBeEnabled();
  expect(screen.getByRole("button", { name: "新建联系人" })).toBeEnabled();
  fireEvent.change(search, { target: { value: "老王 客户部" } });
  await waitFor(() => expect(mocks.search).toHaveBeenCalledWith({ query: "老王 客户部", limit: 100 }));
  expect(await screen.findByText("王明")).toBeInTheDocument();
  expect(search).toHaveValue("老王 客户部");
});

it("clears search back to contactList and lets a failed search retry without hiding the input", async () => {
  mocks.search.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([contact]);
  panel();
  await screen.findByText(/还没有联系人/);
  const search = screen.getByRole("searchbox", { name: "搜索联系人" });
  fireEvent.change(search, { target: { value: "备注 客户" } });
  expect(await screen.findByText("搜索联系人失败，请重试。")).toBeInTheDocument();
  expect(search).toHaveValue("备注 客户");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("王明")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "   " } });
  expect(await screen.findByText(/还没有联系人/)).toBeInTheDocument();
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  expect(mocks.search.mock.calls.every(([input]) => input.query === "备注 客户")).toBe(true);
});

it("keeps unsaved nickname and notes edits available when saving fails", async () => {
  const user = userEvent.setup();
  mocks.list.mockResolvedValue([contact]);
  mocks.upsert.mockRejectedValue(new Error("save failed"));
  panel();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  await user.clear(screen.getByRole("textbox", { name: "昵称" }));
  await user.type(screen.getByRole("textbox", { name: "昵称" }), "新昵称；Other,alias|名称");
  await user.clear(screen.getByRole("textbox", { name: "备注" }));
  await user.type(screen.getByRole("textbox", { name: "备注" }), "新备注\n多行保留");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "保存联系人失败" })));
  expect(screen.getByRole("textbox", { name: "昵称" })).toHaveValue("新昵称；Other,alias|名称");
  expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue("新备注\n多行保留");
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
});

it("uses the shared continuous edge fades for the bounded contact list and keeps the search outside it", async () => {
  mocks.list.mockResolvedValue([contact]);
  panel();
  await screen.findByText("王明");
  const list = screen.getByRole("region", { name: "联系人列表" });
  const frame = list.parentElement!;
  expect(frame).not.toContainElement(screen.getByRole("searchbox", { name: "搜索联系人" }));
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 300 } });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 32 } });
  expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0.5");
  fireEvent.scroll(list, { target: { scrollTop: 200 } });
  expect(list).not.toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 168 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 100 });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).not.toHaveAttribute("data-overflow-bottom");
});
