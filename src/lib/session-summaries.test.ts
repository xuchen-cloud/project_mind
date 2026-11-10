import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { refreshSessionSummaries, sessionSummariesQueryOptions } from "./session-summaries";

const native = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../services/desktopApi", () => ({ desktopApi: native }));
const binding = { workspaceId: "workspace-a", generation: "open-1" };
const page = { revision: "r1", items: [{ id: "a", title: "Alpha", running: false, pinned: false }] };
beforeEach(() => native.command.mockReset().mockResolvedValue(page));

it("shares hover/sidebar reads and reuses fresh summaries without execution readiness", async () => {
  const client = new QueryClient();
  const options = sessionSummariesQueryOptions(binding, 7);
  const [hover, sidebar] = await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
  expect(hover).toEqual(page);
  expect(sidebar).toEqual(page);
  await client.fetchQuery(options);
  expect(native.command.mock.calls).toEqual([["dsh_assistant_session_summaries", { projectId: 7, expectedBinding: binding }]]);
  client.clear();
});

it("keeps a late closed Workspace response out of a reopened generation", async () => {
  let finish!: (result: typeof page) => void;
  native.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient();
  const oldOptions = sessionSummariesQueryOptions(binding, 7);
  const old = client.fetchQuery(oldOptions);
  client.removeQueries({ queryKey: ["agent"] });
  const current = sessionSummariesQueryOptions({ ...binding, generation: "open-2" }, 7);
  const fresh = { ...page, revision: "r2", items: [{ ...page.items[0], title: "New" }] };
  native.command.mockResolvedValueOnce(fresh);
  await client.fetchQuery(current);
  finish(page);
  await old.catch(() => {});
  expect(client.getQueryData(oldOptions.queryKey)).toBeUndefined();
  expect(client.getQueryData(current.queryKey)).toEqual(fresh);
  client.clear();
});

it("keeps Project and Workspace summary requests distinct", async () => {
  const client = new QueryClient();
  await Promise.all([client.fetchQuery(sessionSummariesQueryOptions(binding, null)), client.fetchQuery(sessionSummariesQueryOptions(binding, 7))]);
  expect(native.command.mock.calls.map(call => call[1].projectId)).toEqual([null, 7]);
  client.clear();
});


it("coalesces one change notification and supersedes a read after a later mutation", async () => {
  const client = new QueryClient();
  const options = sessionSummariesQueryOptions(binding, 7);
  await client.fetchQuery(options);
  let finish!: (result: typeof page) => void;
  native.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = refreshSessionSummaries(client, binding, 7);
  expect(refreshSessionSummaries(client, binding, 7)).toBe(first);
  await vi.waitFor(() => expect(native.command).toHaveBeenCalledTimes(2));
  const newer = { ...page, revision: "r2", items: [{ ...page.items[0], title: "After second rename" }] };
  native.command.mockResolvedValueOnce(newer);
  const later = refreshSessionSummaries(client, binding, 7);
  await later;
  expect(native.command).toHaveBeenCalledTimes(3);
  finish(page);
  await first;
  expect(client.getQueryData(options.queryKey)).toEqual(newer);
  client.clear();
});
