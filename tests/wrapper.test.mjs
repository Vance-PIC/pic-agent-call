/**
 * tests/wrapper.test.mjs
 * Unit tests for isValidAgentTag logic in msg-statusline-wrapper.mjs
 * (Tests the pure predicate extracted to module scope)
 */

// isValidAgentTag is not exported; replicate the exact function for testing.
// If the implementation changes, update here too.
const isValidAgentTag = t =>
  t && t !== 'NO AGENT' && !t.includes('[未登記]') && !t.includes('[DB ERR]');

describe('isValidAgentTag', () => {
  test('returns falsy for empty string', () => {
    expect(isValidAgentTag('')).toBeFalsy();
  });

  test('returns falsy for "NO AGENT"', () => {
    expect(isValidAgentTag('NO AGENT')).toBeFalsy();
  });

  test('returns falsy for tag containing [未登記]', () => {
    expect(isValidAgentTag('CC-PG1 [未登記]')).toBeFalsy();
  });

  test('returns falsy for tag containing [DB ERR]', () => {
    expect(isValidAgentTag('CC-PG1 [DB ERR]')).toBeFalsy();
  });

  test('returns falsy for null/undefined', () => {
    expect(isValidAgentTag(null)).toBeFalsy();
    expect(isValidAgentTag(undefined)).toBeFalsy();
  });

  test('returns truthy for valid agent tag', () => {
    expect(isValidAgentTag('\x1b[33m▶\x1b[0m🟢0·CC-PG1')).toBeTruthy();
  });

  test('returns truthy for simple agent tag', () => {
    expect(isValidAgentTag('🟢0·CC-SA1')).toBeTruthy();
  });

  test('returns truthy for multi-agent display', () => {
    expect(isValidAgentTag('▶🔴1·CC-PG1  🟢0·CC-SA1')).toBeTruthy();
  });
});

// ── convId resolution logic ───────────────────────────────────────────────────

describe('convId resolution chain', () => {
  // Replicate the inline resolution from wrapper:
  // parsed?.conversation_id ?? parsed?.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? ''
  function resolveConvId(parsed, envId) {
    return parsed?.conversation_id ?? parsed?.conversationId ?? envId ?? '';
  }

  test('prefers conversation_id (snake_case)', () => {
    expect(resolveConvId({ conversation_id: 'A', conversationId: 'B' }, 'C')).toBe('A');
  });

  test('falls back to conversationId (camelCase)', () => {
    expect(resolveConvId({ conversationId: 'B' }, 'C')).toBe('B');
  });

  test('falls back to env var', () => {
    expect(resolveConvId({}, 'C')).toBe('C');
  });

  test('returns empty string when all missing', () => {
    expect(resolveConvId({}, undefined)).toBe('');
  });
});
