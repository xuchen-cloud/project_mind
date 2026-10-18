import { readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const sections = ['Office XLSX third-party notices\n\nGenOffice d32d1711f1bf985430757b8c6b3fbddd3831d946\nhttps://github.com/genspark-ai/genoffice\nLocal changes: patches.json (planner cache sheets, typed native recalc, UTF-8, temp-root boundary and private temporary candidate promotion).',
  await readFile(join(root, 'LICENSE'), 'utf8'), await readFile(join(root, 'NOTICE'), 'utf8')]
sections.push('Browser adaptation reference: Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4; see fork-source-lock.json. Local File bridge; relay not included.', await readFile(join(root,'fork-research/LICENSE'),'utf8'))
sections.push('Bundled Carlito fonts (original upstream files, SIL OFL 1.1)', await readFile(join(root,'vendor/apps/docs/src/renderer/fonts/LICENSE-OFL.txt'),'utf8'))
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || entry.dev) continue
  if (path.includes('@univerjs-pro/')) throw new Error('Proprietary Univer package in OSS build')
  const dir = join(root, path)
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  sections.push(`${pkg.name} ${pkg.version}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\nSource: ${entry.resolved ?? ''}`)
  sections.push(...await licenseTexts(dir))
}
const compiler = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
if (compiler.error || compiler.status !== 0) throw compiler.error ?? new Error(compiler.stderr)
const target = process.env.OFFICE_RUST_TARGET ?? compiler.stdout.match(/^host: (.+)$/m)[1]
const metadata = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target,
  '--manifest-path', join(root, 'native/engine/Cargo.toml')], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (metadata.error || metadata.status !== 0) throw metadata.error ?? new Error(metadata.stderr)
for (const pkg of JSON.parse(metadata.stdout).packages.sort((a, b) => a.name.localeCompare(b.name))) {
  sections.push(`Rust: ${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'See bundled LICENSE'}\nSource: ${pkg.source ?? 'GenOffice fixed source, locally patched'}`)
  sections.push(...await licenseTexts(dirname(pkg.manifest_path)))
}
await writeFile(join(root, 'dist/THIRD-PARTY-NOTICES.txt'), sections.join('\n\n============================================================\n\n') + '\n')
async function licenseTexts(dir) {
  const names = (await readdir(dir)).filter((name) => /^(license|licence|notice|copying|copyright)([.-]|$)/i.test(name)).sort()
  const contents = []
  for (const name of names) {
    const result = await readFile(join(dir, name)).catch((error) => { if (error.code === 'EISDIR') return null; throw error })
    if (result) contents.push(`${name}\n${new TextDecoder('utf-8', { fatal: true }).decode(result)}`)
  }
  return contents
}
