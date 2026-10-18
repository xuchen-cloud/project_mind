/** #118 native acceptance only, after real mutation/autosave on an ISOLATED fixture.
 * Main owns wiring: file = native post-autosave metadata; original = pre-edit v1.
 * Keep the same mounted ProjectFileContent; never set version props or remount to
 * select history. source() reads its actual onSourceReady callback. ready(file)
 * must check the selected native model AND real renderer/paint; renderedText()
 * reads the real renderer including the edited target (canvas API for XLSX/PPTX).
 * contentWitness is nonempty original native content, captured before editing.
 * Run outside performance samples. Local evidence tests are NOT native passes.
 */
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from '../../src/lib/agent-types';
import type { FileBytesResult, ProjectDirectoryFile } from '../../src/lib/file-types';

export interface NativeHistoryHooks {
  root: HTMLElement; file: ProjectDirectoryFile; binding: AgentWorkspaceBinding;
  source(): AgentSourceRef | null;
  ready(file: ProjectDirectoryFile): Promise<Record<string, unknown>>;
  renderedText(): Promise<string>;
}
export interface NativeHistoryOptions {
  isolatedFixture: true; original: ProjectDirectoryFile; editMarker: string; contentWitness: string;
}
function proof(condition: unknown, detail: string): asserts condition {
  if (!condition) throw Error(`Native history proof failed: ${detail}`);
}
function sameFile(a: AgentObjectRef, b: AgentObjectRef): boolean {
  return a.kind === 'file' && b.kind === 'file' && a.workspaceId === b.workspaceId && a.id === b.id &&
    a.scope.kind === 'project' && b.scope.kind === 'project' && a.scope.projectId === b.scope.projectId;
}
export function assertNativeHistoryWitness(input: {
  source: AgentSourceRef | null; expected: ProjectDirectoryFile; text: string;
  contentWitness: string; editMarker: string; historical: boolean; status: string; saveEnabled: boolean;
}): void {
  const { source, expected, text, contentWitness, editMarker, historical, status, saveEnabled } = input;
  proof(source && sameFile(source.object, expected.object) && source.fileVersion === expected.versionNumber &&
    !!expected.contentHash && source.revision === expected.contentHash, 'actual source File/version/hash differs from native baseline');
  const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '');
  proof(!!normalize(contentWitness) && !!editMarker, 'missing native content witness or edit marker');
  proof(normalize(text).includes(normalize(contentWitness)), 'real renderer lost original native content witness');
  proof(text.includes(editMarker) === !historical, historical ? 'history contains the later edit marker' : 'current renderer lost the saved edit marker');
  proof(status === (historical ? '历史版本 · 只读' : '已保存') && !saveEnabled, 'actual read-only/saved status or save control is wrong');
}
export function assertNativeHistoryUnchanged(latest: ProjectDirectoryFile, current: ProjectDirectoryFile,
  before: FileBytesResult, after: FileBytesResult): void {
  for (const value of [current, before, after]) proof(sameFile(value.object, latest.object) &&
    value.versionNumber === latest.versionNumber && !!latest.contentHash && value.contentHash === latest.contentHash,
  'current File/version/hash changed after stale restore');
  proof(current.state === 'ready' && current.name === latest.name && current.relativePath === latest.relativePath,
    'current File location/state changed after stale restore');
  proof(before.base64.length > 0 && before.base64 === after.base64 && before.byteLength === after.byteLength,
    'current original bytes changed after stale restore');
}

export async function runNativeHistoryAcceptance(hooks: NativeHistoryHooks, options: NativeHistoryOptions) {
  const { root, file: latest, binding } = hooks;
  const { original, contentWitness, editMarker } = options;
  proof(options.isolatedFixture === true, 'stale restore is restricted to isolated acceptance fixtures');
  proof(sameFile(original.object, latest.object) && latest.object.workspaceId === binding.workspaceId &&
    original.versionNumber === 1 && latest.versionNumber === 2 && original.state === 'ready' && latest.state === 'ready' &&
    !!original.contentHash && !!latest.contentHash && original.contentHash !== latest.contentHash,
  'requires real pre-edit v1 and completed autosave v2 of the same File');
  const { fileDocumentApi } = await import('../../src/services/fileDocumentApi');
  const { projectFileApi } = await import('../../src/services/projectFileApi');
  const { AgentApiError } = await import('../../src/services/agentApi');
  const fixed = (file: ProjectDirectoryFile) => ({ object: file.object, versionNumber: file.versionNumber, expectedContentHash: file.contentHash! });
  const readCurrent = async () => {
    const current = await projectFileApi.resolve(binding, latest.object);
    proof(current.state === 'ready' && current.contentHash, 'native current File is unavailable');
    return { current, bytes: await projectFileApi.readBytes(binding, fixed(current)) };
  };
  const wait = async <T,>(read: () => T | null | false, label: string): Promise<T> => {
    const until = performance.now() + 15000;
    while (performance.now() < until) { const value = read(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error(`Native history timed out: ${label}`);
  };
  const select = async (name: string) => {
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label="文件查看版本"]');
    proof(trigger && !trigger.disabled, 'actual FileVersionMenu trigger unavailable'); trigger.click();
    // FileVersionMenu portals its menu into document.body; scope by aria-controls.
    const item = await wait(() => {
      const menu = root.ownerDocument.getElementById(trigger.getAttribute('aria-controls') ?? '');
      return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
        .find(row => row.getAttribute('aria-label') === name && !row.disabled) ?? null;
    }, `actual menu item ${name}`);
    item.click();
    await wait(() => trigger.getAttribute('aria-expanded') === 'false', 'version menu selection completed');
  };
  const surface = async (expected: ProjectDirectoryFile, historical: boolean) => {
    await wait(() => {
      const source = hooks.source();
      return source && sameFile(source.object, expected.object) && source.fileVersion === expected.versionNumber &&
        source.revision === expected.contentHash && root.querySelector('.office-file-content__status')?.textContent?.trim() ===
        (historical ? '历史版本 · 只读' : '已保存');
    }, 'actual selected source and status');
    const readiness = await hooks.ready(expected), text = await hooks.renderedText(), source = hooks.source();
    const status = root.querySelector('.office-file-content__status')?.textContent?.trim() ?? '';
    const saveEnabled = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label="保存"]')].some(button => !button.disabled);
    assertNativeHistoryWitness({ source, expected, text, contentWitness, editMarker, historical, status, saveEnabled });
    return { source, readiness, status, saveEnabled, contentWitness, editMarkerPresent: text.includes(editMarker) };
  };
  const before = await readCurrent();
  assertNativeHistoryUnchanged(latest, before.current, before.bytes, before.bytes);
  const versions = await fileDocumentApi.versionsList(binding, { object: latest.object, limit: 50 });
  const retained = versions.versions.find(version => version.versionNumber === original.versionNumber);
  proof(sameFile(versions.object, latest.object) && versions.currentVersionNumber === latest.versionNumber &&
    versions.currentContentHash === latest.contentHash && retained?.contentHash === original.contentHash &&
    !!retained.id && !retained.isCurrent, 'original retained native version ID/hash or current head missing');
  const originalBytes = await projectFileApi.readBytes(binding, fixed(original));
  proof(sameFile(originalBytes.object, original.object) && originalBytes.versionNumber === original.versionNumber &&
    originalBytes.contentHash === original.contentHash && originalBytes.byteLength > 0, 'retained original bytes/hash differ');
  await surface(latest, false);
  await select(`v${original.versionNumber}`);
  const history = await surface(original, true);
  // includeLatest's row passes undefined; clicking plain v2 would pin read-only v2.
  await select(`v${latest.versionNumber}（当前）`);
  const current = await surface(latest, false);
  const requestId = crypto.randomUUID();
  let rejection: unknown = null;
  try { await fileDocumentApi.restore(binding, { object: original.object, versionId: retained.id,
    expectedVersionNumber: original.versionNumber, expectedContentHash: original.contentHash! }, requestId); }
  catch (error) { rejection = error; }
  const after = await readCurrent();
  assertNativeHistoryUnchanged(latest, after.current, before.bytes, after.bytes);
  proof(rejection instanceof AgentApiError && rejection.code === 'REVISION_CONFLICT', 'stale restore was accepted or did not reject with native REVISION_CONFLICT');
  const finalCheck = await surface(latest, false);
  return { kind: 'acceptance', status: 'passed', name: 'native_history_readonly_and_stale_restore', history, current, finalCheck,
    retained: { versionId: retained.id, versionNumber: originalBytes.versionNumber, contentHash: originalBytes.contentHash, byteLength: originalBytes.byteLength },
    staleCAS: { requestId, versionId: retained.id, expectedVersion: original.versionNumber, expectedHash: original.contentHash,
      code: rejection.code, unchangedVersion: after.current.versionNumber,
      unchangedHash: after.current.contentHash, unchangedOriginalBytes: true, byteLength: after.bytes.byteLength },
    scope: 'real ProjectFileContent version menu, native retained bytes, renderer content/read-only status and stale restore CAS; isolated fixture only' };
}
