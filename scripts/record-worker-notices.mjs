import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const checksum = (text) => createHash('sha256').update(text).digest('hex');
const vendorLicenses = fileURLToPath(new URL('./vendor-licenses/', import.meta.url));
const licenseSupplements = {
  'proxy-agent-negotiate@1.1.0': ['MIT', 'proxy-agent-negotiate-1.1.0.LICENSE'],
  'standardwebhooks@1.1.1': ['MIT', 'standardwebhooks-1.1.1.LICENSE'],
};

function packageRoot(moduleId) {
  const normalized = moduleId.replaceAll('\\', '/').replace(/^\0/, '').split('?')[0];
  const marker = '/node_modules/';
  const start = normalized.lastIndexOf(marker);
  if (start < 0) return null;
  const parts = normalized.slice(start + marker.length).split('/');
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return normalized.slice(0, start + marker.length) + name;
}

/** Include only packages present in emitted chunks, including transitive ones.
 * Missing license text fails the build so packaging cannot silently omit it. */
export async function recordWorkerNoticeAssets(bundle, utility = 'Record document utility') {
  const chunks = Object.values(bundle).filter((entry) => entry.type === 'chunk');
  const roots = [...new Set(chunks.flatMap((chunk) => Object.keys(chunk.modules).map(packageRoot)).filter(Boolean))];
  const { notices, packages } = await packageNoticeAssets(roots, utility);
  return { notices, manifest: {
    schemaVersion: 1,
    noticesChecksum: checksum(notices),
    bundles: chunks.map((chunk) => ({ file: chunk.fileName, checksum: checksum(chunk.code) })).sort((a, b) => a.file.localeCompare(b.file, 'en')),
    packages,
  } };
}

/** Also used for the installed DSH production tree, including nested dependencies. */
export async function packageNoticeAssets(roots, utility) {
  const packages = await Promise.all(roots.map(async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const files = (await readdir(root)).filter((name) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name)).sort();
    const texts = [];
    for (const name of files) {
      const info = await lstat(path.join(root, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid license file for ${manifest.name}: ${name}`);
      texts.push({ name, text: await readFile(path.join(root, name), 'utf8') });
    }
    // boolbase@1.0.0's npm archive declares ISC but omits the license file.
    // Retain the upstream author's complete notice at a fixed source revision.
    if (!texts.length && manifest.name === 'boolbase' && manifest.version === '1.0.0' && manifest.license === 'ISC') {
      texts.push({ name: 'LICENSE (upstream 54811f01c797a6bb1c263183ae90b7dd627e0638)', text: await readFile(path.join(vendorLicenses, 'boolbase-1.0.0.LICENSE'), 'utf8') });
    }
    if (!texts.length) {
      const supplement = licenseSupplements[`${manifest.name}@${manifest.version}`];
      if (supplement && manifest.license === supplement[0]) {
        texts.push({ name: supplement[1], text: await readFile(path.join(vendorLicenses, supplement[1]), 'utf8') });
      }
      // data-uri-to-buffer publishes its complete MIT notice in README.md.
      if (manifest.name === 'data-uri-to-buffer' && manifest.version === '4.0.1' && manifest.license === 'MIT') {
        const readme = await readFile(path.join(root, 'README.md'), 'utf8');
        const start = readme.indexOf('(The MIT License)');
        const end = readme.indexOf('\n[rfc]:', start);
        if (start < 0 || end < start) throw new Error('Missing data-uri-to-buffer README license');
        texts.push({ name: 'README.md (License)', text: readme.slice(start, end).trimEnd() + '\n' });
      }
    }
    if (!manifest.name || !manifest.version || !manifest.license || !texts.length) throw new Error(`Missing third-party license text: ${root}`);
    return { name: manifest.name, version: manifest.version, license: manifest.license, texts };
  }));
  packages.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  const notices = `Third-party notices for the Project Mind ${utility}\n`
    + 'Generated from the packages included in this build. Node.js is licensed separately in NODE-LICENSE.\n\n'
    + packages.map((entry) => `${entry.name}@${entry.version}\nLicense: ${typeof entry.license === 'string' ? entry.license : JSON.stringify(entry.license)}\n`
      + entry.texts.map(({ name, text }) => `--- ${name} ---\n${text.trimEnd()}\n`).join('\n')).join('\n' + '='.repeat(80) + '\n\n');
  return { notices, packages: packages.map(({ name, version, license, texts }) => ({ name, version, license,
    licenses: texts.map(({ name, text }) => ({ file: name, checksum: checksum(text) })) })) };
}

export async function verifyRecordWorkerDistribution(directory) {
  const readRegular = async (name) => {
    if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Invalid utility distribution file name');
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid utility distribution file: ${name}`);
    return readFile(file);
  };
  const manifest = JSON.parse(await readRegular('record-worker-distribution.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || !manifest.packages.length
    || !Array.isArray(manifest.bundles) || !manifest.bundles.some((entry) => entry.file === 'record-document-worker.mjs')) throw new Error('Invalid utility distribution manifest');
  const notices = await readRegular('THIRD-PARTY-NOTICES.txt');
  if (checksum(notices) !== manifest.noticesChecksum) throw new Error('Utility third-party notices differ from the build manifest');
  for (const entry of manifest.bundles) {
    if (checksum(await readRegular(entry.file)) !== entry.checksum) throw new Error(`Utility bundle differs from the licensed build: ${entry.file}`);
  }
  return { manifest, manifestChecksum: checksum(await readRegular('record-worker-distribution.json')) };
}
