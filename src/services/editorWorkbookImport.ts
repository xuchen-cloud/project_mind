import type { Model } from '../../packages/office-xlsx/types';
import { desktopApi } from './desktopApi';

/** Inspects selected bytes only; the imported workbook is not a managed File. */
export async function inspectImportedWorkbook(bytes: Uint8Array): Promise<Model> {
  if (!bytes.byteLength) throw new Error('选中的工作簿为空');
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('选中的工作簿超过 100 MiB');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('工作簿字节读取失败'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(new Blob([new Uint8Array(bytes)], {type: 'application/octet-stream'}));
  });
  return desktopApi.inspectImportedWorkbook({base64});
}
