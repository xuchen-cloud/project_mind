import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const root = path.dirname(fileURLToPath(import.meta.url));
const started = performance.now();
const sdk = await import('@univerjs-pro/exchange-node');
const { UniverInstanceType, CellValueType } = await import('@univerjs/core');
const loadMs = performance.now() - started;
const opts = { type: UniverInstanceType.UNIVER_SHEET, format: sdk.ExchangeFormat.XLSX };
const manifest = JSON.parse(await fs.readFile(path.join(root, 'fixtures.json'), 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const writeJson = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2));
const report = { issue: '#118/F03', node: process.version, platform: process.platform, arch: process.arch,
  sdkVersion: JSON.parse(await fs.readFile(path.join(root, '../node_modules/@univerjs-pro/exchange-node/package.json'), 'utf8')).version,
  nativeVersion: JSON.parse(await fs.readFile(path.join(root, '../node_modules/@univerjs-pro/exchange-node-binding/package.json'), 'utf8')).version,
  sdkLoadMs: loadMs, licenseConfiguration: 'No license configured or checks bypassed by this script', runs: [] };
const summarize = u => ({ keys: Object.keys(u), id: u.id, name: u.name, sheetOrder: u.sheetOrder,
  sheets: (u.sheetOrder ?? []).map(id => ({id, name: u.sheets[id].name, hidden: u.sheets[id].hidden,
    keys: Object.keys(u.sheets[id]), sampleCells: Object.fromEntries(['2','4','6'].map(r => [r,u.sheets[id].cellData?.[r]]))})),
  resourceSummaries: (u.resources ?? []).map(r => ({ name: r.name, dataBytes: typeof r.data === 'string' ? r.data.length : undefined })) });

for (const kind of ['simple', 'complex']) {
  const input = path.join(root, `${kind}.original.xlsx`);
  for (const family of ['unit', 'aggregate']) {
    const branches = family === 'unit' ? ['noop','edited'] : ['noop'];
    let imported;
    let importMs;
    try {
      const t = performance.now();
      imported = family === 'unit' ? await sdk.importFile(input, opts) : await sdk.importFileToSnapshot(input, opts);
      importMs = performance.now()-t;
      await writeJson(`${kind}.${family}.imported.json`, imported);
      if (family === 'unit') {
        await writeJson(`${kind}.unit-summary.json`, summarize(imported));
        if (kind === 'simple') await writeJson('imported-unit.json', imported);
      }
    } catch (e) {
      report.runs.push({kind,family,status:'failed',stage:'import',error:{name:e.name,code:e.code,message:e.message}});
      await writeJson('sdk-results.json', report);
      continue;
    }
    for (const branch of branches) {
      const run = {kind,family,branch,importMs, formulaCalculation:'forced', stages:{}};
      try {
        const data = structuredClone(imported);
        if (branch === 'edited') {
          const id = data.sheetOrder.find(id => data.sheets[id].name === '明细');
          if (!id) throw new Error('Missing target sheet 明细');
          const cells = data.sheets[id].cellData;
          if (cells[2][0].v !== '苹果' || cells[2][1].t !== CellValueType.NUMBER || Number(cells[2][1].v) !== 10 || cells[4][1].f !== '=SUM(B3:B4)')
            throw new Error('Imported target cells do not match fixture preconditions');
          run.targets = {unitId:data.id,sheetId:id,sheetName:'明细',edits:manifest.samples[kind].edits['明细']};
          cells[2][0] = {...cells[2][0],v:'香蕉（SDK编辑）',t:CellValueType.STRING};
          cells[2][1] = {...cells[2][1],v:15,t:CellValueType.NUMBER};
          cells[4][1] = {...cells[4][1],f:'=SUM(B3:B4)+5'};
          delete cells[4][1].v; // SDK must calculate edited and dependent formulas, never inject expected results.
          await writeJson(`${kind}.unit.edited.json`, data);
          if (kind === 'simple') await writeJson('browser-targets.json', {...run.targets,
            importedUnit:'imported-unit.json', zeroBasedRanges:[{row:2,column:0},{row:2,column:1},{row:4,column:1}],
            expectedCaches:{B5:40,B7:30,'说明!B3':40},exportOptions:{...opts,formulaCalculation:sdk.FormulaCalculationMode.FORCED}});
        }
        const outOpts = {...opts,formulaCalculation:sdk.FormulaCalculationMode.FORCED};
        let t = performance.now();
        const buffer = family === 'unit' ? await sdk.exportToBuffer(data,outOpts) : await sdk.exportSnapshotToBuffer(data,outOpts);
        run.stages.exportMs = performance.now()-t;
        const filename = `${kind}.${family}.${branch}.xlsx`;
        await fs.writeFile(path.join(root,filename), buffer);
        run.output={file:filename,bytes:buffer.length,sha256:hash(buffer)};
        t = performance.now();
        const again = await sdk.importBuffer(buffer,{...opts,fileName:filename});
        run.stages.reimportMs=performance.now()-t;
        await writeJson(`${kind}.${family}.${branch}.reimported.json`,again);
        const sheet = Object.values(again.sheets).find(s=>s.name==='明细');
        run.reimportTargets={A3:sheet?.cellData?.[2]?.[0],B3:sheet?.cellData?.[2]?.[1],B5:sheet?.cellData?.[4]?.[1],B7:sheet?.cellData?.[6]?.[1]};
        run.status='exported_pending_independent_validation';
      } catch (e) {
        run.status='failed'; run.error={name:e.name,code:e.code,message:e.message};
      }
      report.runs.push(run);
      await writeJson('sdk-results.json',report);
      console.log(JSON.stringify({kind,family,branch,status:run.status,output:run.output,timing:run.stages,error:run.error}));
    }
  }
}
report.totalMs=performance.now()-started;
await writeJson('sdk-results.json',report);
