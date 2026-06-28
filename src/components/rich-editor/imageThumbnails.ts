import { desktopApi } from "../../services/desktopApi";

export const TRANSPARENT_IMAGE_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const THUMBNAIL_SRC_IDLE_TTL_MS = 30 * 60 * 1000;
const THUMBNAIL_SRC_CACHE_MAX_ENTRIES = 240;

interface ThumbnailSrcCacheEntry {
  promise: Promise<string | null>;
  lastUsedAt: number;
}

const thumbnailSrcCache = new Map<string, ThumbnailSrcCacheEntry>();

export function resolveManagedImageDisplaySrc(
  path: string | null | undefined,
  originalSrc: string | null | undefined,
  maxEdge = 960,
) {
  const normalizedPath = path?.trim();
  const normalizedOriginalSrc = originalSrc?.trim() || null;

  if (!normalizedPath) {
    return Promise.resolve(normalizedOriginalSrc);
  }

  const cacheKey = `${maxEdge}::${normalizedPath}`;
  const now = Date.now();

  pruneThumbnailSrcCache(now);

  const cached = thumbnailSrcCache.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = now;
    return cached.promise;
  }

  const entry: ThumbnailSrcCacheEntry = {
    lastUsedAt: now,
    promise: desktopApi
      .generateImageThumbnail(normalizedPath, maxEdge)
      .then((thumbnailPath) => desktopApi.toFileUrl(thumbnailPath))
      .catch(() => normalizedOriginalSrc),
  };

  thumbnailSrcCache.set(cacheKey, entry);
  return entry.promise;
}

export function clearManagedImageThumbnailCacheForTests() {
  thumbnailSrcCache.clear();
}

function pruneThumbnailSrcCache(now: number) {
  if (thumbnailSrcCache.size <= THUMBNAIL_SRC_CACHE_MAX_ENTRIES) {
    for (const [key, entry] of thumbnailSrcCache) {
      if (now - entry.lastUsedAt > THUMBNAIL_SRC_IDLE_TTL_MS) {
        thumbnailSrcCache.delete(key);
      }
    }
    return;
  }

  const entries = [...thumbnailSrcCache.entries()].sort(
    (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
  );
  const entriesToRemove = entries.slice(
    0,
    Math.max(0, thumbnailSrcCache.size - THUMBNAIL_SRC_CACHE_MAX_ENTRIES),
  );

  for (const [key] of entriesToRemove) {
    thumbnailSrcCache.delete(key);
  }
}
