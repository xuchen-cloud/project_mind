import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMessageNodeView } from '../upstream/client/ui-chat/src/client/chat/MessageItem';
import { projectUserText } from '../upstream/client/ui-primitives/src/user-text';
import { adaptFileReferences, fileReferenceToken, fixedFileFromPath, adaptFileMessageRenderer } from './file-references.mjs';

it.each(['null', '[]', '{"selectionId":"pasted"}'])('preserves invalid pasted Office selection JSON: %s', json => {
  const text = `<mind-office-selection>${json}</mind-office-selection>`;
  const View = adaptFileMessageRenderer(UserMessageNodeView);
  const view = render(createElement(View, {node: {kind: 'user', data: {content: [{type: 'text', text}], time: 1}},
    t: (key: string) => key, renderMessageImages: () => null, openSkill: vi.fn(), openFile: vi.fn()}));
  expect(view.container.textContent).toContain(text);
});

it('a live Office selection serializes its Session-bound snapshot without resolving the file path',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({result:{ok:true,value:{projection:'<mind-office-selection>snapshot</mind-office-selection>'}}})));
  const adapted=adaptFileReferences({codec:{serialize:async ref=>ref}},fetch,vi.fn());
  const token=fileReferenceToken('session','work.docx',undefined,{selectionId:'selection',format:'docx'});
  expect(await adapted.codec.serialize(token,new AbortController().signal)).toBe('<mind-office-selection>snapshot</mind-office-selection>');
  expect(fetch.mock.calls[0][0]).toBe('/api/mind/office-selection/prepare');
  expect(JSON.parse(fetch.mock.calls[0][1].body).payload.args.request).toEqual({sessionId:'session',selectionId:'selection'});
});

it('sent selection metadata is compact without changing the model message',()=>{
  const text='润色这段 '+`<mind-office-selection>${JSON.stringify({selectionId:'selection',format:'docx',label:'work.docx',text:'PRIVATE SELECTED TEXT',saved:false})}</mind-office-selection>`;
  const node=Object.freeze({kind:'user',data:Object.freeze({content:Object.freeze([{type:'text',text}]),time:1})});
  const View=adaptFileMessageRenderer(UserMessageNodeView);
  const view=render(createElement(View,{node,t:(key:string)=>key,renderMessageImages:()=>null,openSkill:vi.fn(),openFile:vi.fn()}));
  expect(view.container.textContent).toContain('work.docx · 选区');
  expect(view.container.textContent).not.toContain('PRIVATE SELECTED TEXT');
  expect(node.data.content[0].text).toBe(text);
});

it('ordinary candidate and explicit fixed chip serialize through the same Session source service', async () => {
  const source = { object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: 'sha256:old', fileVersion: 1 };
  const fetch = vi.fn(async (_path, init) => new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value: JSON.parse(init.body).method === 'mind/source/resolve' ? { sourceRef: source } : { projection: '<fixed>old bytes</fixed>' } } })));
  const original = {
    candidates: async () => [{ value: JSON.stringify({ kind: 'file', fileKind: 'file', mention: '@file.md' }) }],
    onPick: ({ candidate }) => ({ insert: { source: 'reference', ref: JSON.parse(candidate.value).mention } }),
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
  };
  const adapted = adaptFileReferences(original, fetch, vi.fn());
  const rows = await adapted.candidates({ sessionId: 'session-a' }, {});
  const normal = adapted.onPick({ candidate: rows[0] }).insert.ref;
  expect(await adapted.codec.serialize(normal, new AbortController().signal)).toBe('<fixed>old bytes</fixed>');
  const fixed = fileReferenceToken('session-b', 'renamed.md', source);
  expect(await adapted.codec.serialize(fixed, new AbortController().signal)).toBe('<fixed>old bytes</fixed>');
  const requests = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).payload.args.request);
  expect(requests).toEqual([{ sessionId: 'session-a', path: 'file.md' }, { sessionId: 'session-a', path: 'file.md', sourceRef: source }, { sessionId: 'session-b', path: 'renamed.md', sourceRef: source }]);
});

it('a persisted ordinary message File token opens the exact SourceRef instead of the current path', () => {
  const sourceRef = { object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: 'sha256:old', fileVersion: 1, title: 'old.md' };
  const tokenPath = `mind-source/${btoa(JSON.stringify(sourceRef)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/old.md`;
  const open = vi.fn();
  render(createElement('div', null, projectUserText(`@${tokenPath}\nfixed content`, [], [], 'skill', { openFile: path => open(fixedFileFromPath(path)) })));
  fireEvent.click(screen.getByRole('button', { name: /old.md/ }));
  expect(open).toHaveBeenCalledWith({ path: 'old.md', sourceRef });
});

it('a fixed read failure rejects send instead of converting back to a live path', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { ok: false, error: { message: 'snapshot missing' } } })));
  const adapted = adaptFileReferences({ codec: { serialize: async ref => ref } }, fetch, vi.fn());
  await expect(adapted.codec.serialize(fileReferenceToken('session', 'file.md', { fileVersion: 1 }), new AbortController().signal)).rejects.toThrow('snapshot missing');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('never guesses the identity of a restored path-only selected chip', async () => {
  const fetch = vi.fn();
  const adapted = adaptFileReferences({ codec: { serialize: async ref => ref } }, fetch, vi.fn());
  await expect(adapted.codec.serialize(fileReferenceToken('session', 'reused.md'), new AbortController().signal)).rejects.toThrow('重新选择');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['user', 'steering'])('sent fixed File projections display friendly versions in the real %s bubble and open the exact source', kind => {
  const source = (version: number) => ({ object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '9' }, revision: `sha256:v${version}`, fileVersion: version, title: 'sample.txt', locator: { kind: 'line', start: 1, end: 1 } });
  const projection = (sourceRef: ReturnType<typeof source>) => {
    const path = `mind-source/${btoa(JSON.stringify(sourceRef)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/sample.txt`;
    return `@${path}\n<mind-file-source>${JSON.stringify({ id: 'native-prepared', sourceRef, offset: 1, limit: 120, requestedLimit: 120, truncated: false, content: Array.from({ length: 120 }, (_, i) => `${i + 1}: actual model bytes`).join('\n') })}</mind-file-source>`;
  };
  const text = `Compare these versions: acceptance${projection(source(1))}\n${projection(source(2))}\nKeep this ordinary @other.txt mention.`;
  const content = Object.freeze([Object.freeze({ type: 'text', text })]);
  const node = Object.freeze({ kind, data: Object.freeze({ content, time: 1 }) });
  const open = vi.fn();
  const View = adaptFileMessageRenderer(UserMessageNodeView);
  const view = render(createElement(View, { node, t: (key: string) => key, renderMessageImages: () => null, openSkill: vi.fn(), openFile: (path: string) => open(fixedFileFromPath(path) ?? { path }) }));
  expect(view.container.textContent).toContain('Compare these versions:');
  expect(view.container.textContent).toContain('acceptance');
  expect(view.container.textContent).toContain('Keep this ordinary');
  expect(view.container.innerHTML).not.toMatch(/mind-source|mind-file-source|actual model bytes|sha256|native-prepared/);
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1' }));
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v2' }));
  expect(open.mock.calls.slice(0, 2)).toEqual([[{ path: 'sample.txt', sourceRef: source(1) }], [{ path: 'sample.txt', sourceRef: source(2) }]]);
  fireEvent.click(screen.getByRole('button', { name: 'other.txt' }));
  expect(open).toHaveBeenLastCalledWith({ path: 'other.txt' });
  expect(node.data.content[0].text).toBe(text);
});

it('same filename and version from different stable Files retain distinct fixed navigation', () => {
  const refs = ['old-file', 'new-file'].map(id => ({ object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id }, revision: `sha256:${id}`, fileVersion: 1, title: 'sample.txt' }));
  const text = `Ordinary @"sample.txt · v1" and @"sample.txt · v1 (2)"\n` + refs.map(sourceRef => `@mind-source/${btoa(JSON.stringify(sourceRef)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/sample.txt\n<mind-file-source>${JSON.stringify({ sourceRef, content: 'private bytes' })}</mind-file-source>`).join('\n');
  const open = vi.fn();
  const View = adaptFileMessageRenderer(UserMessageNodeView);
  const view = render(createElement(View, { node: { kind: 'user', data: { content: [{ type: 'text', text }], time: 1 } }, t: (key: string) => key, renderMessageImages: () => null, openSkill: vi.fn(), openFile: (path: string) => open(fixedFileFromPath(path) ?? { path }) }));
  expect(view.container.innerHTML).not.toMatch(/mind-source|mind-file-source|private bytes|sha256/);
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1' }));
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1 (2)' }));
  expect(open.mock.calls).toEqual([[{ path: 'sample.txt · v1' }], [{ path: 'sample.txt · v1 (2)' }]]);
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1 (3)' }));
  fireEvent.click(screen.getByRole('button', { name: 'sample.txt · v1 (4)' }));
  expect(open.mock.calls.slice(2)).toEqual(refs.map(sourceRef => [{ path: 'sample.txt', sourceRef }]));
});

it.each([
  ['bad base64', 'A'],
  ['bad JSON', btoa('{"title":')],
  ['null JSON', btoa('null')],
  ['numeric title', btoa(JSON.stringify({ title: 42, fileVersion: 1 }))],
  ['missing title', btoa(JSON.stringify({ fileVersion: 1 }))],
  ['zero version', btoa(JSON.stringify({ title: 'sample.txt', fileVersion: 0 }))],
  ['negative version', btoa(JSON.stringify({ title: 'sample.txt', fileVersion: -1 }))],
  ['fractional version', btoa(JSON.stringify({ title: 'sample.txt', fileVersion: 1.5 }))],
  ['string version', btoa(JSON.stringify({ title: 'sample.txt', fileVersion: '1' }))],
])('preserves a pasted %s projection literal in the real user renderer', (_case, encoded) => {
  const literal = `@mind-source/${encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/literal.txt\n<mind-file-source>{"content":"literal user text"}</mind-file-source>`;
  const sourceRef = { title: 'valid.txt', fileVersion: 1 };
  const validPath = `mind-source/${btoa(JSON.stringify(sourceRef)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}/valid.txt`;
  const text = `Literal acceptance${literal}\nValid @${validPath}\n<mind-file-source>{"content":"model projection"}</mind-file-source>`;
  const node = Object.freeze({ kind: 'user', data: Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text', text })]), time: 1 }) });
  const open = vi.fn();
  const View = adaptFileMessageRenderer(UserMessageNodeView);
  const view = render(createElement(View, { node, t: (key: string) => key, renderMessageImages: () => null, openSkill: vi.fn(), openFile: (path: string) => open(fixedFileFromPath(path)) }));
  expect(view.container.textContent).toContain(`Literal acceptance${literal}`);
  expect(view.container.textContent).not.toContain('model projection');
  fireEvent.click(screen.getByRole('button', { name: 'valid.txt · v1' }));
  expect(open).toHaveBeenCalledWith({ path: 'valid.txt', sourceRef });
  expect(node.data.content[0].text).toBe(text);
});
