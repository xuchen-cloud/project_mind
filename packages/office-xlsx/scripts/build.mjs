import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { copyFile } from 'node:fs/promises'
const root = fileURLToPath(new URL('../', import.meta.url))
await import('./source.mjs')
await build({
  absWorkingDir: root, entryPoints: ['engine.ts'], outfile: 'dist/engine.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  alias: { '@genoffice/zip-gate': resolve(root, 'vendor/packages/zip-gate/src/index.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})
if (process.argv.includes('--engine-only')) process.exit(0)
await build({
  absWorkingDir: root, entryPoints: ['browser.ts'], outfile: 'dist/browser.mjs',
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true,
  legalComments: 'linked',
})
await copyFile(resolve(root, 'browser.d.mts'), resolve(root, 'dist/browser.d.mts'))
await copyFile(resolve(root, 'types.ts'), resolve(root, 'dist/types.d.ts'))
await copyFile(resolve(root, 'LICENSE'), resolve(root, 'dist/LICENSE'))
await copyFile(resolve(root, 'NOTICE'), resolve(root, 'dist/NOTICE'))
await import('./build-native.mjs')
await import('./notices.mjs')
