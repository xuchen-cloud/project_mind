import { fileUriToPath } from "./formatters";

export function extractDroppedFilePaths(dataTransfer: DataTransfer) {
  const nativeFiles = Array.from(dataTransfer.files) as Array<File & { path?: string }>;
  const nativePaths = nativeFiles
    .map((file) => file.path?.trim())
    .filter((path): path is string => Boolean(path));

  if (nativePaths.length > 0) {
    return nativePaths;
  }

  const fileUriList = dataTransfer
    .getData("text/uri-list")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("file://"));

  return fileUriList.map((fileUri) => fileUriToPath(fileUri)).filter(Boolean);
}
