import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'source-lock.json'), 'utf8'));
if (lock.commit !== 'd32d1711f1bf985430757b8c6b3fbddd3831d946') throw Error('Unexpected source commit');
const args = process.argv.slice(2);
const sourceAt = args.indexOf('--source');
const source = sourceAt < 0 ? null : args[sourceAt + 1];
if (sourceAt >= 0 && !source) throw Error('--source requires an upstream source directory');
const verifyOnly = args.includes('--verify-only');
function valid(bytes, row) {
  return bytes.length === row.bytes && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === row.git_blob_sha1;
}
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < lock.files.length) {
    const row = lock.files[next++];
    if (row.path.startsWith('/') || row.path.split('/').includes('..')) throw Error('Invalid locked path');
    const dest = resolve(root, 'upstream', row.path);
    let bytes;
    try { bytes = await readFile(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (bytes && valid(bytes, row)) continue;
    if (verifyOnly) throw Error(`Missing or mismatched source: ${row.path}`);
    if (source) bytes = await readFile(resolve(source, row.path));
    else {
      const response = await fetch(`https://raw.githubusercontent.com/genspark-ai/genoffice/${lock.commit}/${row.path}`);
      if (!response.ok) throw Error(`Fetch ${row.path}: ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (!valid(bytes, row)) throw Error(`Git blob mismatch: ${row.path}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
}));
console.log(`Verified ${lock.files.length} GenOffice files at ${lock.commit}`);
