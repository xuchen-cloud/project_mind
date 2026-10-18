import { beforeEach, expect, it, vi } from 'vitest';
import { desktopApi } from './desktopApi';
import { inspectImportedWorkbook } from './editorWorkbookImport';

vi.mock('./desktopApi', () => ({desktopApi: {inspectImportedWorkbook: vi.fn()}}));
beforeEach(() => vi.resetAllMocks());

it('inspects the exact selected binary bytes without a source path or File write', async () => {
  const model = {format: 'xlsx', name: 'selected.xlsx', rendererData: {file: {sessionId: 'source-only'}}};
  vi.mocked(desktopApi.inspectImportedWorkbook).mockResolvedValue(model as never);
  await expect(inspectImportedWorkbook(new Uint8Array([0, 127, 128, 255]))).resolves.toBe(model);
  expect(desktopApi.inspectImportedWorkbook).toHaveBeenCalledExactlyOnceWith({base64: 'AH+A/w=='});
});

it('propagates import failures instead of substituting an empty workbook', async () => {
  vi.mocked(desktopApi.inspectImportedWorkbook).mockRejectedValue(new Error('无效的 XLSX 原件'));
  await expect(inspectImportedWorkbook(new Uint8Array([80, 75]))).rejects.toThrow('无效的 XLSX 原件');
});

it.each([0, 100 * 1024 * 1024 + 1])('rejects a %i byte selection before allocating an IPC payload', async length => {
  await expect(inspectImportedWorkbook(new Uint8Array(length))).rejects.toThrow(/空|100 MiB/u);
  expect(desktopApi.inspectImportedWorkbook).not.toHaveBeenCalled();
});
