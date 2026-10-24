import path from 'node:path';
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { optionalLstat, withRootLock } from './skill-management.mjs';

const MAX_ARCHIVE = 10 * 1024 * 1024;
const MAX_EXPANDED = 50 * 1024 * 1024;

function unpack(bytes) {
  let count = 0, total = 0;
  const names = new Set();
  const entries = unzipSync(bytes, { filter(entry) {
    const parts = entry.name.replace(/\/$/, '').split('/');
    if (++count > 1000 || (total += entry.originalSize) > MAX_EXPANDED) throw new Error('Skill 压缩包过大（最多 1000 项、解压后 50 MB）');
    if (!entry.name || entry.name.includes('\\') || parts.some(part => !part || part === '.' || part === '..'
      || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Skill 压缩包包含不安全的路径');
    const key = parts.join('/').toLowerCase();
    if (names.has(key)) throw new Error('Skill 压缩包包含重复路径');
    names.add(key);
    return true;
  } });
  const files = Object.entries(entries).filter(([name]) => !name.endsWith('/') && !name.startsWith('__MACOSX/') && path.posix.basename(name) !== '.DS_Store');
  const skillFiles = files.filter(([name]) => name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(name));
  if (skillFiles.length !== 1) throw new Error('ZIP 应包含一个 Skill：根目录或单层文件夹中的 SKILL.md');
  const prefix = skillFiles[0][0].slice(0, -'SKILL.md'.length);
  if (files.some(([name]) => !name.startsWith(prefix))) throw new Error('ZIP 中只能包含一个 Skill 目录');
  return files.map(([name, bytes]) => [name.slice(prefix.length), bytes]);
}

// Only creates regular files in a fresh staging directory. Archive permissions,
// links and executable hooks are never applied during installation.
export async function importSkillArchive(archive, root, validate) {
  if (!path.isAbsolute(archive) || !/\.(zip|skill)$/i.test(archive)) throw new Error('请选择 Skill ZIP 压缩包');
  const handle = await open(archive, 'r');
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ARCHIVE) throw new Error('Skill ZIP 最大为 10 MB');
    // Bound the actual read too, even if another process grows the file.
    bytes = Buffer.alloc(MAX_ARCHIVE + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_ARCHIVE) throw new Error('Skill ZIP 最大为 10 MB');
    bytes = bytes.subarray(0, length);
  } finally { await handle.close(); }
  const files = unpack(bytes);
  await mkdir(root, { recursive: true });
  if ((await optionalLstat(root)).isSymbolicLink()) throw new Error('Skills 安装目录不能是符号链接');
  return withRootLock(root, async canonicalRoot => {
    const staging = await mkdtemp(path.join(canonicalRoot, '.skill-import-'));
    try {
      const bundle = path.join(staging, 'bundle');
      await mkdir(bundle);
      for (const [name, content] of files) {
        const target = path.join(bundle, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { flag: 'wx' });
      }
      const name = await validate(staging);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Skill name 必须是最多 64 字符的小写字母、数字和连字符');
      const destination = path.join(canonicalRoot, name);
      if (await optionalLstat(destination) || await optionalLstat(path.join(canonicalRoot, '.disabled', name))) throw new Error(`Skill 已存在：${name}，请先管理已有 Skill`);
      if (await realpath(root) !== canonicalRoot) throw new Error('Skills 目录已变化，请重新导入');
      await rename(bundle, destination);
      return name;
    } finally { await rm(staging, { recursive: true, force: true }); }
  });
}
