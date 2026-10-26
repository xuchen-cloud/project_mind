import type { AgentObjectRef } from "../../lib/agent-types";
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectFileContent } from './ProjectFileContent';
import { projectFileApi } from '../../services/projectFileApi';
import { fileDocumentApi } from '../../services/fileDocumentApi';
import { recordDocumentApi } from '../../services/recordDocumentApi';
import { fileTextApi } from '../../services/fileTextApi';
import { queryKeys } from '../../lib/queryKeys';
vi.mock('../../services/fileDocumentApi', () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn() } }));
vi.mock('../../services/recordDocumentApi', () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock('../../services/projectFileApi', () => ({ projectFileApi: { resolve: vi.fn(), readBytes: vi.fn(), resolveRelated: vi.fn(), applications: vi.fn(), openWith: vi.fn(), openLocal: vi.fn() }, fileBytes: (result: {
        base64: string;
    }) => Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)) }));
vi.mock('../../services/fileTextApi', () => ({ fileTextApi: { save: vi.fn() } }));
vi.mock('../markdown/MarkdownEditor', async () => {
    const { useState } = await import('react');
    return { MarkdownEditor: (props: {
            value: string;
            readOnly: boolean;
            onChange: (value: string) => void;
            resolveResource?: (reference: string) => Promise<string | undefined>;
            resources?: Record<string, string>;
        }) => {
            const [resource, setResource] = useState('');
            return <div><p>{props.value}</p><button disabled={props.readOnly} onClick={() => props.onChange('保留草稿')}>编辑文档</button><button disabled={!props.resolveResource} onClick={() => void props.resolveResource?.('images/new.png').then(value => setResource(value ?? ''), error => setResource(error.message))}>读取新增图片</button><output aria-label="关联图片结果">{resource}</output><output aria-label="预载图片">{JSON.stringify(props.resources)}</output></div>;
        } };
});
const binding = { workspaceId: 'w', generation: 'g' };
const projectObject = { workspaceId: 'w', scope: { kind: 'project' as const, projectId: 2 }, kind: 'file' as const, id: '7' };
let object: AgentObjectRef = projectObject;
let current: number;
function resolved() { return { object, relativePath: 'sample.md', name: 'sample.md', versionNumber: current, contentHash: `hash${current}`, state: 'ready' as const, reason: null }; }
beforeEach(() => {
    vi.resetAllMocks();
    object = projectObject;
    current = 2;
    vi.mocked(projectFileApi.applications).mockResolvedValue([]);
    vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
    vi.mocked(projectFileApi.resolve).mockImplementation(async () => resolved());
    vi.mocked(fileDocumentApi.versionsList).mockImplementation(async () => ({ object, currentVersionNumber: current, currentContentHash: `hash${current}`, versions: [{ id: String(current), versionNumber: current, name: 'sample.md', createdAt: '2026-10-13', contentHash: `hash${current}`, isCurrent: true }], nextCursor: null }));
    vi.mocked(projectFileApi.readBytes).mockImplementation(async (_, input) => ({ object, versionNumber: input.versionNumber, contentHash: `hash${input.versionNumber}`, name: 'sample.md', mime: 'text/markdown', byteLength: 1, base64: 'Iw==' }));
    vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, input) => { const text = input.versionNumber === 2 ? '原文' : '保留草稿'; return { object, versionNumber: input.versionNumber, contentHash: `hash${input.versionNumber}`, title: 'sample.md', byteLength: new TextEncoder().encode(text).byteLength, format: 'markdown', text, startChar: 0, endChar: [...text].length, totalChars: [...text].length, nextCursor: null, complete: true }; });
    vi.mocked(fileTextApi.save).mockImplementation(async () => { current = 3; return { receipt: { documentId: 7, versionNumber: 3, contentHash: 'hash3', noChange: false }, versionPath: null }; });
});
async function mount(projectId: number | null = 2) {
    const client = new QueryClient();
    let close: () => Promise<void> = async () => { };
    const wrap = (visible = true) => <QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={projectId} fileId={7} visible={visible} focused registerCloseGuard={guard => { close = guard; return () => { }; }}/></QueryClientProvider>;
    const view = render(wrap());
    return { ...view, client, wrap, close: () => close() };
}
it('keeps an unsaved Markdown draft and its baseline when an external version arrives', async () => {
    const view = await mount();
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    current = 3;
    // The native change notification invalidates this cache entry after resolve.
    view.client.setQueryData(queryKeys.documentVersions(7), []);
    await act(async () => { await view.client.invalidateQueries({ queryKey: queryKeys.documentVersions(7) }); });
    expect(screen.getByText('保留草稿')).toBeVisible();
    vi.mocked(fileTextApi.save).mockRejectedValue(new Error('文件已在外部修改，请处理保存冲突'));
    fireEvent.click(screen.getByRole('button', { name: '刷新', exact: true }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('文件已在外部修改'))).toBe(true));
    expect(fileTextApi.save).toHaveBeenCalledWith(binding, expect.objectContaining({ object, versionNumber: 2, expectedContentHash: 'hash2', text: '保留草稿' }), expect.any(String));
    expect(screen.getByText('保留草稿')).toBeVisible();
    expect(screen.getByRole('button', { name: '文件查看版本' })).toHaveTextContent('v2');
    view.unmount();
});
it('closing a hidden edited Markdown tab commits its fixed baseline; reopening reads the new File version', async () => {
    const view = await mount();
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    view.rerender(view.wrap(false));
    expect(screen.getByText('保留草稿')).toBeInTheDocument();
    await act(() => view.close());
    expect(fileTextApi.save).toHaveBeenCalledWith(binding, expect.objectContaining({ object, versionNumber: 2, expectedContentHash: 'hash2' }), expect.any(String));
    view.unmount();
    const reopened = await mount();
    await screen.findByText('保留草稿');
    expect(fileDocumentApi.sourceRead).toHaveBeenLastCalledWith(binding, expect.objectContaining({ object, versionNumber: 3, expectedContentHash: 'hash3' }));
    reopened.unmount();
});
it('a draft created during asynchronous tab revalidation survives the incoming clean baseline', async () => {
    const view = await mount();
    await screen.findByText('原文');
    view.rerender(view.wrap(false));
    let finish!: (value: ReturnType<typeof resolved>) => void;
    vi.mocked(projectFileApi.resolve).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.rerender(view.wrap());
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    await act(async () => finish(resolved()));
    await waitFor(() => expect(screen.queryByText('正在读取固定版本…')).not.toBeInTheDocument());
    expect(screen.getByText('保留草稿')).toBeVisible();
    await act(() => view.close());
    expect(fileTextApi.save).toHaveBeenCalledOnce();
    view.unmount();
});
it.each(['default', 'selected'])('flushes Markdown edits before %s external open', async (mode) => {
    vi.mocked(projectFileApi.applications).mockResolvedValue([{ id: 'viewer', name: 'Viewer', icon: null, isDefault: true }]);
    const view = await mount();
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    let finish!: () => void;
    vi.mocked(fileTextApi.save).mockImplementationOnce(() => new Promise(resolve => { finish = () => { current = 3; resolve({ receipt: { documentId: 7, versionNumber: 3, contentHash: 'hash3', noChange: false }, versionPath: null }); }; }));
    if (mode === 'default')
        fireEvent.click(screen.getByRole('button', { name: '在外部应用打开当前原件' }));
    else {
        fireEvent.click(screen.getByRole('button', { name: '选择其他应用打开当前原件' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Viewer（默认）' }));
    }
    await waitFor(() => expect(fileTextApi.save).toHaveBeenCalledOnce());
    expect(projectFileApi.openLocal).not.toHaveBeenCalled();
    expect(projectFileApi.openWith).not.toHaveBeenCalled();
    await act(async () => finish());
    if (mode === 'default')
        await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding, object));
    else
        await waitFor(() => expect(projectFileApi.openWith).toHaveBeenCalledWith(binding, object, 'viewer'));
    view.unmount();
});
it('keeps the latest Markdown draft when saving before a version switch fails', async () => {
    vi.mocked(fileDocumentApi.versionsList).mockResolvedValueOnce({ object, currentVersionNumber: 2, currentContentHash: 'hash2', versions: [{ id: '2', versionNumber: 2, name: 'sample.md', createdAt: '2026-10-13', contentHash: 'hash2', isCurrent: true }, { id: '1', versionNumber: 1, name: 'sample.md', createdAt: '2026-10-12', contentHash: 'hash1', isCurrent: false }], nextCursor: null });
    const view = await mount();
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    vi.mocked(fileTextApi.save).mockRejectedValueOnce(new Error('保存冲突'));
    fireEvent.click(screen.getByRole('button', { name: '文件查看版本' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'v1', exact: true }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent === '保存冲突')).toBe(true));
    expect(screen.getByRole('button', { name: '文件查看版本' })).toHaveTextContent('v2');
    expect(screen.getByText('保留草稿')).toBeVisible();
    view.unmount();
});
it.each(['ready', 'wrong-owner', 'oversize'] as const)('resolves a newly typed Markdown image through the managed File boundary (%s)', async (scenario) => {
    const view = await mount();
    await screen.findByText('原文');
    const assetObject = { ...object, id: '8', scope: { kind: 'project' as const, projectId: scenario === 'wrong-owner' ? 9 : 2 } };
    vi.mocked(projectFileApi.resolveRelated).mockResolvedValue({ ...resolved(), object: assetObject, name: 'new.png', relativePath: 'images/new.png', versionNumber: 1, contentHash: 'asset-hash' });
    vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object: assetObject, versionNumber: 1, contentHash: 'asset-hash', name: 'new.png', mime: 'image/png', byteLength: scenario === 'oversize' ? 4 * 1024 * 1024 + 1 : 1, base64: scenario === 'oversize' ? btoa('\0'.repeat(4 * 1024 * 1024 + 1)) : 'AA==' });
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    // Retained drafts remain editable after the original loading signal is aborted.
    view.rerender(view.wrap(false));
    view.rerender(view.wrap());
    fireEvent.click(screen.getByRole('button', { name: '读取新增图片' }));
    const expected = scenario === 'ready' ? 'data:image/png;base64,AA==' : scenario === 'wrong-owner' ? '关联资源所属项目或版本不符' : '关联资源超过预览字节预算';
    await waitFor(() => expect(screen.getByLabelText('关联图片结果')).toHaveTextContent(expected));
    expect(projectFileApi.resolveRelated).toHaveBeenCalledWith(binding, object, 'images/new.png');
    if (scenario === 'ready') {
        fireEvent.click(screen.getByRole('button', { name: '读取新增图片' }));
        await act(async () => { });
        expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce();
        expect(vi.mocked(projectFileApi.readBytes).mock.calls.filter(([, input]) => input.object.id === '8')).toHaveLength(1);
    }
    view.unmount();
});

it('edits a Workspace Markdown File and commits a new version through the shared fixed baseline', async () => {
    object = { ...projectObject, scope: { kind: 'workspace' } };
    const view = await mount(null);
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    await act(() => view.close());
    expect(fileTextApi.save).toHaveBeenCalledWith(binding, expect.objectContaining({ object, versionNumber: 2, expectedContentHash: 'hash2', text: '保留草稿' }), expect.any(String));
    expect(screen.getByRole('button', { name: '文件查看版本' })).toHaveTextContent('v3');
});

it('keeps a failed Markdown version switch open with its original draft and baseline', async () => {
    vi.mocked(fileDocumentApi.versionsList).mockImplementation(async () => ({object,currentVersionNumber:2,currentContentHash:'hash2',versions:[2,1].map(n=>({id:String(n),versionNumber:n,name:'sample.md',createdAt:'2026-10-13',contentHash:`hash${n}`,isCurrent:n===2})),nextCursor:null}));
    const view = await mount();
    await screen.findByText('原文');
    fireEvent.click(screen.getByRole('button', {name:'编辑文档'}));
    vi.mocked(fileTextApi.save).mockRejectedValue(new Error('Markdown 保存冲突'));
    fireEvent.click(screen.getByRole('button', {name:'文件查看版本'}));
    fireEvent.click(await screen.findByRole('menuitemradio', {name:'v1',exact:true}));
    await waitFor(() => expect(screen.getByRole('menu', {name:'文件查看版本列表'})).toHaveTextContent('Markdown 保存冲突'));
    expect(screen.getByText('保留草稿')).toBeVisible();
    expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v2');
    expect(fileTextApi.save).toHaveBeenCalledWith(binding,expect.objectContaining({object,versionNumber:2,expectedContentHash:'hash2',text:'保留草稿'}),expect.any(String));
    view.unmount();
});
