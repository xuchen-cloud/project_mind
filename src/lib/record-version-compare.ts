import type { JSONContent } from "@tiptap/core";
import { canonicalDocumentJson, recordBlockIndex, type RecordBlockAnchor } from "./record-document";

export interface RecordVersionDifference {
  added: string[];
  deleted: string[];
  modified: string[];
  moved: string[];
}
function ownContent(block: RecordBlockAnchor): string {
  const node = block.node;
  return canonicalDocumentJson({ ...node, ...(node.content ? { content: node.content.map((child) =>
    child.attrs?.blockId ? { blockId: child.attrs.blockId } : child) } : {}) });
}
// The longest retained sibling order distinguishes a move from the ordinal
// shifts caused by inserting/deleting an adjacent block. O(n log n).
function retainedOrder(sequence: Array<{ id: string; ordinal: number }>): Set<string> {
  const tails: number[] = [];
  const predecessors = new Array<number>(sequence.length).fill(-1);
  sequence.forEach((entry, index) => {
    let left = 0;
    let right = tails.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (sequence[tails[middle]].ordinal < entry.ordinal) left = middle + 1;
      else right = middle;
    }
    if (left > 0) predecessors[index] = tails[left - 1];
    tails[left] = index;
  });
  const retained = new Set<string>();
  for (let index = tails[tails.length - 1] ?? -1; index >= 0; index = predecessors[index]) retained.add(sequence[index].id);
  return retained;
}

// Inputs are canonical trees validated by the shared schema. Container changes
// refer to direct child identities, so a text edit is not repeated on ancestors.
export function compareRecordDocuments(before: JSONContent, after: JSONContent): RecordVersionDifference {
  const oldBlocks = recordBlockIndex(before);
  const newBlocks = recordBlockIndex(after);
  const oldMap = new Map(oldBlocks.map((block) => [block.blockId, block]));
  const newMap = new Map(newBlocks.map((block) => [block.blockId, block]));
  const moved = new Set<string>();
  const groups = new Map<string | null, Array<{ id: string; ordinal: number }>>();
  for (const block of newBlocks) {
    const old = oldMap.get(block.blockId);
    if (!old) continue;
    if (old.parentBlockId !== block.parentBlockId) moved.add(block.blockId);
    else {
      const siblings = groups.get(block.parentBlockId) ?? [];
      siblings.push({ id: block.blockId, ordinal: old.ordinal });
      groups.set(block.parentBlockId, siblings);
    }
  }
  for (const siblings of groups.values()) {
    const retained = retainedOrder(siblings);
    siblings.forEach(({ id }) => { if (!retained.has(id)) moved.add(id); });
  }
  return {
    added: newBlocks.filter((block) => !oldMap.has(block.blockId)).map((block) => block.blockId),
    deleted: oldBlocks.filter((block) => !newMap.has(block.blockId)).map((block) => block.blockId),
    modified: newBlocks.filter((block) => oldMap.has(block.blockId) && ownContent(block) !== ownContent(oldMap.get(block.blockId)!)).map((block) => block.blockId),
    moved: newBlocks.filter((block) => moved.has(block.blockId)).map((block) => block.blockId),
  };
}
