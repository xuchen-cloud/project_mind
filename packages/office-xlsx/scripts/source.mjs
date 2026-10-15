import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'))
const patches = JSON.parse(await readFile(join(root, 'patches.json'), 'utf8'))
for (const file of manifest.files) {
  const path = join(root, file.destination)
  const patch = patches.find((p) => p.destination === file.destination)
  if (process.argv.includes('--fetch')) {
    const response = await fetch(`https://raw.githubusercontent.com/genspark-ai/genoffice/${manifest.commit}/${file.path}`)
    if (!response.ok) throw new Error(`Source fetch failed: ${file.path} (${response.status})`)
    const original = Buffer.from(await response.arrayBuffer())
    verifyBlob(original, file)
    let text = new TextDecoder('utf-8', { fatal: true }).decode(original)
    for (const change of [...(patch?.changes ?? [])].reverse()) {
      if (text.slice(change.at, change.at + change.remove.length) !== change.remove) throw new Error(`Patch context changed: ${file.path}`)
      text = text.slice(0, change.at) + change.insert + text.slice(change.at + change.remove.length)
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, patch ? text : original)
  }
  const bytes = await readFile(path)
  if (patch) {
    if (createHash('sha256').update(bytes).digest('hex') !== patch.sha256) throw new Error(`Patched source mismatch: ${file.path}`)
  } else verifyBlob(bytes, file)
}
function verifyBlob(bytes, file) {
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (hash !== file.git_blob_sha1) throw new Error(`Upstream blob mismatch: ${file.path}`)
}
