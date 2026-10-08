// Profile metadata is supplied by Rust; its unlocked key travels separately over
// the process pipe. supportsText is not evidence of tool calling capability.
export function mapCompatibleProfile(profile, { model, toolCallingVerified = false } = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (profile?.providerFamily !== 'openai_compatible') fail('RUNTIME_INCOMPATIBLE', 'Provider family is not supported by the Pi adapter');
  if (!profile.enabled || !profile.supportsText) fail('PROFILE_UNAVAILABLE', 'Profile is disabled or cannot generate text');
  if (!toolCallingVerified) fail('TOOL_CALL_UNSUPPORTED', 'Tool calling has not been verified for this Profile and model');
  const modelId = model ?? profile.defaultModel;
  if (typeof modelId !== 'string' || !modelId.trim()) fail('PROFILE_UNAVAILABLE', 'Profile has no model');
  let url;
  try { url = new URL(profile.baseUrl); }
  catch { fail('INVALID_ARGUMENT', 'Profile base URL is invalid'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('INVALID_ARGUMENT', 'Profile base URL must be an HTTP endpoint without inline credentials');
  }
  const limits = {};
  for (const key of ['maxTokens', 'contextWindow']) if (profile[key] !== undefined) {
    if (!Number.isInteger(profile[key]) || profile[key] < 1 || profile[key] > 2000000) fail('INVALID_ARGUMENT', 'Invalid Profile model limit');
    limits[key] = profile[key];
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), modelId: modelId.trim(), api: 'openai-completions', ...limits };
}
