import {ensureRecordExportExtension, sanitizeRecordExportStem} from '../features/record-export/recordExportTarget';
import {desktopApi} from './desktopApi';

export interface EditorExportFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Export a new copy. Replacing the registered original belongs to File/CAS save. */
export async function exportEditorFile(file: EditorExportFile): Promise<boolean> {
  const extension = file.name.match(/\.([a-z0-9]{1,10})$/iu)?.[1].toLowerCase();
  if (!extension) throw new Error('导出文件缺少有效的格式扩展名');
  if (file.bytes.byteLength > 100 * 1024 * 1024) throw new Error('导出文件超过 100 MiB 上限');
  const defaultPath = `${sanitizeRecordExportStem(file.name.slice(0, -extension.length - 1))}.${extension}`;
  const selected = await desktopApi.saveFile({
    title: '导出副本', defaultPath, filters: [{name: extension.toUpperCase(), extensions: [extension]}],
  });
  if (!selected) return false;
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('导出数据读取失败'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(new Blob([new Uint8Array(file.bytes)], {type: file.mime}));
  });
  await desktopApi.writeExportFile({
    targetPath: ensureRecordExportExtension(selected, extension), dataBase64, overwrite: false,
  });
  return true;
}
