import { fileUriToPath } from "./formatters";

export function extractDroppedFilePaths(dataTransfer: DataTransfer) {
  console.log('extractDroppedFilePaths called'); // Debug

  try {
    const nativeFiles = Array.from(dataTransfer.files) as Array<File & { path?: string }>;
    console.log('nativeFiles:', nativeFiles); // Debug

    const nativePaths = nativeFiles
      .map((file) => file.path?.trim())
      .filter((path): path is string => Boolean(path));

    console.log('nativePaths:', nativePaths); // Debug

    if (nativePaths.length > 0) {
      return nativePaths;
    }

    const fileUriList = dataTransfer
      .getData("text/uri-list")
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("file://"));

    console.log('fileUriList:', fileUriList); // Debug

    const paths = fileUriList.map((fileUri) => fileUriToPath(fileUri)).filter(Boolean);
    console.log('final paths:', paths); // Debug

    return paths;
  } catch (error) {
    console.error('Error in extractDroppedFilePaths:', error);
    return [];
  }
}
