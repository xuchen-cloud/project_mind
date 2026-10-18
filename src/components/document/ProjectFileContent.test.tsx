import { useState } from "react";
import type { AgentSourceRef } from "../../lib/agent-types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { ProjectFileContent } from "./ProjectFileContent";
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { readBytes: vi.fn(), resolve: vi.fn(), resolveRelated: vi.fn(), openLocal: vi.fn(), applications: vi.fn(), openWith: vi.fn() }, fileBytes: (result: { base64: string }) => Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)) }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const input = { workspaceRoot: "/workspace", projectId: 2, fileId: 7, visible: true, focused: true };
const version = (n: number) => ({ id: String(n), versionNumber: n, name: "sample.txt", createdAt: "2026-10-11", contentHash: `hash${n}`, isCurrent: n === 2 });
function source(n: number, text = `version${n}`, name = "sample.txt", format: "text" | "markdown" | "html" = "text") {
  return { object, versionNumber: n, contentHash: `hash${n}`, title: name, byteLength: new TextEncoder().encode(text).byteLength, format, text, startChar: 0, endChar: [...text].length, totalChars: [...text].length, nextCursor: null, complete: true };
}
async function chooseVersion(version: number) {
  fireEvent.click(screen.getByRole("button", { name: "文件查看版本" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: `v${version}`, exact: true }));
}
function view(props = input) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (next: typeof input) => <QueryClientProvider client={client}><ProjectFileContent {...next} /></QueryClientProvider>;
  return { ...render(wrap(props)), wrap, client };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectFileApi.applications).mockResolvedValue([]);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "sample.txt", name: "sample.txt", versionNumber: 2, contentHash: "hash2", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 2, currentContentHash: "hash2", versions: [version(2), version(1)], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_binding, { versionNumber }) => ({ object, versionNumber, contentHash: `hash${versionNumber}`, name: "sample.txt", mime: "text/plain", byteLength: 8, base64: btoa(`version${versionNumber}`) }));
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, data) => source(data.versionNumber));
});
it('previews without Session or model; latest and fixed version share the same File component', async () => {
  const change = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} onViewChange={change} /></QueryClientProvider>);
  await screen.findByText('version2');
  expect(screen.getByRole('button', { name: '文件查看版本' }).textContent).toBe('v2');
  await chooseVersion(1);
  await screen.findByText('version1');
  expect(change).toHaveBeenCalledWith({ versionNumber: 1, sourceLocator: undefined, line: undefined, page: undefined });
  expect(screen.getAllByRole('region', { name: '项目文件预览' })).toHaveLength(1);
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, { object, versionNumber: 1, expectedContentHash: 'hash1' });
});
it('isolates late byte responses when changing versions', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as ReturnType<typeof projectFileApi.readBytes>);
  const rendered = view();
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, versionNumber: 1 } as typeof input));
  await screen.findByText('version1');
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'old.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') }));
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('checks every source page against the same version/hash and preserves complete Unicode text', async () => {
  const text = 'first\n第二行'; const whole = source(2, text);
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce({ ...whole, text: 'first\n', endChar: 6, nextCursor: 'next', complete: false })
    .mockResolvedValueOnce({ ...whole, text: '第二行', startChar: 6, nextCursor: null, complete: true });
  view({ ...input, line: 2 } as typeof input);
  await screen.findByText('第二行');
  expect(fileDocumentApi.sourceRead).toHaveBeenNthCalledWith(2, binding, { object, versionNumber: 2, expectedContentHash: 'hash2', cursor: 'next', budgetChars: 24000 });
});
it('rejects mixed version pagination instead of rendering partial content', async () => {
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({ ...source(2), versionNumber: 1 });
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('分页不一致');
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('reports the native bound generation rejection', async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValue({ code: 'WORKSPACE_CHANGED', message: '工作区已切换' });
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('工作区已切换');
});
it('reports missing historical snapshot and never retries latest', async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValue({ code: 'snapshot_missing', message: '历史原件不可用' });
  view({ ...input, versionNumber: 1 } as typeof input);
  expect(await screen.findByRole('alert')).toHaveTextContent('历史原件不可用');
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, { object, versionNumber: 1, expectedContentHash: 'hash1' });
});
it('does not read hidden tabs and aborts pending pagination on hiding', async () => {
  const rendered = view({ ...input, visible: false });
  expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
  rendered.rerender(rendered.wrap(input));
  await screen.findByText('version2');
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('uses fixed HTML TextBody source with exact line location and no extra service reads', async () => {
  const html = '<button>unsafe</button>\n<script>window.attack=1</script>';
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.html', mime: 'text/html', byteLength: html.length, base64: btoa(html) });
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue(source(2, html, 'sample.html', 'html'));
  const rendered = view({ ...input, versionNumber: 2, line: 2 } as typeof input);
  const frame = await screen.findByTitle('HTML 文档预览');
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame.getAttribute('srcdoc')).not.toContain('<script');
  expect(rendered.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '源码 / 行定位' }));
  const original = rendered.container.querySelector('[data-textpreview-target="2"]');
  expect(original).toHaveTextContent('<script>window.attack=1</script>');
  expect(fileDocumentApi.sourceRead).toHaveBeenCalledOnce();
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(fileDocumentApi.versionsList).toHaveBeenCalledOnce();
  expect(rendered.container.querySelector('iframe')).toBeNull();
});
it('keeps legacy Office unsupported and does not invoke text parsing', async () => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byteLength: 2, base64: btoa('PK') });
  view();
  await screen.findByText(/此格式暂不支持应用内预览或编辑/);
  expect(fileDocumentApi.sourceRead).not.toHaveBeenCalled();
});
it('opens a system application from a historical File view using only the current File identity', async () => {
  vi.mocked(projectFileApi.applications).mockResolvedValue([{ id: "/Applications/Editor.app", name: "Editor", icon: "data:image/png;base64,iVBORw0KGgo=", isDefault: false }]);
  view({ ...input, versionNumber: 1 } as typeof input);
  await screen.findByText('version1');
  fireEvent.click(screen.getByRole('button', { name: '选择其他应用打开当前原件' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Editor' }));
  await waitFor(() => expect(projectFileApi.openWith).toHaveBeenCalledWith(binding, object, '/Applications/Editor.app'));
  expect(screen.getByText('version1')).toBeVisible();
  expect(projectFileApi.openLocal).not.toHaveBeenCalled();
});
it('retains reading position across hiding and restores it without taking focus', async () => {
  const rendered = view(); await screen.findByText('version2');
  const scroll = rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  scroll.scrollTop = 73; fireEvent.scroll(scroll);
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  rendered.rerender(rendered.wrap(input));
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(73);
});
it('reloads committed invalidation in latest mode and keeps a historical view fixed', async () => {
  const rendered = view(); await screen.findByText('version2');
  // Native UI invalidations share documentVersions; seed its cache entry.
  rendered.client.setQueryData(['documentVersions', 7], {});
  vi.mocked(projectFileApi.readBytes).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 7] }));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  await screen.findByText('version2');
  await chooseVersion(1);
  await screen.findByText('version1');
  vi.mocked(projectFileApi.readBytes).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 7] }));
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
  expect(screen.getByText('version1')).toBeInTheDocument();
});
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
function relatedFixture(rootText: string, rootName: string, rootMime: string, format: 'markdown' | 'html') {
  const imageObject = { ...object, id: '8' }; const styleObject = { ...object, id: '9' };
  vi.mocked(projectFileApi.resolveRelated).mockImplementation(async (_, _object, relativePath) => ({ object: relativePath.endsWith('.css') ? styleObject : imageObject, versionNumber: 3, contentHash: 'asset3', relativePath, state: 'ready', reason: null, name: relativePath, mime: relativePath.endsWith('.css') ? 'text/css' : 'image/png' }));
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_, request) => {
    const isRoot = request.object.id === '7';
    const base64 = isRoot ? btoa(rootText) : request.object.id === '9' ? btoa('h1{color:red}') : pngBase64;
    return { object: request.object, versionNumber: request.versionNumber, contentHash: request.expectedContentHash,
      name: isRoot ? rootName : request.object.id === '9' ? 'style.css' : 'a.png', mime: isRoot ? rootMime : request.object.id === '9' ? 'text/css' : 'image/png', base64, byteLength: atob(base64).length };
  });
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => source(request.versionNumber, rootText, rootName, format));
}
it('loads current Markdown relative and reference images only through bound same-Project File resolution', async () => {
  relatedFixture('# Picture\n\n![direct](images/a.png)\n\n![ref][asset]\n\n[asset]: images/a.png', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view();
  await waitFor(() => expect(rendered.container.querySelectorAll('img[src^="data:image/png"]')).toHaveLength(2));
  expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce();
  expect(projectFileApi.resolveRelated).toHaveBeenCalledWith(binding, object, 'images/a.png');
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, expect.objectContaining({ object: { ...object, id: '8' }, versionNumber: 3, expectedContentHash: 'asset3' }));
});
it('does not mix current images into historical Markdown when dependent snapshots are unavailable', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view({ ...input, versionNumber: 1 } as typeof input);
  await screen.findByText(/历史版本未保留关联资源快照/);
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
  expect(rendered.container.querySelector('img')).toBeNull();
});
it('loads static HTML current image and stylesheet before fixed DSH sanitization in an opaque sandbox', async () => {
  relatedFixture('<link rel="stylesheet" href="style.css"><h1 onclick="attack()">Preview</h1><img src="a.png"><a href="https://example.com">link</a><script>attack()</script>', 'sample.html', 'text/html', 'html');
  view();
  const frame = await screen.findByTitle('HTML 文档预览');
  const html = frame.getAttribute('srcdoc')!;
  expect(html).toContain('h1{color:red}'); expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain('<script'); expect(html).not.toContain('onclick='); expect(html).not.toContain('href=');
  expect(html).toContain("script-src 'none'"); expect(html).toContain("connect-src 'none'");
  expect(frame).toHaveAttribute('sandbox', '');
  expect(projectFileApi.resolveRelated).toHaveBeenCalledTimes(2);
});
it('reports actual denied resources without granting iframe IPC or arbitrary path access', async () => {
  relatedFixture('<h1>Static</h1><img src="../other-project/a.png">', 'sample.html', 'text/html', 'html');
  vi.mocked(projectFileApi.resolveRelated).mockRejectedValue({ code: 'ownership_mismatch', message: '资源不属于此项目' });
  view();
  await screen.findByText(/未加载资源.*资源不属于此项目/);
  const frame = await screen.findByTitle('HTML 文档预览');
  expect(frame.getAttribute('srcdoc')).not.toContain('../other-project');
  expect(frame.getAttribute('srcdoc')).not.toContain('tauri');
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
});
it('ignores late current-image resolution when switching the same File to fixed history', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  let complete!: (value: unknown) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }) as ReturnType<typeof projectFileApi.resolveRelated>);
  const rendered = view();
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, versionNumber: 1 } as typeof input));
  await screen.findByText(/历史版本未保留关联资源快照/);
  await act(async () => complete({ object: { ...object, id: '8' }, versionNumber: 3, contentHash: 'asset3', state: 'ready', reason: null }));
  expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2);
  expect(rendered.container.querySelector('img')).toBeNull();
});
it('reconciles latest before reading the actual registered head, while fixed versions skip live reconciliation', async () => {
  vi.mocked(projectFileApi.resolve).mockImplementation(async () => {
    vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: 'hash3', versions: [version(3), version(2), version(1)], nextCursor: null });
    return { object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null };
  });
  view(); await screen.findByText('version3');
  expect(projectFileApi.resolve).toHaveBeenCalledWith(binding, object);
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, { object, versionNumber: 3, expectedContentHash: 'hash3' });
  vi.mocked(projectFileApi.resolve).mockClear();
  await chooseVersion(1);
  await screen.findByText('version1'); expect(projectFileApi.resolve).not.toHaveBeenCalled();
});
it('shows ambiguity reason in latest and keeps retained history readable even when the live file is unavailable', async () => {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 2, contentHash: 'hash2', state: 'ambiguous', reason: '此路径已被其他文件占用，请核对' });
  view(); await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('此路径已被其他文件占用');
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
  await chooseVersion(1);
  await screen.findByText('version1');
});
it('refreshes current related resources on committed dependency changes and releases its subscription when hidden', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view();
  await waitFor(() => expect(rendered.container.querySelector('img')).not.toBeNull());
  rendered.client.setQueryData(['documentVersions', 8], {});
  vi.mocked(projectFileApi.resolveRelated).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 8] }));
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  vi.mocked(projectFileApi.resolveRelated).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 8] }));
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
});
it('restores shell-supplied scroll and zoom after actual unmount/remount and reports subsequent view changes', async () => {
  const change = vi.fn(); const client = new QueryClient();
  const view = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialView={{ scrollTop: 88, zoom: 1.5 }} onViewChange={change} /></QueryClientProvider>);
  await screen.findByText('version2');
  const scroll = view.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  expect(scroll.scrollTop).toBe(88);
  scroll.scrollTop = 123; fireEvent.scroll(scroll);
  expect(change).toHaveBeenCalledWith({ scrollTop: 123 });
  view.unmount();
  const reopened = render(<QueryClientProvider client={client}><ProjectFileContent {...input} versionNumber={2} initialView={{ scrollTop: 123 }} /></QueryClientProvider>);
  await screen.findByText('version2');
  expect((reopened.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(123);
});
it('renders an image normally when a retained source mode belongs to an older text version', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:image-after-text'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const client = new QueryClient();
  const rendered = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialSourceMode /></QueryClientProvider>);
  await waitFor(() => expect(rendered.container.querySelector('img')).toHaveAttribute('src', 'blob:image-after-text'));
  expect(screen.queryByRole('button', { name: '源码 / 行定位' })).toBeNull();
});

it('restores an initial image zoom and releases its themed portal and blob on actual unmount', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:restored-image'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const client = new QueryClient();
  const rendered = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialView={{ zoom: 1.5 }} /></QueryClientProvider>);
  await waitFor(() => expect(rendered.container.querySelector('[data-document-zoom-frame]')).not.toBeNull());
  const zoom = rendered.container.querySelector('[data-document-zoom-frame]') as HTMLElement;
  expect(zoom).toHaveAttribute('data-document-zoom-mode', 'fixed');
  expect(zoom.style.getPropertyValue('--document-zoom')).toBe('1.5');
  rendered.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:restored-image');
  expect(document.querySelector('.dsh-file-preview-portals')).toBeNull();
});

it('reports only the loaded immutable source, clears it before reload/version changes and on hide/unmount', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  const wrap = (props: Parameters<typeof ProjectFileContent>[0]) => <QueryClientProvider client={client}><ProjectFileContent {...props} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(input));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByText('version2');
  const fixed = { object, revision: 'hash2', fileVersion: 2, recordVersion: null, blockId: null, locator: null, title: 'sample.txt', excerpt: '' };
  expect(ready).toHaveBeenLastCalledWith(fixed);
  // External changes do not mutate the source already loaded in this view.
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null });
  expect(ready).toHaveBeenLastCalledWith(fixed);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByRole('alert');
  expect(ready).toHaveBeenLastCalledWith(null);
  rendered.rerender(wrap({ ...input, versionNumber: 1 }));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByText('version1');
  expect(ready).toHaveBeenLastCalledWith({ ...fixed, revision: 'hash1', fileVersion: 1 });
  rendered.rerender(wrap({ ...input, versionNumber: 1, visible: false }));
  expect(ready).toHaveBeenLastCalledWith(null);
  rendered.unmount();
  expect(ready).toHaveBeenLastCalledWith(null);
});
it('provides a verified source for unsupported bytes and never publishes a late old source', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const wrap = (props: Parameters<typeof ProjectFileContent>[0]) => <QueryClientProvider client={client}><ProjectFileContent {...props} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(input));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 1, contentHash: 'hash1', name: 'sample.doc', mime: 'application/octet-stream', byteLength: 3, base64: btoa('zip') });
  rendered.rerender(wrap({ ...input, versionNumber: 1 }));
  await screen.findByText(/此格式暂不支持/);
  expect(ready).toHaveBeenLastCalledWith({ object, revision: 'hash1', fileVersion: 1, recordVersion: null, blockId: null, locator: null, title: 'sample.doc', excerpt: '' });
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'old.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') }));
  expect(ready.mock.calls.filter(([value]) => value?.fileVersion === 2)).toHaveLength(0);
});

it('accepts the actual version view arriving after sourceReady without restoring again on saved scroll updates', async () => {
  const ready = vi.fn(); const changed = vi.fn(); const client = new QueryClient();
  const wrap = (initialView?: {scrollTop?: number;zoom?: number}) => <QueryClientProvider client={client}><ProjectFileContent {...input} initialView={initialView} onSourceReady={ready} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap());
  await screen.findByText('version2');
  expect(ready).toHaveBeenLastCalledWith(expect.objectContaining({ fileVersion: 2, revision: 'hash2' }));
  rendered.rerender(wrap({ scrollTop: 155, zoom: 0 }));
  const scroll = rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  expect(scroll.scrollTop).toBe(155);
  scroll.scrollTop = 172; fireEvent.scroll(scroll);
  rendered.rerender(wrap({ scrollTop: 172, zoom: 0 }));
  scroll.scrollTop = 183;
  rendered.rerender(wrap({ scrollTop: 172, zoom: 0 }));
  expect(scroll.scrollTop).toBe(183);
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(ready.mock.calls.filter(([value]) => value)).toHaveLength(1);
});

it('restores each actual version from the shell sourceReady render and after hidden unmount', async () => {
  const client = new QueryClient();
  function Shell({ selected, visible = true }: {selected?: number;visible?: boolean}) {
    const [loadedSource, setLoadedSource] = useState<AgentSourceRef | null>(null);
    const fileViews: Record<number, {scrollTop: number}> = { 1: {scrollTop: 44}, 2: {scrollTop: 155} };
    return <QueryClientProvider client={client}>{visible ? <ProjectFileContent {...input} versionNumber={selected} initialView={loadedSource ? fileViews[loadedSource.fileVersion!] : undefined} onSourceReady={setLoadedSource} /> : null}</QueryClientProvider>;
  }
  const rendered = render(<Shell />);
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(155);
  rendered.rerender(<Shell selected={1} />);
  await screen.findByText('version1');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(44);
  rendered.rerender(<Shell selected={1} visible={false} />);
  rendered.rerender(<Shell selected={2} />);
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(155);
});
it('keeps sourceReady null when the returned bytes do not match the requested version hash', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'wrong', name: 'sample.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') });
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} onSourceReady={ready} /></QueryClientProvider>);
  await screen.findByRole('alert');
  expect(ready.mock.calls.every(([value]) => value === null)).toBe(true);
});

function staticHtmlFixture() {
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_, request) => {
    const text = `<h1>HTML version ${request.versionNumber}</h1>`;
    return { object: request.object, versionNumber: request.versionNumber, contentHash: request.expectedContentHash, name: 'sample.html', mime: 'text/html', base64: btoa(text), byteLength: text.length };
  });
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => source(request.versionNumber, `<h1>HTML version ${request.versionNumber}</h1>`, 'sample.html', 'html'));
}
it('keeps the opaque HTML iframe and its browsing context while hidden and after same-version revalidation without writing srcDoc', async () => {
  staticHtmlFixture();
  const ready = vi.fn(); const client = new QueryClient();
  const wrap = (visible: boolean) => <QueryClientProvider client={client}><ProjectFileContent {...input} visible={visible} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(true));
  const frame = await screen.findByTitle('HTML 文档预览') as HTMLIFrameElement;
  const context = frame.contentWindow; const documentSource = frame.srcdoc;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records)); observer.observe(frame, { attributes: true, attributeFilter: ['srcdoc'] });
  rendered.rerender(wrap(false));
  expect(ready).toHaveBeenLastCalledWith(null);
  expect(rendered.container.querySelector('iframe')).toBe(frame);
  expect(frame.contentWindow).toBe(context);
  expect(frame).toHaveAttribute('sandbox', '');
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  rendered.rerender(wrap(true));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  expect(ready).toHaveBeenLastCalledWith(null);
  expect(rendered.container.querySelector('iframe')).toBe(frame);
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.html', mime: 'text/html', base64: btoa('<h1>HTML version 2</h1>'), byteLength: 23 }));
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(expect.objectContaining({ fileVersion: 2, revision: 'hash2' })));
  expect(rendered.container.querySelector('iframe')).toBe(frame);
  expect(frame.contentWindow).toBe(context); expect(frame.srcdoc).toBe(documentSource);
  expect(mutations).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', {name:'刷新'}));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(expect.objectContaining({ fileVersion: 2 })));
  expect(rendered.container.querySelector('iframe')).toBe(frame);
  expect(mutations).toHaveLength(0);
  rendered.unmount(); observer.disconnect();
  expect(frame.isConnected).toBe(false); expect(ready).toHaveBeenLastCalledWith(null);
});
it('retires hidden HTML immediately when revalidation discovers a different latest version, before its bytes arrive', async () => {
  staticHtmlFixture(); const rendered = view();
  const oldFrame = await screen.findByTitle('HTML 文档预览');
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.html', name: 'sample.html', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: 'hash3', versions: [version(3), version(2), version(1)], nextCursor: null });
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  rendered.rerender(rendered.wrap(input));
  await waitFor(() => expect(oldFrame.isConnected).toBe(false));
  expect(rendered.container.querySelector('iframe')).toBeNull();
  await act(async () => finish({ object, versionNumber: 3, contentHash: 'hash3', name: 'sample.html', mime: 'text/html', base64: btoa('<h1>HTML version 3</h1>'), byteLength: 23 }));
  const newFrame = await screen.findByTitle('HTML 文档预览');
  expect(newFrame).not.toBe(oldFrame); expect(newFrame.getAttribute('srcdoc')).toContain('HTML version 3');
});
it('removes retained HTML after a read failure and never publishes the old source as ready', async () => {
  staticHtmlFixture(); const ready = vi.fn(); const client = new QueryClient();
  const wrap = (visible: boolean) => <QueryClientProvider client={client}><ProjectFileContent {...input} visible={visible} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(true)); const oldFrame = await screen.findByTitle('HTML 文档预览');
  rendered.rerender(wrap(false)); ready.mockClear();
  vi.mocked(projectFileApi.readBytes).mockRejectedValueOnce({message:'snapshot unavailable'});
  rendered.rerender(wrap(true));
  expect(await screen.findByRole('alert')).toHaveTextContent('snapshot unavailable');
  expect(oldFrame.isConnected).toBe(false); expect(rendered.container.querySelector('iframe')).toBeNull();
  expect(ready.mock.calls.every(([value]) => value === null)).toBe(true);
});
it('replaces the frame when same-root-version related HTML bytes change', async () => {
  relatedFixture('<link rel="stylesheet" href="style.css"><h1>Preview</h1>', 'sample.html', 'text/html', 'html');
  const rendered = view(); const oldFrame = await screen.findByTitle('HTML 文档预览');
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  const read = vi.mocked(projectFileApi.readBytes).getMockImplementation()!;
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (binding, request) => {
    const result = await read(binding, request);
    return request.object.id === '9' ? { ...result, base64: btoa('h1{color:blue}'), byteLength: 14 } : result;
  });
  rendered.rerender(rendered.wrap(input));
  await waitFor(() => expect(rendered.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('h1{color:blue}'));
  expect(rendered.container.querySelector('iframe')).not.toBe(oldFrame); expect(oldFrame.isConnected).toBe(false);
});
it('retires retained HTML on a fixed-version change while hidden and ignores a late result from the old read', async () => {
  staticHtmlFixture(); const rendered = view(); const oldFrame = await screen.findByTitle('HTML 文档预览');
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', {name:'刷新'}));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  rendered.rerender(rendered.wrap({ ...input, visible: false, versionNumber: 1 } as typeof input));
  expect(oldFrame.isConnected).toBe(false);
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.html', mime: 'text/html', base64: btoa('<h1>old</h1>'), byteLength: 12 }));
  expect(rendered.container.querySelector('iframe')).toBeNull();
  rendered.rerender(rendered.wrap({ ...input, versionNumber: 1 } as typeof input));
  expect((await screen.findByTitle('HTML 文档预览')).getAttribute('srcdoc')).toContain('HTML version 1');
});
it('binds HTML source mode to the shell, preserves it through reload/hide and releases source-mode bodies', async () => {
  staticHtmlFixture(); const changed = vi.fn(); const client = new QueryClient();
  const wrap = (visible: boolean, mode = true) => <QueryClientProvider client={client}><ProjectFileContent {...input} visible={visible} initialSourceMode={mode} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap(true)); await screen.findByText('<h1>HTML version 2</h1>');
  expect(rendered.container.querySelector('iframe')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'静态预览'}));
  expect(changed).toHaveBeenLastCalledWith({sourceMode:false});
  await screen.findByTitle('HTML 文档预览');
  rendered.rerender(wrap(true, false));
  fireEvent.click(screen.getByRole('button', {name:'源码 / 行定位'}));
  expect(changed).toHaveBeenLastCalledWith({sourceMode:true});
  rendered.rerender(wrap(true, true));
  fireEvent.click(screen.getByRole('button', {name:'刷新'}));
  await screen.findByText('<h1>HTML version 2</h1>');
  rendered.rerender(wrap(false)); expect(rendered.container.querySelector('.dsh-file-preview')).toBeNull();
  rendered.rerender(wrap(true)); await screen.findByText('<h1>HTML version 2</h1>');
  expect(rendered.container.querySelector('iframe')).toBeNull();
  rendered.unmount();
  const reopened = render(wrap(true)); await screen.findByText('<h1>HTML version 2</h1>');
  expect(reopened.container.querySelector('iframe')).toBeNull();
});
it('retains separate static HTML contexts in visited Projects while sources remain visible-Project scoped', async () => {
  staticHtmlFixture(); const client = new QueryClient(); const readyA = vi.fn(); const readyB = vi.fn();
  vi.mocked(projectFileApi.resolve).mockImplementation(async (_, target) => ({ object: target, relativePath: 'sample.html', name: 'sample.html', versionNumber: 2, contentHash: 'hash2', state: 'ready', reason: null }));
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async (_, request) => ({ object: request.object, currentVersionNumber: 2, currentContentHash: 'hash2', versions: [version(2), version(1)], nextCursor: null }));
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => ({ ...source(request.versionNumber, `<h1>HTML version ${request.versionNumber}</h1>`, 'sample.html', 'html'), object: request.object }));
  const wrap = (active: number) => <QueryClientProvider client={client}>
    <ProjectFileContent {...input} visible={active === 2} onSourceReady={readyA} />
    <ProjectFileContent {...input} projectId={3} visible={active === 3} onSourceReady={readyB} />
  </QueryClientProvider>;
  const rendered = render(wrap(2)); const a = await screen.findByTitle('HTML 文档预览') as HTMLIFrameElement;
  const contextA = a.contentWindow;
  rendered.rerender(wrap(3));
  await waitFor(() => expect(rendered.container.querySelectorAll('iframe')).toHaveLength(2));
  const b = rendered.container.querySelectorAll('iframe')[1]; const contextB = b.contentWindow;
  expect(a.contentWindow).toBe(contextA); expect(readyA).toHaveBeenLastCalledWith(null);
  expect(readyB).toHaveBeenLastCalledWith(expect.objectContaining({ object: expect.objectContaining({scope:{kind:'project',projectId:3}}) }));
  rendered.rerender(wrap(2));
  await waitFor(() => expect(readyA).toHaveBeenLastCalledWith(expect.objectContaining({ object })));
  expect(rendered.container.querySelectorAll('iframe')[0]).toBe(a);
  expect(rendered.container.querySelectorAll('iframe')[1]).toBe(b); expect(b.contentWindow).toBe(contextB);
  expect(readyB).toHaveBeenLastCalledWith(null);
});
it('releases image bodies and Blob resources when hidden instead of retaining non-HTML content', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:hidden-image'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const rendered = view(); await waitFor(() => expect(rendered.container.querySelector('[data-document-zoom-frame]')).not.toBeNull());
  rendered.rerender(rendered.wrap({...input,visible:false}));
  expect(rendered.container.querySelector('[data-document-zoom-frame]')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:hidden-image');
  expect(document.querySelector('.dsh-file-preview-portals')).toBeNull();
});
it('restores Markdown source mode from the shell without rereading bytes when the mode changes', async () => {
  relatedFixture('# Markdown', 'sample.md', 'text/markdown', 'markdown'); const client = new QueryClient(); const changed = vi.fn();
  const wrap = (mode: boolean) => <QueryClientProvider client={client}><ProjectFileContent {...input} initialSourceMode={mode} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap(true));
  const sourceEditor = await screen.findByRole('textbox', {name:'Markdown 源码'});
  expect(sourceEditor).toHaveTextContent('# Markdown');
  expect(sourceEditor).toHaveAttribute('contenteditable', 'true');
  rendered.rerender(wrap(false)); await screen.findByRole('heading', {name:'Markdown'});
  fireEvent.click(screen.getByRole('button', {name:'源码 / 行定位'}));
  expect(changed).toHaveBeenLastCalledWith({sourceMode:true});
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
});

it('exposes external open on unsupported and pinned File views as the current original', async () => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 1, contentHash: 'hash1', name: 'sample.doc', mime: 'application/octet-stream', byteLength: 2, base64: btoa('PK') });
  view({ ...input, versionNumber: 1 } as typeof input);
  const open = await screen.findByRole('button', { name: '在外部应用打开当前原件' });
  await screen.findByText(/此格式暂不支持应用内预览或编辑/);
  expect(open).toHaveAttribute('title', expect.stringContaining('当前原件'));
  fireEvent.click(open);
  await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding, object));
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1');
});
it('shows external open failures and permits retry without changing the fixed version', async () => {
  vi.mocked(projectFileApi.openLocal).mockRejectedValueOnce(new Error('没有关联应用')).mockResolvedValueOnce(undefined);
  view({ ...input, versionNumber: 1 } as typeof input); await screen.findByText('version1');
  fireEvent.click(screen.getByRole('button', {name:'在外部应用打开当前原件'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('没有关联应用');
  fireEvent.click(screen.getByRole('button', {name:'在外部应用打开当前原件'}));
  await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1');
});
it('shows the recovery slot only after current File identity needs attention', async () => {
  const client = new QueryClient();
  const wrap = () => <QueryClientProvider client={client}><ProjectFileContent {...input} identityRecovery={<button>文件位置核对入口</button>} /></QueryClientProvider>;
  const rendered = render(wrap()); await screen.findByText('version2');
  expect(screen.queryByText('文件位置核对入口')).toBeNull();
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath:'sample.txt', name:'sample.txt', versionNumber:2, contentHash:'hash2', state:'missing', reason:'文件缺失' });
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  expect(await screen.findByText('文件位置核对入口')).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('文件缺失');
  await chooseVersion(1);
  await screen.findByText('version1');
  expect(screen.getByText('文件位置核对入口')).toBeInTheDocument();
  rendered.unmount();
});

it.each([{projectId:3},{fileId:8},{visible:false}])('cancels an external-open lookup when the File page changes %j', async change => {
  const rendered=view(); await screen.findByText('version2');
  let finish!: (value:typeof binding)=>void;
  vi.mocked(recordDocumentApi.bindingGet).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole('button',{name:'在外部应用打开当前原件'}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  rendered.rerender(rendered.wrap({...input,...change}));
  await act(async()=>finish(binding));
  expect(projectFileApi.openLocal).not.toHaveBeenCalled();
});
it('preserves the compact toolbar and fixed version label through refresh without resetting to latest',async()=>{
  const client=new QueryClient();
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} versionNumber={1} toolbarActions={<button>测试引用入口</button>} /></QueryClientProvider>);
  await screen.findByText('version1');
  const select=screen.getByRole('button',{name:'文件查看版本'});
  expect(select).toHaveTextContent('v1');
  expect(screen.getByRole('button',{name:'测试引用入口'}).closest('header')).toBe(select.closest('header'));
  expect(screen.queryByRole('button',{name:'复制完整源码'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  await waitFor(()=>expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  expect(select).toHaveTextContent('v1'); expect(projectFileApi.resolve).not.toHaveBeenCalled();
});
