import './sources.mjs';
import './generate-parity.mjs';
import { buildParityFrame } from './build-parity-frame.mjs';
import { parityPlugins } from './parity-build.mjs';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
const frameMeta=await buildParityFrame();
const dependencyRoots = new Set();
for(const path of Object.keys(frameMeta.inputs))if(path.startsWith('node_modules/'))dependencyRoots.add(path.split('/').slice(0,path.split('/')[1].startsWith('@')?3:2).join('/'));
for (const [entry, platform, external] of [
  ['engine', 'node', []],
  ['browser', 'browser', ['react', 'react/jsx-runtime']],
]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [`${entry}.${entry === 'browser' ? 'tsx' : 'ts'}`],
    outfile: `dist/${entry}.mjs`, bundle: true, platform, format: 'esm',
    plugins: parityPlugins(root,{browser:platform==='browser'}),
    target: 'es2021', jsx: 'automatic', external, metafile: true, legalComments: 'inline',
    ...(platform === 'node' ? { banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } } : {}),
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    if (/(?:^|\/)ee\//.test(path)) throw new Error('Unexpected enterprise source');
    if (path.startsWith('node_modules/')) dependencyRoots.add(path.split('/').slice(0, path.split('/')[1].startsWith('@') ? 3 : 2).join('/'));
  }
  const allowedImports = platform === 'node' ? [...builtinModules, ...builtinModules.map(m => `node:${m}`)] : external;
  for (const output of Object.values(result.metafile.outputs)) if (output.imports.some(i => !allowedImports.includes(i.path))) throw new Error(`Nonportable ${entry} bundle import`);
  await writeFile(`${root}/dist/${entry}-metafile.json`, JSON.stringify(result.metafile, null, 2) + '\n');
  await copyFile(`${root}/declarations/${entry}.d.mts`, `${root}/dist/${entry}.d.mts`);
}
const sources = [
  'vendor/LICENSE', 'vendor/NOTICE', 'vendor/LICENSE-UNICODE.txt',
  'vendor/packages/pptx-engine/src/vendor/mtx/LICENSE',
  'licenses/nodable-LICENSE',
  'vendor/packages/docx-engine/src/vendor/emf-converter/LICENSE',
  'vendor/apps/docs/src/renderer/fonts/LICENSE-OFL.txt',
  'vendor/packages/ui/src/fonts/README.md',
  'fork-source-lock.json',
];
const notices = ['Browser picker adaptation: Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4 (Apache-2.0). The relay is not used; native CAS remains authoritative.','GenOffice core: https://github.com/genspark-ai/genoffice\nRevision: d32d1711f1bf985430757b8c6b3fbddd3831d946\nProject Mind adapter: local modifications are separate from unmodified vendor sources.'];
for (const path of sources) notices.push(`${path}\n${await readFile(`${root}/${path}`, 'utf8')}`);
for (const dependency of [...dependencyRoots].sort()) {
  const pkg = JSON.parse(await readFile(`${root}/${dependency}/package.json`, 'utf8'));
  const licenses = (await readdir(`${root}/${dependency}`)).filter(f => /^(?:license|copying)(?:\.|$)/i.test(f)).sort();
  notices.push(`${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See bundled attribution'}\n${pkg.repository?.url ?? ''}`);
  for (const file of licenses) notices.push(`${dependency}/${file}\n${await readFile(`${root}/${dependency}/${file}`, 'utf8')}`);
  if (!licenses.length) {
    // These two published packages carry attribution in README/source rather
    // than a standalone license file; include both without inventing a license.
    if (!['isarray', '@nodable/entities'].includes(pkg.name)) throw new Error(`Missing dependency license: ${pkg.name}`);
    notices.push(`${dependency}/README.md\n${await readFile(`${root}/${dependency}/README.md`, 'utf8')}`);
  }
}
await writeFile(`${root}/dist/THIRD-PARTY-NOTICES.txt`, notices.join('\n\n====================\n\n'));
