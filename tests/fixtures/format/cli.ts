// Synthetic `claude -p --output-format stream-json --verbose` lines, rebuilt from the field lists of real runs
// (claude 2.1.321) with made-up ids and paths. The key is the dummy the tests use everywhere; it is not a credential.
export const KEY = 'test-key-not-a-real-key-000000'

export const init = (apiKeySource: string, model = 'claude-opus-5-5') => ({
  type: 'system', subtype: 'init', apiKeySource, model,
  cwd: '/home/u/.claude/orch-ui-format', original_cwd: '/home/u/.claude/orch-ui-format',
  session_id: '00000000-0000-4000-8000-000000000001', uuid: '00000000-0000-4000-8000-000000000002',
  claude_code_version: '2.1.321', permissionMode: 'default', output_style: 'default', view_mode: 'prompt',
  tools: [], mcp_servers: [], slash_commands: [], skills: [], agents: [], plugins: [], additional_directories: [],
  capabilities: [], analytics_disabled: true, product_feedback_disabled: true, fast_mode_state: 'off', fast_mode_disabled_reason: null,
  per_turn_effort_active: false, ultrathink_available: false, ultrathink_typed_raises: false,
})

const usage = (outputTokens: number) => ({ input_tokens: 2400, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 1400 })

// A normal answer: `terminal_reason: completed`, `stop_reason: end_turn`.
export const resultOk = (text: string, over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: text,
  stop_reason: 'end_turn', terminal_reason: 'completed', num_turns: 1,
  duration_ms: 5400, duration_api_ms: 4900, total_cost_usd: 0.0061,
  usage: usage(640), modelUsage: { 'claude-opus-5-5': { inputTokens: 2400, outputTokens: 640, costUSD: 0.0061 } },
  session_id: '00000000-0000-4000-8000-000000000001', uuid: '00000000-0000-4000-8000-000000000003',
  ...over,
})

// The output cap was hit: an error result with output tokens and a cost; the CLI had continued 3 more times.
export const resultCapHit = (over: Record<string, unknown> = {}) => ({
  ...resultOk('API Error: the response exceeded the 40 output token maximum'),
  subtype: 'error_during_execution', is_error: true, stop_reason: 'stop_sequence', terminal_reason: 'api_error', num_turns: 4,
  total_cost_usd: 0.00054, usage: usage(160),
  ...over,
})

// No credential (under `--bare` with no key): the same error fields with no cost and no output.
export const resultNoCredential = (over: Record<string, unknown> = {}) => ({
  ...resultOk('Not logged in · Please run /login'),
  subtype: 'error_during_execution', is_error: true, stop_reason: 'stop_sequence', terminal_reason: 'api_error',
  total_cost_usd: 0, usage: usage(0), modelUsage: {},
  ...over,
})

// An API error with its HTTP status.
export const resultApiError = (status: number, over: Record<string, unknown> = {}) => ({
  ...resultNoCredential(), api_error_status: status, result: `API Error ${status}`, ...over,
})

export const stream = (...items: (object | string)[]) => items.map(i => (typeof i === 'string' ? i : JSON.stringify(i))).join('\n') + '\n'
