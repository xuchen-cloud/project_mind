import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentRecord } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { DocumentVersionDropdown } from "./DocumentSharedComponents";
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { documentListVersions: vi.fn() } }));
const binding = {workspaceId:"w",generation:"g"};
const document: DocumentRecord = {id:7,projectId:2,name:"sample.txt",baseName:"sample",originalPath:"",managedPath:"/project/sample.txt",historyDirPath:"",storageMode:"managed",mimeType:"text/plain",isStarred:false,currentVersionNumber:1000,versionCount:1000,health:"normal",tags:[],createdAt:"",updatedAt:""};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object:{workspaceId:"w",scope:{kind:"project",projectId:2},kind:"file",id:"7"},currentVersionNumber:1000,currentContentHash:"hash",versions:Array.from({length:50},(_,i)=>({id:String(1000-i),versionNumber:1000-i,name:"sample.txt",createdAt:"2026-10-27",contentHash:"hash",isCurrent:i===0})),nextCursor:951});
  vi.mocked(projectMindApi.documentListVersions).mockResolvedValue([]);
});
function mount(onOpenVersion = vi.fn()) {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  client.setQueryData(queryKeys.workspaceStatus,{currentWorkspace:{rootPath:"/workspace"}});
  const view = render(<QueryClientProvider client={client}><DocumentVersionDropdown document={document} onOpenVersion={onOpenVersion}/></QueryClientProvider>);
  return {...view,client,onOpenVersion};
}
it("reads only the recent native page on demand and keeps older history behind its explicit entry", async () => {
  const view = mount();
  expect(fileDocumentApi.versionsList).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"选择 sample 的版本"}));
  await waitFor(()=>expect(screen.getAllByRole("menuitemradio")).toHaveLength(50));
  expect(fileDocumentApi.versionsList).toHaveBeenCalledExactlyOnceWith(binding,{object:{workspaceId:"w",scope:{kind:"project",projectId:2},kind:"file",id:"7"},limit:50});
  expect(projectMindApi.documentListVersions).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem",{name:"查看历史与比较"})).toBeVisible();
  fireEvent.click(screen.getByRole("menuitemradio",{name:"v999",exact:true}));
  await waitFor(()=>expect(screen.queryByRole("menu")).toBeNull());
  expect(view.onOpenVersion).toHaveBeenCalledWith(expect.objectContaining({versionNumber:999}));
});
it("propagates an asynchronous open error to the menu and retries the same version", async () => {
  const open = vi.fn().mockRejectedValueOnce(new Error("打开失败")).mockResolvedValue(undefined);
  mount(open);
  fireEvent.click(screen.getByRole("button",{name:"选择 sample 的版本"}));
  fireEvent.click(await screen.findByRole("menuitemradio",{name:"v999",exact:true}));
  expect(await screen.findByRole("alert")).toHaveTextContent("打开失败");
  expect(screen.getByRole("menu")).toBeVisible();
  fireEvent.click(screen.getByRole("menuitemradio",{name:"v999",exact:true}));
  await waitFor(()=>expect(screen.queryByRole("menu")).toBeNull());
  expect(open).toHaveBeenCalledTimes(2);
});
