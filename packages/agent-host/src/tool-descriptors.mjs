// This is a second, small allowlist; Rust still owns grants and argument checks.
export const READ_METHODS = new Set(['project.list', 'context.get', 'context.overview.get', 'knowledge.search', 'knowledge.get', 'source.search', 'source.read', 'todo.get', 'file.source.read', 'file.versions.list', 'file.versions.get', 'session.search', 'session.messages.read']);
// Registration is supplied by the trusted Host after its mode/grant checks.
// Business mutations still execute in Rust and require durable undo receipts.
const RECORD_METHODS = new Set(['record.blocks.get', 'output.stage', 'output.get', 'output.list', 'output.commit', 'review.decide', 'operation.get', 'operation.list', 'operation.undo', 'operation.restore_created', 'file.content.begin', 'file.content.chunk', 'file.content.complete', 'file.content.status']);
export const PROBE_TOOLS = ['source.read', 'output.stage'].map((method) => ({
  name: `mind_${method.replace('.', '_')}`, method,
  description: `Acceptance fixture for scoped ${method}.`,
  parameters: { type: 'object', properties: { payload: { type: 'string', maxLength: 65536 } }, required: ['payload'], additionalProperties: false },
}));
export const DEFAULT_SYSTEM_PROMPT = 'You are ProjectMind. Use only the supplied scoped tools. Paths are Workspace-relative references.';

export function validateToolDescriptors(tools, { probe = false } = {}) {
  const invalid = () => { throw Object.assign(new Error('Invalid scoped tool descriptors'), { code: 'INVALID_ARGUMENT' }); };
  if (!Array.isArray(tools) || tools.length > 32 || Buffer.byteLength(JSON.stringify(tools)) > 65536) invalid();
  const names = new Set();
  for (const tool of tools) {
    if (!tool || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name ?? '') || names.has(tool.name)
      || !(READ_METHODS.has(tool.method) || (!probe && RECORD_METHODS.has(tool.method)) || (probe && tool.method === 'output.stage'))
      || typeof tool.description !== 'string' || !tool.description || tool.description.length > 2048) invalid();
    names.add(tool.name);
    if (tool.parameters?.type !== 'object' || tool.parameters.additionalProperties !== false
      || !tool.parameters.properties || Array.isArray(tool.parameters.properties)) invalid();
    let nodes = 0;
    const definitions = tool.parameters.$defs ?? {};
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)
      || Object.keys(definitions).some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))) invalid();
    function schema(value, depth = 0) {
      // Canonical Record containers share local recursive definitions.
      // Inspect definitions once instead of expanding every reference.
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
      if (depth > 8 || ++nodes > 512) {
        throw Object.assign(new Error(`Scoped tool schema exceeds its budget (${nodes} nodes, depth ${depth})`), { code: 'INVALID_ARGUMENT' });
      }
      if (value.$ref !== undefined) {
        const match = typeof value.$ref === 'string' && /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(value.$ref);
        if (!match || !Object.hasOwn(definitions, match[1]) || Object.keys(value).length !== 1) invalid();
        return;
      }
      for (const key of ['oneOf', 'anyOf']) if (value[key] !== undefined) {
        if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 32) invalid();
        for (const variant of value[key]) schema(variant, depth + 1);
        if (value.type === undefined) return;
      }
      if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) invalid();
      if (value.type === 'object') {
        if (value.additionalProperties !== false || !value.properties || Array.isArray(value.properties)) invalid();
        for (const item of Object.values(value.properties)) schema(item, depth + 1);
        if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((name) => !Object.hasOwn(value.properties, name)))) invalid();
      }
      // File creation accepts up to 2 MiB of UTF-8 bytes; upload chunks carry
      // at most 1 MiB as base64. Rust separately enforces actual byte budgets.
      if (value.type === 'string' && (!Number.isInteger(value.maxLength) || value.maxLength < 1 || value.maxLength > 2 * 1024 * 1024)) invalid();
      if (value.type === 'array') {
        if (!Number.isInteger(value.maxItems) || value.maxItems < 0 || value.maxItems > 256) invalid();
        schema(value.items, depth + 1);
      }
    }
    schema(tool.parameters);
    for (const definition of Object.values(definitions)) schema(definition);
  }
  return structuredClone(tools);
}
