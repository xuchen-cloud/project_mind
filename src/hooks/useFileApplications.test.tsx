import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { fileApplicationOptions, usePrefetchFileApplications } from "./useFileApplications";
import { projectFileApi } from "../services/projectFileApi";

vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(async () => ({ workspaceId: "w", generation: "g" })) } }));
vi.mock("../services/projectFileApi", () => ({ projectFileApi: { applications: vi.fn(async () => [{ id: "viewer", name: "Viewer", icon: null, isDefault: true }]) } }));

it("prefetches each file type once before opening content and keeps extensionless names separate", async () => {
  const client = new QueryClient();
  const documents = [{ id: 1, name: "first.txt" }, { id: 2, name: "second.TXT" }, { id: 3, name: "draft.md" }];
  function Sidebar() { usePrefetchFileApplications("/workspace", 2, documents); return null; }
  render(<QueryClientProvider client={client}><Sidebar /></QueryClientProvider>);
  await waitFor(() => expect(projectFileApi.applications).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(client.getQueryData(fileApplicationOptions("/workspace", 9, 10, "third.txt").queryKey)).toEqual([{ id: "viewer", name: "Viewer", icon: null, isDefault: true }]));
  expect(fileApplicationOptions("/workspace", 2, 1, "README").queryKey).not.toEqual(fileApplicationOptions("/workspace", 2, 2, "LICENSE").queryKey);
  expect(fileApplicationOptions("/other", 2, 1, "first.txt").queryKey).not.toEqual(fileApplicationOptions("/workspace", 2, 1, "first.txt").queryKey);
});
