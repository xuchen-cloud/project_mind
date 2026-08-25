import { projectMindApi } from "../../services/projectMindApi";
import { resolveRichTextImageSrc } from "../../lib/richTextAssets";
import { fileHref } from "../../lib/formatters";
import type { DocumentRecord } from "../../lib/types";
import type { RichEditorAsset, RichEditorAssetHandlers, RichEditorValue } from "./types";

export function buildProjectNoteImageAssetHandlers(
  projectId: number,
): RichEditorAssetHandlers {
  return {
    insertImage: async (sourcePath) => {
      const document = await projectMindApi.documentImportNoteImage({
        projectId,
        sourcePath,
      });

      return mapDocumentToImageAsset(document);
    },
    insertPastedImage: async (file) => {
      const nativePath = readNativeFilePath(file);

      if (nativePath) {
        const document = await projectMindApi.documentImportNoteImage({
          projectId,
          sourcePath: nativePath,
        });

        return mapDocumentToImageAsset(document);
      }

      const mimeType = file.type.trim() || "image/png";
      const document = await projectMindApi.documentImportClipboardNoteImage({
        projectId,
        fileName: file.name.trim() || "clipboard-image.png",
        mimeType,
        dataBase64: await readFileAsBase64(file),
      });

      return mapDocumentToImageAsset(document);
    },
    insertFile: async (sourcePath) => {
      const document = await projectMindApi.documentImport({
        projectId,
        sourcePath,
        isStarred: false,
        tagIds: [],
      });

      return mapDocumentToFileAsset(document);
    },
  };
}

export function buildWorkspaceNoteImageAssetHandlers(): RichEditorAssetHandlers {
  return {
    insertImage: async (sourcePath) => {
      const asset = await projectMindApi.workspaceNoteImageImport({
        sourcePath,
      });

      return mapWorkspaceNoteImageAsset(asset);
    },
    insertPastedImage: async (file) => {
      const nativePath = readNativeFilePath(file);

      if (nativePath) {
        const asset = await projectMindApi.workspaceNoteImageImport({
          sourcePath: nativePath,
        });

        return mapWorkspaceNoteImageAsset(asset);
      }

      const mimeType = file.type.trim() || "image/png";
      const asset = await projectMindApi.workspaceClipboardNoteImageImport({
        fileName: file.name.trim() || "clipboard-image.png",
        mimeType,
        dataBase64: await readFileAsBase64(file),
      });

      return mapWorkspaceNoteImageAsset(asset);
    },
  };
}

export async function externalizeEmbeddedImageDataUrls(
  value: RichEditorValue,
  assetHandlers?: RichEditorAssetHandlers,
): Promise<RichEditorValue> {
  if (!assetHandlers?.insertPastedImage || typeof DOMParser === "undefined") {
    return value;
  }

  const normalizedHtml = value.html.trim();
  if (!normalizedHtml || !normalizedHtml.includes("data:image/")) {
    return value;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");
  const images = Array.from(doc.body.querySelectorAll<HTMLImageElement>("img")).filter((image) =>
    image.getAttribute("src")?.trim().startsWith("data:image/"),
  );

  if (images.length === 0) {
    return value;
  }

  for (const [index, image] of images.entries()) {
    const file = dataUrlImageToFile(
      image.getAttribute("src") ?? "",
      image.getAttribute("title") ?? image.getAttribute("alt") ?? `embedded-image-${index + 1}`,
    );

    if (!file) {
      continue;
    }

    const asset = await assetHandlers.insertPastedImage(file);
    const nextSrc = resolveRichTextImageSrc(asset.path, asset.src);

    if (!nextSrc) {
      continue;
    }

    image.setAttribute("src", nextSrc);
    image.setAttribute("data-path", asset.path ?? "");
    image.setAttribute("data-mime-type", asset.mimeType ?? file.type);
    image.setAttribute("alt", asset.title);
    image.setAttribute("title", asset.title);

    if (asset.documentId) {
      image.setAttribute("data-document-id", String(asset.documentId));
    } else {
      image.removeAttribute("data-document-id");
    }
  }

  return {
    ...value,
    html: doc.body.innerHTML.trim(),
  };
}

function mapDocumentToImageAsset(document: DocumentRecord): RichEditorAsset {
  return {
    kind: "image",
    title: document.name,
    path: document.managedPath || document.originalPath,
    mimeType: document.mimeType,
    documentId: document.id,
  };
}

function mapDocumentToFileAsset(document: DocumentRecord): RichEditorAsset {
  const path = document.managedPath || document.originalPath;

  return {
    kind: "file",
    title: document.name,
    path,
    href: path ? fileHref(path) : undefined,
    mimeType: document.mimeType,
    documentId: document.id,
    meta: document.mimeType,
    isStarred: document.isStarred,
  };
}

function mapWorkspaceNoteImageAsset(asset: { title: string; path: string; mimeType: string }): RichEditorAsset {
  return {
    kind: "image",
    title: asset.title,
    path: asset.path,
    mimeType: asset.mimeType,
  };
}

function readNativeFilePath(file: File) {
  const path = (file as File & { path?: string }).path;
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
}

async function readFileAsBase64(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("读取图片失败"));
    };

    reader.readAsDataURL(file);
  });

  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function dataUrlImageToFile(dataUrl: string, preferredName: string) {
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/iu);

  if (!match) {
    return null;
  }

  const mimeType = match[1] || "image/png";
  const base64 = match[2] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], ensureImageFileName(preferredName, mimeType), {
    type: mimeType,
  });
}

function ensureImageFileName(value: string, mimeType: string) {
  const trimmed = value.trim().replace(/[\\/:"*?<>|]+/gu, "_");
  const fallbackExtension = imageExtensionForMimeType(mimeType);
  const fallback = `embedded-image.${fallbackExtension}`;
  const fileName = trimmed || fallback;

  return /\.[A-Za-z0-9]{2,5}$/u.test(fileName)
    ? fileName
    : `${fileName}.${fallbackExtension}`;
}

function imageExtensionForMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "png";
  }
}
