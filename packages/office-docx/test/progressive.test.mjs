import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { inspect, inspectView } from '../dist/engine.mjs';
import {
  openProgressive, blocksToPmDoc, readSections, pmDocOptions, pmDocToSavePlan, saveDocx,
} from '../dist/progressive.mjs';

// #303: use the renderer's real parser/converter/session and patch-save path.
// Missing build exports are a failing regression, never a reason to skip.
import {largeFixture, text, APPENDED_BLOCKS, INITIAL_BLOCKS, NEXT_BLOCKS, ADDED_PREFIX, TAIL_WITNESS,
 FIRST_ORIGINAL, SECOND_ORIGINAL, FIRST_EDIT, SECOND_EDIT, OPAQUE_PATH, MEDIA_PATH, OPAQUE_RELS_PATH} from './fixtures/progressive.mjs';
const parsedDocument = parsed => blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed));

function assertAppendedBody(document, paragraphs) {
  const body = document.content.map(text);
  assert.deepEqual(body.filter(value => value.startsWith(ADDED_PREFIX)), paragraphs,
    'Every appended paragraph must occur once, in source order');
  assert.equal(body.at(-1), paragraphs.at(-1), 'The unique tail witness remains the last body node');
}

function editParagraph(document, before, after) {
  const paragraph = document.content.find(node => node.type === 'docParagraph' && text(node) === before);
  assert.ok(paragraph, `The first screen must expose an editable paragraph: ${before}`);
  assert.ok(Number.isInteger(paragraph.attrs.docxIndex), 'Edits retain their original OOXML identity');
  assert.equal(paragraph.content[0].type, 'text');
  assert.equal(paragraph.content[0].text, before);
  paragraph.content[0].text = after;
  return paragraph;
}

function assertOriginalSource(session, parsed, originalBytes, snapshot) {
  assert.strictEqual(session.parsed, parsed, 'Loading must extend the same ParsedDoc');
  assert.strictEqual(session.parsed.internal.originalBytes, originalBytes,
    'Loading and saving must retain the original source object');
  assert.deepEqual(originalBytes, snapshot, 'The original archive bytes must never be rebased or mutated');
}

async function assertUntouchedEntries(original, savedBytes) {
  const saved = await JSZip.loadAsync(savedBytes);
  const entryNames = zip => Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
  assert.deepEqual(entryNames(saved), entryNames(original), 'Saving must retain every original package entry');
  // patch-save updates only the edited body and core save timestamp/revision.
  for (const name of entryNames(original)) {
    if (name === 'word/document.xml' || name === 'docProps/core.xml') continue;
    assert.deepEqual(await saved.file(name).async('uint8array'), await original.file(name).async('uint8array'),
      `Untouched entry must have identical decompressed bytes: ${name}`);
  }
}

test('#303 inspectView exposes a genuinely partial editable body while inspect retains the complete DOCX', async () => {
  const { bytes, paragraphs } = await largeFixture();
  // Reproduce the previous GUI path using the preserved full parser. This is
  // a functional negative control, not a missing-module/build failure.
  const view = await (process.env.DOCX_RED_BASELINE ? inspect : inspectView)(bytes);
  const full = await inspect(bytes);
  assert.equal(view.format, 'docx');
  assert.equal(view.document.type, 'doc');
  assert.equal(view.readOnly, false);
  assert.ok(!JSON.stringify(view.document).includes(TAIL_WITNESS), 'The old GUI full-open path parses the unvisited tail before returning');
  assert.equal(view.coverage.partial, true);
  assert.ok(view.coverage.loadedBlocks > 0);
  assert.equal(view.coverage.loadedBlocks, view.document.content.length);
  assert.ok(view.coverage.loadedBlocks < full.document.content.length / 2,
    'The view must parse substantially fewer blocks than the complete document');
  assert.ok(view.document.content.some(node => node.type === 'docParagraph' && text(node) === FIRST_ORIGINAL));
  assert.ok(!JSON.stringify(view.document).includes(TAIL_WITNESS), 'The tail must not appear in the initial PM document');
  assert.ok(!view.nodes.some(node => node.text.includes(TAIL_WITNESS)), 'Initial text nodes must also be partial');
  assert.deepEqual(Buffer.from(view.sourceBase64, 'base64'), Buffer.from(bytes), 'A partial view retains the full original source');
  assertAppendedBody(full.document, paragraphs);
  assert.ok(full.nodes.some(node => node.text.includes(TAIL_WITNESS)), 'inspect remains the complete-content API');
});

test('#303 prefix edits survive real incremental materialization and two cumulative saves against the same source', async () => {
  const { bytes, paragraphs } = await largeFixture();
  const originalZip = await JSZip.loadAsync(bytes);
  for (const name of [OPAQUE_PATH, MEDIA_PATH, OPAQUE_RELS_PATH]) assert.ok(originalZip.file(name));
  const session = await openProgressive(bytes, { initialBlocks: INITIAL_BLOCKS });
  const parsed = session.parsed;
  const originalBytes = parsed.internal.originalBytes;
  const sourceSnapshot = new Uint8Array(originalBytes);
  assert.deepEqual(originalBytes, bytes);
  assert.equal(session.complete, false);
  assert.equal(parsed.blocks.length, INITIAL_BLOCKS);
  assert.ok(parsed.blocks.length < APPENDED_BLOCKS / 4, 'The parser itself must stop at the first batch');
  assert.equal(session.initialDocument.type, 'doc');
  assert.equal(session.initialDocument.content.length, INITIAL_BLOCKS);
  assert.deepEqual(session.initialDocument.content.map(node => node.attrs.docxIndex),
    parsed.blocks.map(block => block.docxIndex), 'The initial PM document covers exactly the parsed prefix');
  assert.ok(!JSON.stringify(parsed.blocks).includes(TAIL_WITNESS), 'The tail must not already exist in ParsedDoc.blocks');
  assert.ok(!JSON.stringify(session.initialDocument).includes(TAIL_WITNESS));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parsed.blocks.length, INITIAL_BLOCKS, 'Opening must not eagerly finish parsing in the background');

  const document = structuredClone(session.initialDocument);
  const firstParagraph = editParagraph(document, FIRST_ORIGINAL, FIRST_EDIT);
  const editedPrefix = structuredClone(document.content);
  const initialPmCount = document.content.length;
  const batch = await session.loadMore(NEXT_BLOCKS);
  assert.equal(batch.complete, false);
  assert.equal(session.complete, false);
  assert.equal(parsed.blocks.length, INITIAL_BLOCKS + NEXT_BLOCKS);
  assert.equal(batch.nodes.length, NEXT_BLOCKS);
  assert.deepEqual(batch.nodes.map(node => node.attrs.docxIndex),
    parsed.blocks.slice(INITIAL_BLOCKS).map(block => block.docxIndex),
    'loadMore returns only the newly parsed PM nodes');
  document.content.push(...batch.nodes);
  assert.deepEqual(document.content.slice(0, initialPmCount), editedPrefix);
  assert.strictEqual(document.content.find(node => node.attrs?.docxIndex === firstParagraph.attrs.docxIndex), firstParagraph);
  assert.ok(!JSON.stringify(parsed.blocks).includes(TAIL_WITNESS), 'A small loadMore must still leave the tail unparsed');
  assertOriginalSource(session, parsed, originalBytes, sourceSnapshot);

  const loadedPmCount = document.content.length;
  const loadedBlockCount = parsed.blocks.length;
  const editedLoadedPrefix = structuredClone(document.content);
  const remaining = await session.materialize();
  assert.equal(remaining.complete, true);
  assert.equal(session.complete, true);
  assert.ok(parsed.blocks.length > loadedBlockCount);
  const completeOriginal = parsedDocument(parsed);
  assertAppendedBody(completeOriginal, paragraphs);
  // Compare with the real full conversion once trailing section metadata is
  // available; readSections on a partial ParsedDoc need not know that section.
  assert.deepEqual(session.initialDocument, { type: 'doc', content: completeOriginal.content.slice(0, initialPmCount) },
    'The initial PM document uses the same real conversion as the full source');
  assert.deepEqual(batch.nodes, completeOriginal.content.slice(initialPmCount, loadedPmCount));
  assert.deepEqual(remaining.nodes, completeOriginal.content.slice(loadedPmCount),
    'materialize must return only the remaining nodes, never replay the original prefix');
  assert.equal(remaining.nodes.length, completeOriginal.content.length - loadedPmCount);
  document.content.push(...remaining.nodes);
  assert.deepEqual(document.content.slice(0, loadedPmCount), editedLoadedPrefix,
    'Appending materialized nodes must preserve the edited prefix');
  assert.strictEqual(document.content.find(node => node.attrs?.docxIndex === firstParagraph.attrs.docxIndex), firstParagraph);
  assert.equal(text(firstParagraph), FIRST_EDIT);
  assert.equal(document.content.length, completeOriginal.content.length, 'No block is duplicated or lost at batch boundaries');
  const identities = document.content.map(node => node.attrs.docxIndex);
  assert.equal(new Set(identities).size, identities.length, 'Every original body identity occurs once');
  assert.deepEqual(identities, completeOriginal.content.map(node => node.attrs.docxIndex));
  assertAppendedBody(document, paragraphs);
  assertOriginalSource(session, parsed, originalBytes, sourceSnapshot);
  assert.deepEqual(await session.materialize(), { nodes: [], complete: true }, 'A completed session has no remaining nodes');

  for (let round = 1; round <= 2; round++) {
    if (round === 2) editParagraph(document, SECOND_ORIGINAL, SECOND_EDIT);
    // Deliberately reuse this session's original ParsedDoc and cumulative PM.
    // Reopening a saved archive as the next baseline would mask lost edits.
    const plan = pmDocToSavePlan(document, parsed.blocks);
    assert.ok(plan.changedCount > 0);
    const savedBytes = new Uint8Array(await saveDocx(parsed, plan.saveBlocks));
    const reopened = await inspect(savedBytes);
    assert.deepEqual(reopened.document.content.map(text), document.content.map(text),
      `Save ${round} must preserve the cumulative PM body, including the unloaded tail`);
    assert.ok(reopened.nodes.some(node => node.text === FIRST_EDIT), 'The first prefix edit survives every save');
    assert.ok(reopened.nodes.some(node => node.text === (round === 2 ? SECOND_EDIT : SECOND_ORIGINAL)));
    assertAppendedBody(reopened.document, paragraphs);
    await assertUntouchedEntries(originalZip, savedBytes);
    assertOriginalSource(session, parsed, originalBytes, sourceSnapshot);
    assert.deepEqual(parsedDocument(parsed), completeOriginal, 'Saving must not mutate the original parsed baseline');
  }
});

test('#303 view rejects malformed UTF in Strict OOXML before namespace normalization', async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL('fixtures/simple.original.docx', import.meta.url)));
  const xml = (await zip.file('word/document.xml').async('string'))
    .replaceAll('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main');
  const raw = Buffer.from(xml);
  const offset = raw.indexOf(Buffer.from(FIRST_ORIGINAL));
  assert.ok(offset > 0);
  raw[offset] = 0xff;
  zip.file('word/document.xml', raw);
  const bytes = await zip.generateAsync({type: 'uint8array'});
  await assert.rejects(inspectView(bytes), error => error.code === 'INVALID_UTF');
});

test('#303 long cached TOC result is not an indivisible field-code dependency', async () => {
  const {bytes} = await largeFixture();
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', xml.replace(/(<w:body[^>]*>)/, '$1<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>')
    .replace('<w:sectPr', '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:sectPr'));
  const session = await openProgressive(await zip.generateAsync({type: 'uint8array'}), {initialBlocks: 12});
  assert.equal(session.complete, false);
  assert.equal(session.parsed.blocks.length, 12);
  assert.ok(!JSON.stringify(session.initialDocument).includes(TAIL_WITNESS));
});

test('#303 floating image ranks remain stable across batches and agree with full parsing', async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL('fixtures/simple.original.docx', import.meta.url)));
  const xml = await zip.file('word/document.xml').async('string');
  const picture = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match => match[0]).find(p => p.includes('<w:drawing'));
  assert.ok(picture);
  const pictures = [1, 2, 3].map(height => picture.replace('<wp:inline ', `<wp:anchor relativeHeight="${height}" behindDoc="0" `)
    .replace('</wp:inline>', '</wp:anchor>').replace('<wp:extent', '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:wrapSquare wrapText="bothSides"/><wp:extent')).join('');
  const section = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(xml)[0];
  zip.file('word/document.xml', xml.replace(/(<w:body[^>]*>)[\s\S]*?<\/w:body>/, '$1' + pictures + section + '</w:body>'));
  const bytes = await zip.generateAsync({type: 'uint8array'});
  const session = await openProgressive(bytes, {initialBlocks: 1});
  const document = structuredClone(session.initialDocument);
  const first = structuredClone(document.content[0]);
  document.content.push(...(await session.materialize()).nodes);
  assert.deepEqual(document.content[0], first, 'Later anchors must not re-rank an already mounted image');
  const ranks = document => document.content.filter(node => node.attrs?.blockType === 'image').map(node => node.attrs.imageZOrder);
  assert.deepEqual(ranks(document), ranks((await inspect(bytes)).document));
});
