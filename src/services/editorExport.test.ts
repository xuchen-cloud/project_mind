import {beforeEach, expect, it, vi} from 'vitest';
import {desktopApi} from './desktopApi';
import {exportEditorFile} from './editorExport';

vi.mock('./desktopApi', () => ({desktopApi: {saveFile: vi.fn(), writeExportFile: vi.fn()}}));
const file = {name: '演示.pdf', mime: 'application/pdf', bytes: new Uint8Array([0, 1, 127, 128, 255])};
beforeEach(() => vi.resetAllMocks());

it('writes exact export bytes only after native destination selection, without overwriting a File', async () => {
  vi.mocked(desktopApi.saveFile).mockResolvedValue('C:\\Users\\demo\\演示副本');
  let finish!: (path: string) => void;
  vi.mocked(desktopApi.writeExportFile).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const completed = vi.fn();
  const pending = exportEditorFile(file).then(completed);
  await vi.waitFor(() => expect(desktopApi.writeExportFile).toHaveBeenCalled());
  expect(desktopApi.writeExportFile).toHaveBeenCalledWith({
    targetPath: 'C:\\Users\\demo\\演示副本.pdf', dataBase64: 'AAF/gP8=', overwrite: false,
  });
  expect(completed).not.toHaveBeenCalled();
  finish('C:\\Users\\demo\\演示副本.pdf');
  await pending;
  expect(completed).toHaveBeenCalledWith(true);
});

it('treats a cancelled save dialog as cancellation without writing', async () => {
  vi.mocked(desktopApi.saveFile).mockResolvedValue(null);
  expect(await exportEditorFile(file)).toBe(false);
  expect(desktopApi.writeExportFile).not.toHaveBeenCalled();
});

it('propagates native write failures to the editor instead of reporting success', async () => {
  vi.mocked(desktopApi.saveFile).mockResolvedValue('/tmp/copy.pdf');
  vi.mocked(desktopApi.writeExportFile).mockRejectedValue(new Error('目标文件已存在'));
  await expect(exportEditorFile(file)).rejects.toThrow('目标文件已存在');
});

it('sanitizes a suggested Windows filename while retaining its actual format', async () => {
  vi.mocked(desktopApi.saveFile).mockResolvedValue(null);
  await exportEditorFile({...file, name: 'CON.pdf'});
  expect(desktopApi.saveFile).toHaveBeenCalledWith({
    title: '导出副本', defaultPath: '_CON.pdf', filters: [{name: 'PDF', extensions: ['pdf']}],
  });
});

it('rejects an oversized export before allocating a native IPC payload or opening a dialog', async () => {
  await expect(exportEditorFile({...file, bytes: new Uint8Array(100 * 1024 * 1024 + 1)})).rejects.toThrow('100 MiB');
  expect(desktopApi.saveFile).not.toHaveBeenCalled();
  expect(desktopApi.writeExportFile).not.toHaveBeenCalled();
});
