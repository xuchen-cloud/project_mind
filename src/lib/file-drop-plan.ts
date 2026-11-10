export interface FileDropTarget { id: number; name: string }

export type FileDropPlan<T extends FileDropTarget> =
  | { kind: "import"; paths: string[] }
  | { kind: "update"; sourcePath: string; target: T }
  | { kind: "reject"; message: string };

function format(path: string) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (extension) {
    case "jpeg": return "jpg";
    case "tiff": return "tif";
    case "markdown": return "md";
    default: return extension;
  }
}

/** Receives only the target whose update hint was visibly committed. This UI
 * policy never replaces native format, ownership or source-cleanup validation. */
export function planFileDrop<T extends FileDropTarget>(sourcePaths: readonly string[], readyTarget: T | null): FileDropPlan<T> {
  const paths = [...new Set(sourcePaths)];
  if (!paths.length) return { kind: "reject", message: "无法读取本地文件路径，请使用“选择文件”导入。" };
  if (readyTarget && paths.length > 1) return { kind: "reject", message: "更新版本一次只能选择一个文件。请拖到空白处新增多个文件。" };
  if (readyTarget) {
    const sourceFormat = format(paths[0]);
    if (!sourceFormat || sourceFormat !== format(readyTarget.name)) return { kind: "reject", message: "文件格式不兼容。请拖到空白处新增文件。" };
    return { kind: "update", sourcePath: paths[0], target: readyTarget };
  }
  return { kind: "import", paths };
}
