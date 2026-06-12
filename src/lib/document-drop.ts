import { fileUriToPath } from "./formatters";

export function extractDroppedFilePaths(dataTransfer: DataTransfer) {
  try {
    const nativeFiles = Array.from(dataTransfer.files) as Array<File & { path?: string }>;
    const nativePaths = nativeFiles
      .map((file) => file.path?.trim())
      .filter((path): path is string => Boolean(path));

    if (nativePaths.length > 0) {
      return Array.from(new Set(nativePaths));
    }

    const fileUriList = dataTransfer
      .getData("text/uri-list")
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("file://"));

    return Array.from(new Set(fileUriList.map((fileUri) => fileUriToPath(fileUri)).filter(Boolean)));
  } catch {
    return [];
  }
}
