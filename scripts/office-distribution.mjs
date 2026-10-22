import { mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { desktopRuntimeTarget } from './desktop-runtime-target.mjs';

// Reuse the Word build tools already installed by build:office.
const require = createRequire(new URL('../packages/office-docx/package.json', import.meta.url));
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

async function verifyEngine(bytes, directory, format, { build, ts }) {
  const fail = detail => { throw new Error(`Office ${format} engine closure changed: ${detail}`); };
  const source = bytes.toString('utf8');
  // Analyze the exact bytes to be distributed, without regenerating format dist.
  let result;
  try {
    result = await build({ stdin: { contents: source, resolveDir: directory, sourcefile: 'engine.mjs' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', treeShaking: false,
      write: false, metafile: true, logLevel: 'silent' });
  } catch (error) { fail(error.message); }
  if (result.warnings.length || Object.keys(result.metafile.inputs).length !== 1) fail('expected one self-contained engine');
  for (const file of [...Object.values(result.metafile.inputs), ...Object.values(result.metafile.outputs)]) {
    for (const entry of file.imports) if (!entry.external || !builtins.has(entry.path)) fail(`unexpected import ${entry.path}`);
  }
  // Metadata cannot describe computed imports or filesystem assets addressed
  // through import.meta. Only the existing createRequire and XLSX fallback are allowed.
  const ast = ts.createSourceFile('engine.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const literal = (node, value) => node && ts.isStringLiteral(node) && node.text === value;
  function visit(node) {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && /^(?:__)?require$/.test(node.expression.text))) {
      if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]) || !builtins.has(node.arguments[0].text)) fail('unexpected runtime module load');
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const url = node.parent, call = url.parent;
      const isUrl = ts.isPropertyAccessExpression(url) && url.name.text === 'url';
      const createRequire = isUrl && ts.isCallExpression(call) && /^(?:__)?createRequire$/.test(call.expression.getText(ast)) &&
        call.arguments.length === 1 && call.arguments[0] === url;
      const choice = ts.isNewExpression(call) ? call.arguments?.[0] : undefined;
      const sidecar = isUrl && format === 'xlsx' && ts.isNewExpression(call) && call.expression.getText(ast) === 'URL' &&
        call.arguments?.length === 2 && call.arguments[1] === url && choice && ts.isConditionalExpression(choice) &&
        ts.isBinaryExpression(choice.condition) && choice.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        choice.condition.left.getText(ast) === 'process.platform' && literal(choice.condition.right, 'win32') &&
        literal(choice.whenTrue, './xlsx-sidecar.exe') && literal(choice.whenFalse, './xlsx-sidecar');
      if (!createRequire && !sidecar) fail('unexpected import.meta resource');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

export async function assembleOfficeDistribution(root, rustTarget) {
  const target = desktopRuntimeTarget(rustTarget, {});
  // Load the isolated build tools only when assembling a completed Office build.
  const tools = { build: require('esbuild').build, ts: require('typescript') };
  const distribution = path.join(root, 'packages/agent-host/office-dist');
  const assets = new Map();
  async function include(source, destination) {
    const stat = await lstat(source);
    if (!stat.isFile()) throw new Error(`Office asset must be a regular file: ${source}`);
    assets.set(destination, { bytes: await readFile(source), mode: stat.mode });
  }
  for (const format of ['docx', 'xlsx', 'pptx']) {
    for (const name of ['engine.mjs', 'THIRD-PARTY-NOTICES.txt', ...(format === 'xlsx' ? ['LICENSE', 'NOTICE'] : [])]) {
      await include(path.join(root, `packages/office-${format}/dist`, name), `${format}/${name}`);
    }
    await verifyEngine(assets.get(`${format}/engine.mjs`).bytes, path.join(root, `packages/office-${format}/dist`), format, tools);
    assets.set(`${format}-engine.mjs`, { bytes: Buffer.from(`export * from './${format}/engine.mjs';\n`) });
  }
  const executable = target.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
  await include(path.join(root, 'packages/office-xlsx/dist', executable), executable);
  await include(path.join(root, 'packages/office-runtime/worker.mjs'), 'worker.mjs');
  // Read the complete snapshot before replacing the previous distribution.
  await rm(distribution, { recursive: true, force: true });
  await mkdir(distribution, { recursive: true });
  const files = [];
  for (const [file, { bytes, mode }] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(path.dirname(path.join(distribution, file)), { recursive: true });
    await writeFile(path.join(distribution, file), bytes, { mode });
    files.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = { schemaVersion: 1, rustTarget: target.rustTarget, runtimeTarget: target.runtimeTarget,
    upstream: 'd32d1711f1bf985430757b8c6b3fbddd3831d946', files };
  await writeFile(path.join(distribution, 'office-distribution.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/office-distribution.mjs <Rust target triple>');
  await assembleOfficeDistribution(fileURLToPath(new URL('..', import.meta.url)), process.argv[2]);
}
