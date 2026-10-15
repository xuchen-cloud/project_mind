// F03 validation only: scratch candidates, never writes a Project File.
import { defineConfig } from 'vite';
import { exportToBuffer, ExchangeFormat, FormulaCalculationMode } from '@univerjs-pro/exchange-node';
import { UniverInstanceType } from '@univerjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.join(harnessRoot, 'browser/output');

export default defineConfig({
  root: harnessRoot,
  server: { host: '127.0.0.1', port: 1438, strictPort: true },
  plugins: [{
    name: 'office-validation-output',
    configureServer(server) {
      server.middlewares.use('/validation/export', async (req, res) => {
        try {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const { format, unit } = JSON.parse(Buffer.concat(chunks).toString());
          const types = { docx: UniverInstanceType.UNIVER_DOC, xlsx: UniverInstanceType.UNIVER_SHEET, pptx: UniverInstanceType.UNIVER_SLIDE };
          if (!types[format]) throw new Error('Unsupported probe format');
          const bytes = await exportToBuffer(unit, { type: types[format], format: ExchangeFormat[format.toUpperCase()], ...(format === 'xlsx' ? { formulaCalculation: FormulaCalculationMode.FORCED } : {}) });
          await mkdir(outputRoot, { recursive: true });
          await writeFile(path.join(outputRoot, `${format}.unit.json`), JSON.stringify(unit));
          await writeFile(path.join(outputRoot, `${format}.browser-edited.${format}`), bytes);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, name: e.name, code: e.code, message: e.message }));
        }
      });
    },
  }],
});
