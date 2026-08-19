import { desktopApi } from "../../services/desktopApi";
import type { RecordExportRequest } from "./recordExport";

export interface RecordExportTarget {
  path: string;
  overwrite: boolean;
}

export function sanitizeRecordExportStem(title: string, date = new Date()) {
  let stem = title
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim();
  if (!stem) {
    const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
      .join("");
    stem = `未命名记录-${stamp}`;
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(stem)) stem = `_${stem}`;
  return Array.from(stem).slice(0, 120).join("").replace(/[. ]+$/gu, "") || "未命名记录";
}

export function recordExportExtension(
  format: RecordExportRequest["format"],
  includeImages: boolean,
  hasImages: boolean,
) {
  if (format === "markdown") return includeImages && hasImages ? "zip" : "md";
  return format;
}

export async function chooseRecordExportTarget(input: {
  title: string;
  format: RecordExportRequest["format"];
  includeImages: boolean;
  hasImages: boolean;
}): Promise<RecordExportTarget | null> {
  const extension = recordExportExtension(input.format, input.includeImages, input.hasImages);
  const selected = await desktopApi.saveFile({
    title: "导出 Record",
    defaultPath: `${sanitizeRecordExportStem(input.title)}.${extension}`,
    filters: [{
      name: extension === "zip" ? "Markdown 图片包" : extension.toUpperCase(),
      extensions: [extension],
    }],
  });
  if (!selected) return null;
  const exists = await desktopApi.command<boolean>("desktop_export_path_exists", { path: selected });
  if (!exists) return { path: selected, overwrite: false };
  const overwrite = await desktopApi.confirm("目标文件已存在。是否覆盖原文件？", "覆盖导出文件");
  if (!overwrite) {
    const path = await desktopApi.command<string>("desktop_next_available_export_path", { path: selected });
    return { path, overwrite: false };
  }
  return { path: selected, overwrite: true };
}
