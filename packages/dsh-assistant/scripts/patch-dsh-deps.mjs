// Pure-JS fixes for the two pinned rc.2 packages that compare/encode paths
// crossing Rust canonicalize and Node realpath. Also run explicitly after the
// release install, which intentionally disables all npm lifecycle scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDirectory } from './context-directory.mjs';

const defaultRoot = path.resolve(import.meta.dirname, '..', 'node_modules', '@deepseek-ai');
const helper = name => `const ${name} = (${normalizeDirectory.toString()});`;
const count = (source, anchor) => source.split(anchor).length - 1;
function replaceExact(source, before, after, label) {
  const applied = count(source, after);
  if (applied === 1 && count(source, before) === count(after, before)) return source;
  if (applied !== 0 || count(source, before) !== 1) throw new Error(`[patch-dsh-deps] pinned anchor mismatch: ${label}`);
  return source.replace(before, after);
}

function persistencePatch(source) {
  const empty = 'if (cwd.length === 0) throw new Error("cannot encode an empty project path");';
  const old = `${empty} if (cwd.startsWith(String.fromCharCode(92,92,63,92))) cwd = cwd.slice(4);`;
  const patched = `${empty} cwd = _mindNormalizeDirectory(cwd);`;
  if (source.includes(old)) source = replaceExact(source, old, patched, 'session projectKey v1');
  else {
    if (source.includes('String.fromCharCode(92,92,63,92)')) throw new Error('[patch-dsh-deps] unknown session path patch');
    source = replaceExact(source, empty, patched, 'session projectKey');
  }
  if (source.includes('const _mindNormalizeDirectory') && !source.includes(helper('_mindNormalizeDirectory'))) throw new Error('[patch-dsh-deps] unknown session path helper');
  const anchor = 'function projectKey(cwd) {';
  return replaceExact(source, anchor, `${helper('_mindNormalizeDirectory')}\n${anchor}`, 'session path helper');
}

function workspacePatch(source) {
  const anchor = 'return await realpath(path);\n}';
  const oldHelper = "const _vprefix = win32.sep + win32.sep + '?' + win32.sep;\nfunction _stripV(p) { return p && typeof p === 'string' && p.startsWith(_vprefix) ? p.slice(_vprefix.length) : p; }";
  if (source.includes(oldHelper)) source = replaceExact(source, oldHelper, helper('_stripV'), 'workspace path helper v1');
  if (source.includes('function _stripV') || source.includes('const _vprefix')
    || source.includes('const _stripV') && !source.includes(helper('_stripV'))) throw new Error('[patch-dsh-deps] unknown workspace path patch');
  source = replaceExact(source, anchor, `${anchor}\n${helper('_stripV')}`, 'workspace path helper');
  for (const [before, after, label] of [
    ['this.record = record;', 'this.record = record && record.path ? { ...record, path: _stripV(record.path) } : record;', 'record path'],
    ['if (cwd !== this.record.path) throw new Error', 'const wsp = await realpathNormalize(this.record.path); if (cwd !== wsp) throw new Error', 'attach path'],
    ['this.host.sessionPath(id) === changed.path', '_stripV(this.host.sessionPath(id)) === _stripV(changed.path)', 'mutation membership'],
  ]) source = replaceExact(source, before, after, label);
  const pattern = /(\.\.\.changed,\n)([ \t]+)(sessionIds,)/g;
  const applied = [...source.matchAll(/\.\.\.changed,\n([ \t]+)path: _stripV\(changed.path\),\n\1sessionIds,/g)].length;
  const pending = [...source.matchAll(pattern)].length;
  if (applied === 0 && pending === 1) {
    source = source.replace(pattern, '$1$2path: _stripV(changed.path),\n$2$3');
  } else if (applied !== 1 || pending !== 0) throw new Error('[patch-dsh-deps] pinned anchor mismatch: mutation path');
  return source;
}

export function patchDshDependencies(root = defaultRoot) {
  // Validate both complete patches before writing either file. A missing pinned
  // anchor is a build failure, never a warning that ships an unpatched runtime.
  const files = [
    ['dsh-session-persistence-jsonl/lib/index.js', persistencePatch],
    ['dsh-workspace/lib/index.js', workspacePatch],
  ].map(([relative, patch]) => {
    const file = path.join(root, relative);
    const before = fs.readFileSync(file, 'utf8');
    return { file, before, after: patch(before) };
  });
  const changed = [];
  for (const { file, before, after } of files) if (before !== after) {
    fs.writeFileSync(file, after);
    changed.push(file);
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = patchDshDependencies(process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot);
  console.log(`[patch-dsh-deps] ready (${changed.length} files updated)`);
}
