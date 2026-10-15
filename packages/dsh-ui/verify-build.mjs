import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { dshUiAliases } from './vite-aliases.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(new URL('./provenance.json', import.meta.url), 'utf8'));
const work = await fs.mkdtemp(path.join(root, 'packages/dsh-ui/.verify-'));
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-dsh-ui-build-'));
try {
  const entry = path.join(work, 'entry.ts');
  await fs.writeFile(entry, manifest.packages.map((pkg, index) =>
    `export * as package${index} from '${pkg.name}/client';`).join('\n') +
    `\nexport * as preview from '${fileURLToPath(new URL('./preview/index.jsx', import.meta.url))}';\n${process.argv.includes('--source-only') ? '' : "export * as adapters from '@project-mind/dsh-ui/adapters';"}\nimport ${JSON.stringify(fileURLToPath(new URL('./styles/scoped.css', import.meta.url)))};\n`);
  let modules = 0;
  await build({
    configFile: false, root, plugins: [react(), {
      name: 'verify-dsh-browser-closure',
      generateBundle(_, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          if (chunk.imports.some(id => !bundle[id]) || /\bModuleLoader\b|__vite-browser-external/u.test(chunk.code))
            throw new Error('DSH browser build contains an unresolved import or host loader: ' + chunk.fileName + ' ' + chunk.imports.join(', '));
          modules += Object.keys(chunk.modules).length;
        }
      },
    }],
    resolve: { alias: dshUiAliases, dedupe: ['react', 'react-dom'] }, logLevel: 'error',
    build: { minify: false, lib: { entry, formats: ['es'] }, outDir: output, emptyOutDir: true,
      rollupOptions: { onwarn(warning) {
        if (warning.code === 'UNRESOLVED_IMPORT' || warning.code === 'MISSING_EXPORT') throw new Error(warning.message);
      } } },
  });
  console.log(`DSH browser closure: ${manifest.packages.length} source entries, ${modules} modules; no ModuleLoader or unresolved browser imports.`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
  await fs.rm(output, { recursive: true, force: true });
}
