import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspect, edit } from '../dist/engine.mjs';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const fixture = name => readFile(new URL(`fixtures/${name}.original.docx`, import.meta.url));
const manifest = JSON.parse(await readFile(new URL('fixtures/manifest.json', import.meta.url)));
const text = node => node.type === 'text' ? node.text : (node.content ?? []).map(text).join('');
const xmlTree = xml => new XMLParser({ ignoreAttributes: false, preserveOrder: true, parseTagValue: false,
  parseAttributeValue: false, trimValues: false, ignoreDeclaration: true }).parse(xml.replace(/ xml:space="preserve"/g, ''));

test('inspect exposes Chinese paragraphs, real table cells, images and original anchors', async () => {
  const bytes = await fixture('simple');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.simple);
  const model = await inspect(bytes);
  assert.equal(model.format, 'docx');
  assert.equal(model.document.type, 'doc');
  assert.equal(model.nodes.find(n => n.text === '待修改中文段落：春风拂面。').id, 'docx:2');
  assert.ok(model.nodes.some(n => n.text === '待改单元' && n.id.startsWith('docx:4/')));
  assert.equal(text(model.document.content.find(n => n.type === 'docTable').content[1].content[1]), '待改单元');
  assert.equal(model.document.content.find(n => n.type === 'docProtected').attrs.docxIndex, 5);
  assert.ok(model.assets.some(a => a.dataUrl.startsWith('data:image/png;base64,')));
  assert.equal(model.page.width, 816);
  assert.equal(model.page.margins.left, 120);
  assert.ok(model.documentCss.includes('Title'));
});

test('no edits and an unchanged document return the exact original archive', async () => {
  for (const name of ['simple', 'complex']) {
    const bytes = await fixture(name);
    const model = await inspect(bytes);
    assert.deepEqual(await edit(bytes, []), new Uint8Array(bytes));
    assert.deepEqual(await edit(bytes, [{ type: 'document', document: model.document }]), new Uint8Array(bytes));
  }
});

test('stable text edits survive two save/reopen cycles and preserve every other OOXML part', async () => {
  for (const name of ['simple', 'complex']) {
    let bytes = new Uint8Array(await fixture(name));
    const original = await JSZip.loadAsync(bytes);
    let model = await inspect(bytes);
    const paragraph = model.nodes.find(n => n.text === '待修改中文段落：春风拂面。');
    const cell = model.nodes.find(n => n.text === '待改单元');
    for (const [p, c] of [['第一轮中文：秋风拂面。', '第一轮单元格'], ['第二轮中文：冬雪纷飞。', '第二轮单元格']]) {
      bytes = await edit(bytes, [
        { type: 'text', nodeId: paragraph.id, expectedText: model.nodes.find(n => n.id === paragraph.id).text, text: p },
        { type: 'text', nodeId: cell.id, text: c },
      ]);
      model = await inspect(bytes);
      assert.equal(model.nodes.find(n => n.id === paragraph.id).text, p);
      assert.equal(model.nodes.find(n => n.id === cell.id).text, c);
      assert.ok(model.nodes.some(n => n.text === '未修改段落：山川日月保持原样。'));
      const saved = await JSZip.loadAsync(bytes);
      const changed = [];
      for (const part of Object.values(original.files).filter(p => !p.dir)) {
        assert.ok(saved.file(part.name), `Missing ${part.name}`);
        if (!Buffer.from(await part.async('uint8array')).equals(Buffer.from(await saved.file(part.name).async('uint8array')))) changed.push(part.name);
      }
      assert.deepEqual(changed.sort(), ['docProps/core.xml', 'word/document.xml']);
      assert.equal(model.assets[0].dataUrl, (await inspect(await fixture(name))).assets[0].dataUrl);
    }
  }
});

test('document edits reject unknown original identities and opaque payload mutation', async () => {
  const bytes = await fixture('complex');
  const model = await inspect(bytes);
  for (const change of [
    doc => { doc.content[2].attrs.docxIndex = 99999; },
    doc => { doc.content.find(n => n.type === 'docProtected').attrs.imageDataUrl = null; },
    doc => { doc.content.find(n => n.type === 'docProtected').attrs.chartDisplay = { partPath: 'word/charts/chart1.xml', series: [], categories: [] }; },
  ]) {
    const document = structuredClone(model.document);
    change(document);
    await assert.rejects(edit(bytes, [{ type: 'document', document }]), { code: 'UNSUPPORTED_EDIT' });
  }
});

test('edit rejects lossy JSON and invalid Unicode instead of dropping unknown fields', async () => {
  const bytes = await fixture('simple');
  const model = await inspect(bytes);
  const document = structuredClone(model.document);
  document.content[2].attrs.unrecognized = 'would be silently dropped by schema';
  await assert.rejects(edit(bytes, [{ type: 'document', document }]), { code: 'INVALID_JSON' });
  for (const edits of [
    [{ type: 'text', nodeId: 'docx:2', text: undefined }],
    [{ type: 'text', nodeId: 'docx:2', text: '中文', extra: NaN }],
    [{ type: 'document', document: { type: 'doc', content: [null] } }],
  ]) await assert.rejects(edit(bytes, edits), { code: 'INVALID_JSON' });
  await assert.rejects(edit(bytes, [{ type: 'text', nodeId: 'docx:2', text: '\ud800' }]), { code: 'INVALID_UTF' });
  await assert.rejects(edit(bytes, [{ type: 'text', nodeId: 'docx:2', text: '中文', expectedText: 'wrong baseline' }]), { code: 'INVALID_EDIT' });
});

test('inspect and edit reject invalid UTF-8 inside the original OOXML archive', async () => {
  const zip = await JSZip.loadAsync(await fixture('simple'));
  const xml = Buffer.from(await zip.file('word/document.xml').async('uint8array'));
  const at = xml.indexOf(Buffer.from('春风'));
  assert.ok(at > 0);
  xml[at] = 0xff;
  zip.file('word/document.xml', xml);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(inspect(bytes), { code: 'INVALID_UTF' });
  await assert.rejects(edit(bytes, []), { code: 'INVALID_UTF' });
});

test('full document edits preserve original image, section, hyperlink and all untouched XML across two saves', async () => {
  let bytes = await fixture('complex');
  const original = await JSZip.loadAsync(bytes);
  let expectedXml = await original.file('word/document.xml').async('string');
  let previous = '待修改中文段落：春风拂面。';
  for (const value of ['文档模型第一轮中文。', '文档模型第二轮中文。']) {
    const model = await inspect(bytes);
    const document = structuredClone(model.document);
    const paragraph = document.content.find(n => n.attrs?.docxIndex === 2);
    paragraph.content[0].text = value;
    bytes = await edit(bytes, [{ type: 'document', document }]);
    const reopened = await inspect(bytes);
    assert.equal(reopened.nodes.find(n => n.id === 'docx:2').text, value);
    expectedXml = expectedXml.replace(previous, value);
    const saved = await JSZip.loadAsync(bytes);
    assert.deepEqual(xmlTree(await saved.file('word/document.xml').async('string')), xmlTree(expectedXml));
    previous = value;
  }
});

async function chartFixture() {
  const zip = await JSZip.loadAsync(await fixture('simple'));
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2857500" cy="1905000"/><wp:docPr id="99" name="Preserved chart"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:sectPr', drawing + '<w:sectPr'));
  zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', '<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  zip.file('word/charts/chart1.xml', '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>原图类别</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>12</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>');
  return zip.generateAsync({ type: 'uint8array' });
}

test('an actual OOXML chart stays intact during text edits and rejects unsupported series structure', async () => {
  const bytes = await chartFixture();
  const model = await inspect(bytes);
  const chart = model.document.content.find(n => n.attrs?.chartDisplay);
  assert.ok(chart, 'The real engine must parse the chart, not a fabricated model');
  assert.equal(chart.attrs.chartDisplay.series[0].values[0], 12);
  const saved = await JSZip.loadAsync(await edit(bytes, [{ type: 'text', nodeId: 'docx:2', text: '图表保留时修改中文' }]));
  const original = await JSZip.loadAsync(bytes);
  assert.deepEqual(await saved.file('word/charts/chart1.xml').async('uint8array'), await original.file('word/charts/chart1.xml').async('uint8array'));
  for (const mutate of [
    display => { display.series.push(structuredClone(display.series[0])); },
    display => { display.partPath = 'word/charts/other.xml'; },
  ]) {
    const document = structuredClone(model.document);
    mutate(document.content.find(n => n.attrs?.chartDisplay).attrs.chartDisplay);
    await assert.rejects(edit(bytes, [{ type: 'document', document }]), { code: 'UNSUPPORTED_EDIT' });
  }
});

test('source editing restrictions are exposed and enforced by the engine', async () => {
  const zip = await JSZip.loadAsync(await fixture('simple'));
  zip.file('word/settings.xml', (await zip.file('word/settings.xml').async('string')).replace('</w:settings>', '<w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  assert.equal((await inspect(bytes)).readOnly, true);
  assert.deepEqual(await edit(bytes, []), bytes);
  await assert.rejects(edit(bytes, [{ type: 'text', nodeId: 'docx:2', text: '不能修改的中文' }]), { code: 'READ_ONLY' });
});

test('Word chart values save through the upstream chart part patch and reopen as real values', async()=>{
 const bytes=await chartFixture();const model=await inspect(bytes);const document=structuredClone(model.document);
 document.content.find(n=>n.attrs?.chartDisplay).attrs.chartDisplay.series[0].values[0]=99;
 const saved=await edit(bytes,[{type:'document',document}]);
 assert.equal((await inspect(saved)).document.content.find(n=>n.attrs?.chartDisplay).attrs.chartDisplay.series[0].values[0],99);
});
