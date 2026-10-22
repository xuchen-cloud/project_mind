import { createElement } from 'react';

const PREFIX = 'mind-file:';
const SOURCE_PROJECTION = /@(mind-source\/[A-Za-z0-9_-]+\/[^\s]+)\n<mind-file-source>[^\n]*<\/mind-file-source>/g;
export function fileReferenceToken(sessionId, path, sourceRef, selection) {
  return PREFIX + JSON.stringify({ sessionId, path, ...(sourceRef ? { sourceRef } : {}), ...(selection ? { selection } : {}) });
}
async function sourceRequest(fetch, operation, file, signal) {
  const rpcId = crypto.randomUUID();
  const method = operation === 'office-selection' ? 'mind/office-selection/prepare' : `mind/source/${operation}`;
  const response = await fetch(`/api/${method}`, { method: 'POST', signal,
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: file } } }) });
  const envelope = await response.json();
  if (!response.ok || !envelope.result?.ok) throw new Error(envelope.result?.error?.message ?? '固定文件来源读取失败');
  return envelope.result.value;
}
export async function resolveFileReference(fetch, sessionId, path, signal) {
  return (await sourceRequest(fetch, 'resolve', { sessionId, path }, signal)).sourceRef;
}
const decode = ref => ref.startsWith(PREFIX) ? JSON.parse(ref.slice(PREFIX.length)) : undefined;
const mentionPath = mention => mention.startsWith('@"') ? mention.slice(2, -1) : mention.slice(1);
export function fixedFileFromPath(path) {
  const match = /(?:^|\/)mind-source\/([A-Za-z0-9_-]+)\//.exec(path);
  if (!match) return undefined;
  const encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const sourceRef = JSON.parse(new TextDecoder().decode(bytes));
  return { path: sourceRef.title, sourceRef };
}

/** Fold the native source envelope only in the sent user/steering view. */
export function adaptFileMessageRenderer(Component) {
  return function FixedFileMessageView(props) {
    const displayContent = props.node.data.content.map(block => {
      if (block.type !== 'text') return block;
      const text = block.text.replace(/<mind-office-selection>([^\n]*?)<\/mind-office-selection>/g, (projection, json) => {
        let selection;
        try { selection = JSON.parse(json); } catch { return projection; }
        if (!selection || typeof selection.selectionId !== 'string' || typeof selection.label !== 'string' || typeof selection.text !== 'string'
          || !['docx','xlsx','pptx'].includes(selection.format)) return projection;
        return `【${selection.label.replace(/[\r\n]/g,' ')} · 选区】`;
      });
      return text === block.text ? block : {...block,text};
    });
    const targets = new Map();
    const displaySources = new Map();
    // Generated labels contain spaces, so the upstream grammar uses quoted
    // mentions. Reserve ordinary quoted paths before assigning fixed labels.
    const ordinaryPaths = new Set(displayContent.flatMap(block => block.type === 'text'
      ? Array.from(block.text.replace(SOURCE_PROJECTION, (projection, path) => {
        // User text can imitate the envelope. Decode only at this display
        // boundary; malformed literals retain their original text.
        let sourceRef;
        try { sourceRef = fixedFileFromPath(path).sourceRef; }
        catch { return projection; }
        if (typeof sourceRef?.title !== 'string' || !Number.isInteger(sourceRef.fileVersion) || sourceRef.fileVersion <= 0) return projection;
        displaySources.set(path, sourceRef);
        return '';
      }).matchAll(/@"([^"\n]+)"/g), match => match[1]) : []));
    const content = displayContent.map(block => {
      if (block.type !== 'text') return block;
      const text = block.text.replace(SOURCE_PROJECTION, (_projection, path, offset, original) => {
        const sourceRef = displaySources.get(path);
        if (!sourceRef) return _projection;
        const name = sourceRef.title.split(/[\\/]/).at(-1).replaceAll('"', '”');
        const base = `${name} · v${sourceRef.fileVersion}`;
        let label = base;
        let index = 2;
        while (ordinaryPaths.has(label) || (targets.has(label) && targets.get(label) !== path)) label = `${base} (${index++})`;
        targets.set(label, path);
        // A composer chip can serialize directly after ordinary prompt text.
        const separator = offset > 0 && !/\s/.test(original[offset - 1]) ? ' ' : '';
        return `${separator}@"${label}"`;
      });
      return text === block.text ? block : { ...block, text };
    });
    if (targets.size === 0 && content.every((block,index)=>block===props.node.data.content[index])) return createElement(Component, props);
    return createElement(Component, { ...props,
      node: { ...props.node, data: { ...props.node.data, content } },
      openFile: (path, options) => props.openFile(targets.get(path) ?? path, options),
    });
  };
}

export function adaptFileReferences(source, fetch, open) {
  const requestSource = (operation, file, signal) => sourceRequest(fetch, operation, file, signal);
  return { ...source,
    async candidates(session, request) {
      return Promise.all((await source.candidates(session, request)).map(async candidate => {
        const value = JSON.parse(candidate.value);
        if (value.kind !== 'file' || value.fileKind !== 'file') return candidate;
        const resolved = await requestSource('resolve', { sessionId: session.sessionId, path: mentionPath(value.mention) }, request.signal);
        return { ...candidate, value: JSON.stringify({ ...value, mindSessionId: session.sessionId, mindSourceRef: resolved.sourceRef }) };
      }));
    },
    onPick(request) {
      const value = JSON.parse(request.candidate.value);
      const { mindSessionId, mindSourceRef, ...original } = value;
      const result = source.onPick({ ...request, candidate: { ...request.candidate, value: JSON.stringify(original) } });
      if (result?.insert && mindSessionId) return { ...result, insert: { ...result.insert, ref: fileReferenceToken(mindSessionId, mentionPath(value.mention), mindSourceRef) } };
      return result;
    },
    openReference(session, request) {
      const file = decode(request.ref);
      if (!file) return source.openReference?.(session, request);
      // A live selection has no standalone path target. Its editor already
      // remains open beside the chat; never turn its label into a file lookup.
      if (file.selection) return true;
      open({ path: file.path, sourceRef: file.sourceRef, sessionId: session.sessionId });
      return true;
    },
    codec: {
      clipboardText(ref) { const file = decode(ref); return file ? `@${file.path}` : source.codec.clipboardText(ref); },
      async serialize(ref, signal) {
        const file = decode(ref);
        if (!file) {
          if (ref.startsWith('@') && !ref.includes('](dsh-session:') && !ref.endsWith('/')) throw new Error('此旧草稿引用尚未固定文件身份，请移除并重新选择文件');
          return source.codec.serialize(ref, signal);
        }
        if (file.selection) return (await requestSource('office-selection', {sessionId:file.sessionId,selectionId:file.selection.selectionId}, signal)).projection;
        if (!file.sourceRef) throw new Error('此旧草稿引用尚未固定文件身份，请移除并重新选择文件');
        return (await requestSource('prepare', file, signal)).projection;
      },
    },
  };
}
