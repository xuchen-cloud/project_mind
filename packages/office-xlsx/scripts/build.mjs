import { build } from 'esbuild'
import { disposedAutoHeightPatch } from './patch-univer.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { copyFile } from 'node:fs/promises'
const root = fileURLToPath(new URL('../', import.meta.url))
await import('./source.mjs')
await import('./extract-upstream.mjs')
await build({
  absWorkingDir: root, entryPoints: ['engine.ts'], outfile: 'dist/engine.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  alias: { '@genoffice/zip-gate': resolve(root, 'vendor/packages/zip-gate/src/index.ts'), '@genoffice/xlsx-gateway': resolve(root, 'vendor/packages/xlsx-gateway/src') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})
if (process.argv.includes('--engine-only')) process.exit(0)
await (await import('./build-renderer.mjs')).buildRenderer()
await build({
  absWorkingDir: root, entryPoints: ['frame-browser.ts'], outfile: 'dist/browser.mjs',
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  alias: { '@genoffice/xlsx-gateway': resolve(root, 'vendor/packages/xlsx-gateway/src') },
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true,
  legalComments: 'linked', plugins: [disposedAutoHeightPatch],
})
await copyFile(resolve(root, 'browser.d.mts'), resolve(root, 'dist/browser.d.mts'))
await (await import('node:fs/promises')).writeFile(resolve(root, 'dist/types.d.ts'), "export * from '../types'\n")
await copyFile(resolve(root, 'LICENSE'), resolve(root, 'dist/LICENSE'))
await copyFile(resolve(root, 'NOTICE'), resolve(root, 'dist/NOTICE'))
if (!process.argv.includes('--skip-native')) await import('./build-native.mjs')
await import('./notices.mjs')
