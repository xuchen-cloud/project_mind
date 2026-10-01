import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordWorkerNoticeAssets } from './record-worker-notices.mjs';
const root = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const checksum = value => createHash('sha256').update(value).digest('hex');

export async function sourceWorkerAssets(bundle) {
  const { notices: packageNotices, manifest } = await recordWorkerNoticeAssets(bundle, 'source extraction utility');
  const assets = []; const resourceNotices = [];
  for (const [directory, destination] of [['cmaps', 'pdf-cmaps'], ['standard_fonts', 'pdf-fonts']]) {
    for (const name of (await readdir(path.join(root, directory))).sort()) {
      const location = path.join(root, directory, name);
      const info = await lstat(location);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid PDF parser resource');
      const source = await readFile(location);
      const fileName = `${destination}/${name}`;
      assets.push({ type: 'asset', fileName, source });
      if (name.startsWith('LICENSE')) resourceNotices.push(`PDF.js ${directory}/${name}\n${source.toString('utf8')}`);
    }
  }
  if (resourceNotices.length !== 3) throw new Error('Incomplete PDF CMap/font license notices');
  const notices = packageNotices + '\n' + resourceNotices.join('\n');
  return { notices, assets, manifest: { ...manifest, noticesChecksum: checksum(notices), assets: assets.map(asset => ({ file: asset.fileName, checksum: checksum(asset.source) })) } };
}

export async function verifySourceWorkerDistribution(directory) {
  const readRegular = async file => {
    if (!/^(?:source-[A-Za-z0-9_.-]+\.mjs|source-worker-distribution\.json|SOURCE-THIRD-PARTY-NOTICES\.txt|pdf-(?:cmaps|fonts)\/[A-Za-z0-9_.-]+)$/u.test(file)) throw new Error('Invalid source distribution file');
    const parent = await lstat(path.dirname(path.join(directory, file)));
    const location = path.join(directory, file); const info = await lstat(location);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()) throw new Error('Invalid source distribution resource');
    return readFile(location);
  };
  const bytes = await readRegular('source-worker-distribution.json');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bundles) || !Array.isArray(manifest.assets)
    || !manifest.bundles.some(entry => entry.file === 'source-extraction-worker.mjs')
    || !Array.isArray(manifest.packages) || !manifest.packages.some(entry => entry.name === 'pdfjs-dist')) throw new Error('Incomplete source distribution manifest');
  const notices = await readRegular('SOURCE-THIRD-PARTY-NOTICES.txt');
  if (checksum(notices) !== manifest.noticesChecksum) throw new Error('Source distribution notices differ from the build');
  const seen = new Set();
  for (const entry of [...manifest.bundles, ...manifest.assets]) {
    if (seen.has(entry.file)) throw new Error('Duplicate source resource'); seen.add(entry.file);
    if (checksum(await readRegular(entry.file)) !== entry.checksum) throw new Error('Source distribution resource differs from the build');
  }
  return { manifest, manifestChecksum: checksum(bytes) };
}
