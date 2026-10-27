// Re-applies local \\?\ verbatim-prefix fixes to vendored @deepseek-ai deps.
// node_modules is gitignored, so these patches must be re-applied to survive
// fresh installs. Idempotent: skips a file if its patch marker is already present.
//
// Root cause being patched: Rust Path::canonicalize adds the \\?\ prefix while
// node fs.realpath strips it, so the same directory is encoded two ways across
// the Rust/node boundary. The downstream fixes (normalizeDirectory helpers in
// the dsh-assistant scripts) keep node-side comparisons consistent, but two
// vendored package internals also encode paths and must strip the prefix too:
//   - dsh-session-persistence-jsonl: projectKey() must strip \\?\ so
//     assertStoredIdentity agrees with the migration's projectKey.
//   - dsh-workspace: record.path / session attach / mutate filter must strip
//     \\?\ so Rust-prefixed paths match node-realpath-stripped paths.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, '..', 'node_modules', '@deepseek-ai');

function applyPatch(rel, marker, ops) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.warn(`[patch-dsh-deps] missing: ${rel}`); return; }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) { console.log(`[patch-dsh-deps] already patched: ${rel}`); return; }
  let changed = false;
  for (const op of ops) {
    if (op.pattern instanceof RegExp) {
      const next = src.replace(op.pattern, op.replacement);
      if (next === src) console.warn(`[patch-dsh-deps] regex no-match in ${rel}: ${op.pattern}`);
      else { src = next; changed = true; }
    } else {
      if (!src.includes(op.from)) { console.warn(`[patch-dsh-deps] anchor missing in ${rel}: ${op.from.slice(0, 60)}...`); continue; }
      src = src.replace(op.from, op.to); changed = true;
    }
  }
  if (changed) { fs.writeFileSync(file, src); console.log(`[patch-dsh-deps] patched: ${rel}`); }
  else console.warn(`[patch-dsh-deps] no changes applied to ${rel}`);
}

// dsh-session-persistence-jsonl: projectKey strips \\?\ so assertStoredIdentity
// (projectKey(header.cwd)) agrees with the session storage directory.
applyPatch('dsh-session-persistence-jsonl/lib/index.js', 'String.fromCharCode(92,92,63,92)', [
  {
    from: 'if (cwd.length === 0) throw new Error("cannot encode an empty project path");',
    to:   'if (cwd.length === 0) throw new Error("cannot encode an empty project path"); if (cwd.startsWith(String.fromCharCode(92,92,63,92))) cwd = cwd.slice(4);',
  },
]);

// dsh-workspace: normalize \\?\ on record.path + session attach/compare.
applyPatch('dsh-workspace/lib/index.js', '_stripV', [
  // 1) helper after realpathNormalize
  {
    from: 'return await realpath(path);\n}',
    to:   'return await realpath(path);\n}\nconst _vprefix = win32.sep + win32.sep + \'?\' + win32.sep;\nfunction _stripV(p) { return p && typeof p === \'string\' && p.startsWith(_vprefix) ? p.slice(_vprefix.length) : p; }',
  },
  // 2) constructor: strip record.path
  {
    from: 'this.record = record;',
    to:   'this.record = record && record.path ? { ...record, path: _stripV(record.path) } : record;',
  },
  // 3) attachSession: resolve record.path via realpath before comparing cwd
  {
    from: 'if (cwd !== this.record.path) throw new Error',
    to:   'const wsp = await realpathNormalize(this.record.path); if (cwd !== wsp) throw new Error',
  },
  // 4) mutate filter: strip both sides
  {
    from: 'this.host.sessionPath(id) === changed.path',
    to:   '_stripV(this.host.sessionPath(id)) === _stripV(changed.path)',
  },
  // 5) mutate return: insert path: _stripV(changed.path) before sessionIds
  {
    pattern: /(\.\.\.changed,\n)([ \t]+)(sessionIds,)/,
    replacement: '$1$2path: _stripV(changed.path),\n$2$3',
  },
]);

console.log('[patch-dsh-deps] done');
