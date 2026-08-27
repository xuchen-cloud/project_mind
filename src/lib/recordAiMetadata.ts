import type {
  AiRecordMetadataJobInput,
  ProjectTagRecord,
} from "./types";

export function buildRecordAiMetadataJobInput(input: {
  targetKey: string;
  markdown: string;
  availableTags: ProjectTagRecord[];
}): AiRecordMetadataJobInput {
  return {
    kind: "record_metadata",
    targetKey: input.targetKey,
    input: {
      markdown: input.markdown.trim(),
      existingTags: input.availableTags.map((tag) => ({
        id: tag.id,
        label: tag.label,
      })),
    },
  };
}
