import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FileTypeIcon } from "@deepseek-ai/dsh-client-ui-primitives";
import { FileCard } from "../upstream/client/ui-attachment/src/FileCard";
import { nativeFileIconApi } from "../../../src/services/nativeFileIconApi";

vi.mock("../../../src/services/nativeFileIconApi", () => ({ nativeFileIconApi: { typeIcon: vi.fn() } }));

it("preserves mapped DSH icons and routes an unknown attachment card to the host OS", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const png = "data:image/png;base64,iVBORw0KGgo=";
  vi.mocked(nativeFileIconApi.typeIcon).mockResolvedValue(png);
  const view = render(<QueryClientProvider client={client}>
    <FileTypeIcon path="folder/sheet.xlsx" size={20} />
    <FileCard name="drawing.unknown124" bytes={123} state="ready" labels={{ label: "待发送文件", remove: "移除文件", uploading: "上传中", failed: "上传失败", retry: "重试" }} onRemove={() => {}} onRetry={() => {}} />
    <FileTypeIcon path="folder/drawing.unknown124" size={16} />
  </QueryClientProvider>);
  await waitFor(() => expect(view.container.querySelectorAll(`img[src="${png}"]`)).toHaveLength(2));
  expect(view.container.querySelector("svg[data-file-type-mark], svg [data-file-type-mark]")).not.toBeNull();
  expect(nativeFileIconApi.typeIcon).toHaveBeenCalledExactlyOnceWith("drawing.unknown124");
});
