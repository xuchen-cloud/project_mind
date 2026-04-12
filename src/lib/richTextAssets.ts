import { desktopApi } from "../services/desktopApi";
import { fileHref, fileUriToPath } from "./formatters";

const FILE_PROTOCOL_PATTERN = /^file:/i;
const EMBEDDED_PROTOCOL_PATTERN = /^(?:data:|blob:)/i;
const REMOTE_PROTOCOL_PATTERN = /^(?:https?:|data:|blob:|asset:|tauri:)/i;
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const UNC_PATH_PATTERN = /^[/\\]{2}[^/\\]/;

export function resolveRichTextImageSrc(path?: string | null, src?: string | null) {
  const normalizedSrc = normalizeString(src);

  if (normalizedSrc && EMBEDDED_PROTOCOL_PATTERN.test(normalizedSrc)) {
    return normalizedSrc;
  }

  const normalizedPath = normalizePathValue(path);

  if (normalizedPath) {
    return desktopApi.toFileUrl(normalizedPath);
  }

  if (!normalizedSrc) {
    return null;
  }

  if (REMOTE_PROTOCOL_PATTERN.test(normalizedSrc)) {
    return normalizedSrc;
  }

  if (FILE_PROTOCOL_PATTERN.test(normalizedSrc)) {
    const filePath = fileUriToPath(normalizedSrc);

    return filePath ? desktopApi.toFileUrl(filePath) : normalizedSrc;
  }

  if (looksLikeFilesystemPath(normalizedSrc)) {
    return desktopApi.toFileUrl(normalizedSrc);
  }

  return normalizedSrc;
}

export function resolveRichTextAttachmentHref(path?: string | null, href?: string | null) {
  const normalizedPath = normalizePathValue(path);

  if (normalizedPath) {
    return fileHref(normalizedPath);
  }

  const normalizedHref = normalizeString(href);

  if (!normalizedHref) {
    return "#";
  }

  if (FILE_PROTOCOL_PATTERN.test(normalizedHref) || REMOTE_PROTOCOL_PATTERN.test(normalizedHref)) {
    return normalizedHref;
  }

  if (looksLikeFilesystemPath(normalizedHref)) {
    return fileHref(normalizedHref);
  }

  return normalizedHref;
}

export function repairRichTextAssetHtml(html?: string | null) {
  const normalizedHtml = html?.trim() ?? "";

  if (!normalizedHtml || typeof DOMParser === "undefined") {
    return normalizedHtml;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");

  doc.body.querySelectorAll("img").forEach((image) => {
    const nextSrc = resolveRichTextImageSrc(
      image.getAttribute("data-path"),
      image.getAttribute("src"),
    );

    if (nextSrc) {
      image.setAttribute("src", nextSrc);
    } else {
      image.removeAttribute("src");
    }
  });

  doc.body.querySelectorAll<HTMLElement>('div[data-type="attachment"]').forEach((attachment) => {
    const link = attachment.querySelector<HTMLAnchorElement>("a");

    if (!link) {
      return;
    }

    const nextHref = resolveRichTextAttachmentHref(
      attachment.getAttribute("data-path"),
      attachment.getAttribute("data-href") ?? link.getAttribute("href"),
    );

    link.setAttribute("href", nextHref);

    if (nextHref === "#") {
      link.removeAttribute("target");
      link.removeAttribute("rel");
      return;
    }

    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  });

  return doc.body.innerHTML.trim();
}

function normalizeString(value?: string | null) {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizePathValue(value?: string | null) {
  const normalized = normalizeString(value);

  if (!normalized) {
    return null;
  }

  if (FILE_PROTOCOL_PATTERN.test(normalized)) {
    const filePath = fileUriToPath(normalized);

    return filePath || null;
  }

  return normalized;
}

function looksLikeFilesystemPath(value: string) {
  return value.startsWith("/") || WINDOWS_PATH_PATTERN.test(value) || UNC_PATH_PATTERN.test(value);
}
