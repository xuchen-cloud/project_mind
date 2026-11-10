import {parseDocx, readSections, saveDocx} from './upstream/packages/docx-engine/src/index';
import {blocksToPmDoc, pmDocOptions, pmDocToSavePlan} from './upstream/apps/docs/src/renderer/editor/convert';
import {viewReader} from './progressive-state';
export {blocksToPmDoc, pmDocOptions, pmDocToSavePlan, readSections, saveDocx};

export const INITIAL_VIEW_BLOCKS = 64;
export const VIEW_CHUNK_BLOCKS = 128;

/** One fixed complete source, one parser owner, one append-only block cursor. */
export async function openProgressive(bytes: Uint8Array, options: {initialBlocks?: number} = {}) {
  if (!(bytes instanceof Uint8Array)) throw TypeError('DOCX must be Uint8Array');
  const source = new Uint8Array(bytes);
  const parsed = await parseDocx(source, {viewBlocks: options.initialBlocks ?? INITIAL_VIEW_BLOCKS} as any);
  const reader = viewReader(parsed);
  if (!reader) throw Error('DOCX progressive parser adapter is missing');
  // Enumerate all cheap section metadata without building the tail body.
  // SDTs retain their expanded identities; deferred altChunk expansion adjusts
  // later ranges on the next read, before those blocks enter the editor.
  const sections = () => reader.complete ? readSections(parsed) :
    readSections({...parsed, blocks: [...parsed.blocks, ...reader.sectionBlocks]} as any);
  let failure: unknown;
  let chain = Promise.resolve();
  const loadMore = (count = VIEW_CHUNK_BLOCKS) => {
    const operation = chain.then(async () => {
      if (failure) throw failure;
      if (reader.complete) return {nodes: [], complete: true};
      try {
        const from = await reader.read(count);
        const blocks = parsed.blocks.slice(from).filter(block => !block.hidden);
        return {nodes: blocks.length ? blocksToPmDoc(blocks, sections(), pmDocOptions(parsed)).content ?? [] : [], complete: reader.complete};
      } catch (error) { failure = error; throw error; }
    });
    chain = operation.then(() => {}, () => {});
    return operation;
  };
  return {
    parsed,
    get complete() { return reader.complete; },
    get sections() { return sections(); },
    initialDocument: blocksToPmDoc(parsed.blocks, sections(), pmDocOptions(parsed)),
    loadMore,
    async materialize() {
      const nodes = [];
      do { nodes.push(...(await loadMore()).nodes); } while (!reader.complete);
      return {nodes, complete: true};
    },
  };
}
export type ProgressiveSession = Awaited<ReturnType<typeof openProgressive>>;
