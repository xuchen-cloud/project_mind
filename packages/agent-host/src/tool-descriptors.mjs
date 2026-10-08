// This is a second, small allowlist; Rust still owns grants and argument checks.
export const READ_METHODS = new Set(['context.get', 'context.overview.get', 'knowledge.search', 'knowledge.get', 'source.search', 'source.read']);
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
      || !(READ_METHODS.has(tool.method) || (probe && tool.method === 'output.stage'))
      || typeof tool.description !== 'string' || !tool.description || tool.description.length > 2048) invalid();
    names.add(tool.name);
    if (tool.parameters?.type !== 'object' || tool.parameters.additionalProperties !== false
      || !tool.parameters.properties || Array.isArray(tool.parameters.properties)) invalid();
    let nodes = 0;
    function schema(value, depth = 0) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8 || ++nodes > 256) invalid();
      for (const key of ['oneOf', 'anyOf']) if (value[key] !== undefined) {
        if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 16) invalid();
        for (const variant of value[key]) schema(variant, depth + 1);
        if (value.type === undefined) return;
      }
      if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) invalid();
      if (value.type === 'object') {
        if (value.additionalProperties !== false || !value.properties || Array.isArray(value.properties)) invalid();
        for (const item of Object.values(value.properties)) schema(item, depth + 1);
        if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((name) => !Object.hasOwn(value.properties, name)))) invalid();
      }
      if (value.type === 'string' && (!Number.isInteger(value.maxLength) || value.maxLength < 1 || value.maxLength > 65536)) invalid();
      if (value.type === 'array') {
        if (!Number.isInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 100) invalid();
        schema(value.items, depth + 1);
      }
    }
    schema(tool.parameters);
  }
  return structuredClone(tools);
}
