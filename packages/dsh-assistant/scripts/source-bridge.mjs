import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const SOURCE_PREFIX = 'MIND_DSH_SOURCE ';
export function createSourceBridge(input, write) {
  const pending = new Map();
  let closed = false;
  const close = () => {
    closed = true;
    for (const item of pending.values()) item.reject(new Error('Native source bridge closed'));
    pending.clear();
  };
  input.on('close', close);
  input.on('line', line => {
    if (!line.startsWith('{')) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type !== 'mind-source-response') return;
    const item = pending.get(frame.id);
    if (!item) return;
    pending.delete(frame.id);
    if (frame.result?.ok === true) item.resolve(frame.result.value);
    else item.reject(new Error(frame.result?.error?.message ?? 'Native source read failed'));
  });
  return {
    close,
    request(payload, signal) {
      if (closed) return Promise.reject(new Error('Native source bridge closed'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const abort = () => { pending.delete(id); cleanup(); reject(signal.reason); };
        pending.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
        signal?.addEventListener('abort', abort, { once: true });
        try { write(SOURCE_PREFIX + JSON.stringify({ id, payload }) + '\n'); }
        catch (error) { pending.delete(id); cleanup(); reject(error); }
      });
    },
  };
}

// This marker is model-visible and persisted in the original DSH log. Its
// contents are generated and revalidated by the native File service.
export function sourceProjections(text) {
  return [...text.matchAll(/(?:@mind-source\/[A-Za-z0-9_-]+\/[^\s]+\n)?<mind-file-source>([^\n]*)<\/mind-file-source>/g)].map(match => ({
    projection: match[0], metadata: JSON.parse(match[1]),
  }));
}
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

export async function installSourceService(ctx, project, bridge) {
  const owned = async sessionId => {
    const catalog = await ctx.sessionController.list({});
    if (!catalog.items.some(item => item.sessionId === sessionId && item.cwd === project.directory)) throw new Error('Source Session belongs to another Project');
  };
  for (const operation of ['resolve', 'prepare']) ctx.connection.fetch.register({
    path: `/api/mind/source/${operation}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const envelope = await request.json();
        if (envelope.type !== 'client-request' || envelope.method !== `mind/source/${operation}`) throw new Error('Invalid source request');
        const body = envelope.payload?.args?.request;
        await owned(body.sessionId);
        const payload = operation === 'resolve' ? { operation, sessionId: body.sessionId, path: body.path }
          : { operation, sessionId: body.sessionId, path: body.path, sourceRef: body.sourceRef, offset: 1, limit: 2000 };
        const value = await bridge.request(payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } });
      } catch (error) { return Response.json({ result: { ok: false, error: { message: String(error.message ?? error) } } }); }
    },
  });
  // The wrapper bypasses live-path read while retaining registry pre/post
  // policies. Final model-request scanning below sees policy replacements.
  const preparedReads = new Map();
  const nestedReads = new Map();
  const adaptedTools = new Set();
  const adaptRead = agent => {
    const read = ctx.tools.get('read', agent);
    if (!read || adaptedTools.has(read)) return;
    adaptedTools.add(read);
    const originalOutputSchema = read.output.schema;
    read.output.schema = { ...originalOutputSchema, properties: { ...originalOutputSchema.properties, truncated: { type: 'boolean' } } };
    const originalProjectContent = read.projectContent;
    read.projectContent = (exec, result) => {
      const prepared = preparedReads.get(exec.token);
      return prepared && !result.isError && isDeepStrictEqual(result.value, prepared.readValue) ? [{ type: 'text', text: prepared.projection }] : originalProjectContent?.(exec, result);
    };
    ctx.effect(() => () => { read.projectContent = originalProjectContent; read.output.schema = originalOutputSchema; });
    const runCode = ctx.tools.get('run_code', agent);
    if (!runCode || adaptedTools.has(runCode)) return;
    adaptedTools.add(runCode);
    const originalRunProjection = runCode.projectContent;
    runCode.projectContent = (exec, result) => {
      const sources = nestedReads.get(exec.token) ?? [];
      nestedReads.delete(exec.token);
      const content = originalRunProjection?.(exec, result) ?? result.content;
      return !result.isError && sources.length ? [...content, ...sources.map(text => ({ type: 'text', text: '\n' + text }))] : content;
    };
    ctx.effect(() => () => { runCode.projectContent = originalRunProjection; });
  };
  ctx.on('agent/created', ({ agent }) => adaptRead(agent));
  for (const agent of ctx.agents.list()) adaptRead(agent);
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'read') return next();
    const sessionId = exec.agent?.session.id;
    if (!sessionId) throw new Error('File read requires an actual Session');
    await owned(sessionId);
    // Historical model tokens do not authorize edits to the current path.
    // For a live read, retain the existing filesystem CAS observation only
    // when the target stayed unchanged across the native snapshot read.
    const fsContext = exec.agent.ctx;
    const fs = fsContext.get('fs');
    const historical = /(?:^|\/)mind-source\//.test(exec.arguments.file_path);
    const target = historical ? undefined : await fs.resolve(exec.arguments.file_path,
      { cwd: exec.agent.session.header.cwd, signal: exec.signal });
    const before = target ? await fs.stat(target, exec.signal) : undefined;
    const value = await bridge.request({ operation: 'prepare', sessionId,
      path: exec.arguments.file_path, offset: exec.arguments.offset ?? 1,
      limit: exec.arguments.limit ?? 2000 }, exec.signal);
    const after = target ? await fs.stat(target, exec.signal) : undefined;
    if (before?.type === 'file' && after?.version === before.version)
      fsContext.emit('fs/observed', target, { kind: 'present', version: before.version }, exec);
    preparedReads.set(exec.token, value);
    return { isError: false, value: value.readValue, content: [] };
  });

  // tools/result is emitted synchronously after child post-policy and final
  // content materialization, before PTC returns its value to the program.
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'run_code') nestedReads.delete(exec.token);
    if (exec.name !== 'read') return;
    const prepared = preparedReads.get(exec.token);
    preparedReads.delete(exec.token);
    if (!exec.parent || !prepared || result.isError) return;
    const retained = result.content.some(block => block.type === 'text'
      && sourceProjections(block.text).some(item => item.projection === prepared.projection));
    if (!retained) return;
    const sources = nestedReads.get(exec.parent) ?? [];
    sources.push(prepared.projection);
    nestedReads.set(exec.parent, sources);
  });
  ctx.effect(() => () => { preparedReads.clear(); nestedReads.clear(); });
  const delivered = new Set();
  // The loop request is the authoritative final projection, after tool result
  // policies and history assembly. Evidence failure terminates the stream.
  ctx.on('llm/stream', async function* (options, next) {
    const deliveries = [];
    for (const message of options.messages) {
      for (const block of message.content ?? []) {
        if (block.type !== 'text') continue;
        for (const { projection, metadata } of sourceProjections(block.text)) {
          if (!options.sessionId || !message.id) throw new Error('Source delivery requires actual Session and message identity');
          await owned(options.sessionId);
          const kind = message.role === 'tool' ? 'read' : 'composer';
          const deliveryId = `${kind}:${message.id}:${metadata.id}`;
          const key = JSON.stringify([options.sessionId, deliveryId]);
          if (delivered.has(key)) continue;
          deliveries.push({ key, payload: { operation: 'delivery', sessionId: options.sessionId, deliveryId,
            projection, projectionHash: hash(projection) } });
        }
      }
    }
    let recorded = false;
    for await (const chunk of next()) {
      // A provider chunk proves successful request admission. Failed HTTP/auth
      // requests create no delivery evidence. Persist before publishing chunks.
      if (!recorded) {
        for (const { key, payload } of deliveries) {
          await bridge.request(payload, options.signal);
          delivered.add(key);
        }
        recorded = true;
      }
      yield chunk;
    }
  });
}
