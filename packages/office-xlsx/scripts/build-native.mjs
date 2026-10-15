import { spawnSync } from 'node:child_process'
import { copyFile, chmod, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.env.OFFICE_RUST_TARGET ?? process.argv.find((arg) => arg.startsWith('--target='))?.slice(9)
const args = ['build', '--locked', '--release', '--manifest-path', join(root, 'native/engine/Cargo.toml'),
  '--config', join(root, 'native/engine/.cargo/config.toml'),
  '--target-dir', join(root, 'native/target'), ...(target ? ['--target', target] : [])]
const env = { ...process.env }
delete env.CARGO_BUILD_TARGET
const result = spawnSync('cargo', args, { stdio: 'inherit', env })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const suffix = target?.includes('windows') || (!target && process.platform === 'win32') ? '.exe' : ''
const name = `xlsx-sidecar${suffix}`
await mkdir(join(root, 'dist'), { recursive: true })
await copyFile(join(root, 'native/target', ...(target ? [target] : []), 'release', name), join(root, 'dist', name))
if (!suffix) await chmod(join(root, 'dist', name), 0o755)
