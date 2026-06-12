import { projectMindApi } from "../services/projectMindApi";
import type { DocumentTagRecord, FileTagRecord } from "./types";
import {
  colorKeyForTagLabel,
  extractHashTagLabels,
  findTagByLabel,
  mergeUniqueTagIds,
  stripHashTagText,
} from "./tags";

export async function resolveTodoContentTagSync({
  projectId,
  content,
  explicitTagIds,
  availableTags = [],
}: {
  projectId: number;
  content: string;
  explicitTagIds: number[];
  availableTags?: FileTagRecord[];
}) {
  const hashLabels = extractHashTagLabels(content);
  if (hashLabels.length === 0) {
    return {
      content: stripHashTagText(content),
      tagIds: explicitTagIds,
    };
  }

  let knownTags = availableTags;
  if (knownTags.length === 0) {
    const snapshot = await projectMindApi.fileTagSettingsGet({ projectId });
    knownTags = snapshot.tags;
  }

  const hashTagIds: number[] = [];

  for (const label of hashLabels) {
    const existing = findTagByLabel(knownTags, label);
    const tag =
      existing ??
      (await projectMindApi.fileTagOptionUpsert({
        projectId,
        label,
        colorKey: colorKeyForTagLabel(label),
      }));

    if (!existing) {
      knownTags = [...knownTags, tag];
    }

    hashTagIds.push(tag.id);
  }

  return {
    content: stripHashTagText(content),
    tagIds: mergeUniqueTagIds(explicitTagIds, hashTagIds),
  };
}

export function todoTagIds(tags: DocumentTagRecord[] | undefined) {
  return (tags ?? []).map((tag) => tag.id);
}
