import { projectMindApi } from "../../services/projectMindApi";
import type { DocumentRecord } from "../../lib/types";
import type { RichEditorAsset, RichEditorAssetHandlers } from "./types";

export function buildProjectNoteImageAssetHandlers(
  projectId: number,
  activityId?: number | null,
): RichEditorAssetHandlers {
  return {
    insertImage: async (sourcePath) => {
      const document = await projectMindApi.documentImportNoteImage({
        projectId,
        activityId,
        sourcePath,
      });

      return mapDocumentToImageAsset(document);
    },
    insertPastedImage: async (file) => {
      const nativePath = readNativeFilePath(file);

      if (nativePath) {
        const document = await projectMindApi.documentImportNoteImage({
          projectId,
          activityId,
          sourcePath: nativePath,
        });

        return mapDocumentToImageAsset(document);
      }

      const mimeType = file.type.trim() || "image/png";
      const document = await projectMindApi.documentImportClipboardNoteImage({
        projectId,
        activityId,
        fileName: file.name.trim() || "clipboard-image.png",
        mimeType,
        dataBase64: await readFileAsBase64(file),
      });

      return mapDocumentToImageAsset(document);
    },
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
