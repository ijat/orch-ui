import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { FORMAT_SYSTEM, KINDS, LIMITS, MARK } from '../hooks/format'
import { FORMAT_TOOL, FORMAT_TOOL_FULL } from '../hooks/format-view'
import * as cli from './fixtures/format/cli'
import * as done from './fixtures/format/done'
import * as long from './fixtures/format/long'
import * as options from './fixtures/format/options'
import * as review from './fixtures/format/review'

type Call = {
  model: string; effort?: string; maxTokens?: number; timeoutMs?: number; system?: string; prompt: string
  argv: string[]; env: Record<string, string>; cwd?: string
}
// What the child prints for one prompt: a rewrite, a failure shape, a refusal of the run, or a run that hits its time limit.
type Reply = string | { reason: 'api-error' | 'empty-reply' | 'aborted' } | { deny: string } | { text: string; tokens: number } | { stdout: string } | { rejectAfter: number }

// A short source with no digits and one id, and a rewrite of it with an `info` banner.
const FILLER = 'The work continues as planned and nothing else has changed since the last report. '
const INFO_SOURCE = FILLER.repeat(5) + 'The file `src/a.ts` is unchanged.'
const INFO_OUTPUT = '# [info] `src/a.ts` is unchanged\n\n## [more] Where it stands\n\n- **File:** `src/a.ts` is unchanged.\n- **Work:** it continues as planned and nothing else has changed since the last report.'

// The compaction tool is there from session start; the formatter's is the one that comes with the marking.
const formatTools = (w: { tools: string[] }) => w.tools.filter(t => t === FORMAT_TOOL)

type World = {
  calls: Call[]; tools: string[]; commands: string[]; opened: Record<string, unknown>[]; store: Map<string, unknown>
  replies: Map<string, Reply>; delays: Map<string, number>
  // the host environment the plugin can read, and the names it asked for
  env: Record<string, string>; envAsked: string[]
  // files by path (text and the `ls -ln` mode), what was stat-ed, read and written, every process.run argv, every ui.log message
  files: Map<string, { text: string; mode: string; acl?: string[] }>; stats: string[]; reads: string[]; written: string[]; runs: string[][]; logs: string[]
  cost: number; lsExit: number; aclExit: number; truncated: boolean
  // the text the engine itself was asked to draw (a row no hook redrew)
  engineRows: string[]
  // the description of each tool registered
  descriptions: string[]
}

const CLAUDE_BIN = 'claude'
const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? ''

// The engine beneath the plugin: just enough for session.start, the child process, the files, the store and the tool registry.
async function boot($: Engine, on: On, seed: Record<string, unknown> = { 'opt:format': true }, envVars: Record<string, string> = { HOME: '/home/u' }) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-10T10:00Z') })
  const w: World = {
    calls: [], tools: [], commands: [], opened: [], store: new Map(Object.entries({ 'opt:format-trigger': 'auto', ...seed })), replies: new Map(), delays: new Map(),
    env: { ...envVars }, envAsked: [], files: new Map(), stats: [], reads: [], written: [], runs: [], logs: [], cost: 0.0061, lsExit: 0, aclExit: 0, truncated: false, engineRows: [], descriptions: [],
  }
  on('ui.render', { component: 'AssistantMessage' }, async (_, e, next) => {
    w.engineRows.push(e.props.text)
    return next(e)
  })
  on('env.get', (_, e) => {
    w.envAsked.push(e.name)
    return { value: w.env[e.name] }
  })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    w.opened.push({ ...e })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', (_, e) => {
    w.logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    w.stats.push(e.path)
    const f = w.files.get(e.path)
    return f ? { value: { kind: 'file' as const, size: f.text.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT: no such file' }
  })
  on('fs.read', (_, e) => {
    w.reads.push(e.path)
    const f = w.files.get(e.path)
    return f ? { value: f.text } : { deny: 'ENOENT: no such file' }
  })
  on('fs.write', (_, e) => {
    w.written.push(e.path)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    w.runs.push([...e.argv])
    const noRun = { value: { exitCode: 1, stdout: '', stderr: 'no orch', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'ls') {
      const f = w.files.get(String(e.argv[e.argv.length - 1]))
      const first = f ? `${f.mode}  1 501  20  ${f.text.length} Nov 10 10:00 ${e.argv[e.argv.length - 1]}\n` : ''
      // `ls -led` (macOS) lists ACL entries on the lines after the file's own
      if (e.argv.includes('-led')) return { value: { exitCode: w.aclExit, stdout: first + (f?.acl ?? []).map((l, i) => ` ${i}: ${l}\n`).join(''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: w.lsExit, stdout: first, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] !== CLAUDE_BIN) return noRun
    const argv = [...e.argv]
    const env = { ...(e.init?.env ?? {}) }
    const prompt = e.init?.stdin ?? ''
    w.calls.push({
      model: argAfter(argv, '--model'), effort: argAfter(argv, '--effort'), maxTokens: Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS), timeoutMs: e.init?.timeoutMs,
      system: argAfter(argv, '--system-prompt'), prompt, argv, env, cwd: e.init?.cwd,
    })
    const delay = w.delays.get(prompt)
    if (delay) await clock.sleep(delay)
    const r = w.replies.get(prompt)
    const api = argv.includes('--bare')
    const modelId = `claude-${argAfter(argv, '--model')}-5-5`
    const init = cli.init(api ? 'ANTHROPIC_API_KEY' : 'none', modelId)
    const used = { modelUsage: { [modelId]: {} }, total_cost_usd: w.cost }
    const ran = (...lines: object[]) => ({ value: { exitCode: 0, stdout: cli.stream(init, ...lines), stderr: '', isStdoutTruncated: w.truncated, isStderrTruncated: false } })
    if (r === undefined) return ran(cli.resultOk('', used))
    if (typeof r === 'string') return ran(cli.resultOk(r, used))
    if ('deny' in r) return { deny: r.deny }
    if ('rejectAfter' in r) {
      await clock.advance(r.rejectAfter)
      return { deny: 'killed' }
    }
    if ('stdout' in r) return { value: { exitCode: 0, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if ('tokens' in r) return ran(cli.resultOk(r.text, { ...used, usage: { input_tokens: 1, output_tokens: r.tokens } }))
    if (r.reason === 'api-error') return ran(cli.resultApiError(500, used))
    if (r.reason === 'aborted') {
      // The run reaches its time limit: the clock shows it, and the call rejects.
      await clock.advance(e.init?.timeoutMs ?? 0)
      return { deny: 'timed out' }
    }
    return ran(cli.resultOk('', used))
  })
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
    w.descriptions.push(e.description)
    return { value: { tool: `mcp__orch-ui__${e.name}` } }
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, w }
}

type Booted = Awaited<ReturnType<typeof boot>>

const orchestrate = ($: Engine) => $.skill.prompt({ skill: 'orchestrate', text: 'rules' })
let turnNo = 0
async function finish($: Engine, b: Booted, answer: string, extra: Record<string, unknown> = {}) {
  turnNo += 1
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `t${turnNo}`, reason: 'answer', ...extra } as never)
  await b.clock.settle()
}
const show = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'orch-ui', surface: 'terminal', component: 'AssistantMessage', requestId: `m${text.length}-${Math.random()}`, props: { text, isFirstOfReply: true, ...extra } as never })
type Ui = Awaited<ReturnType<typeof show>>
// The engine draws the message itself while no hook rewrites it.
const isOriginal = async (ui: Ui) => (await ui.drawn()).type === 'engine'
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

const PANE = {
  plugin: 'orch-ui', component: 'Pane', requestId: 'orch-ui', surface: 'terminal',
  props: { title: 'orch-ui', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
async function settingsPane($: Engine) {
  return $.ui.mount(PANE as never)
}
const optionRow = async (ui: Awaited<ReturnType<typeof settingsPane>>) => {
  const row = await ui.find({ type: 'Button', key: 'opt-format' })
  const note = (await ui.findAll({ type: 'Text' })).find(t => /raw:|formatted \d|last:/.test(t.text))
  return { label: row?.text, note: note?.text }
}
const callTool = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: FORMAT_TOOL_FULL, ...input } as never)
const resultOf = (r: { result?: unknown }) => String(r.result ?? '')

// The default settings are opus at low effort; the limits come from LIMITS by length.
const SHORT_ROUTE = { model: 'opus', effort: 'low', maxTokens: LIMITS.short.low.maxTokens, timeoutMs: LIMITS.short.low.timeoutMs }
const LONG_ROUTE = { model: 'opus', effort: 'low', maxTokens: LIMITS.long.low.maxTokens, timeoutMs: LIMITS.long.low.timeoutMs }
const SHORT_MAX_TOKENS = SHORT_ROUTE.maxTokens
const SHORT_MODEL = SHORT_ROUTE.model
const LONG_MODEL = LONG_ROUTE.model

// -- conversion --------------------------------------------------------------------------------------

test('an orchestrator reply is asked of the short route once and the row swaps to the banner format', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(true)
  await finish($, b, options.source)
  expect(b.w.calls).toHaveLength(1)
  expect(b.w.calls[0]).toMatchObject({ ...SHORT_ROUTE, system: FORMAT_SYSTEM, prompt: options.source })
  expect(await isOriginal(ui)).toBe(false)
  expect(await texts(ui)).toContain(' Choose how to run the schema migration ')
  await ui.unmount()
})

test('a long reply takes the long route and the row note names it', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(long.source, long.output)
  await orchestrate($)
  await finish($, b, long.source)
  expect(b.w.calls).toHaveLength(1)
  expect(b.w.calls[0]).toMatchObject({ ...LONG_ROUTE, prompt: long.source })
  const ui = await settingsPane($)
  expect((await optionRow(ui)).note).toBe(`formatted 1 · as written 0 · last: ok (long/${LONG_MODEL}) · api $0.01`)
  await ui.unmount()
})

test('a session that never loaded the orchestrate skill is never formatted, whatever the option', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(long.source, long.output)
  for (const text of [options.source, long.source]) {
    await finish($, b, text)
    const ui = await show($, text)
    expect(await isOriginal(ui)).toBe(true)
    await ui.unmount()
  }
  expect(b.w.calls).toEqual([])
  expect(formatTools(b.w)).toEqual([])
  // Another skill does not mark it either.
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await finish($, b, options.source)
  expect(b.w.calls).toEqual([])
  expect(formatTools(b.w)).toEqual([])
})

test('only the main loop\'s finished answer of a routed length starts a conversion', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source, { agentId: 'sub-1' })
  await finish($, b, options.source, { reason: 'aborted', isAborted: true })
  await finish($, b, 'x'.repeat(299))
  await finish($, b, 'x'.repeat(5001))
  await finish($, b, options.source + '\n```\ncode\n```')
  expect(b.w.calls).toEqual([])
  await finish($, b, options.source)
  expect(b.w.calls).toHaveLength(1)
})

test('with the option off nothing is asked and nothing is drawn', async ($, on) => {
  const b = await boot($, on, {})
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  expect(b.w.calls).toEqual([])
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(true)
  await ui.unmount()
})

test('one call per text, however often it comes back', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  await finish($, b, options.source)
  await finish($, b, '\n' + options.source + '\n')
  expect(b.w.calls).toHaveLength(1)
})

// -- failures leave the original --------------------------------------------------------------------

const FAILS: [string, Reply, string, string][] = [
  ['an API error', { reason: 'api-error' }, 'api-error', ' · api $0.01'],
  ['an empty reply', { reason: 'empty-reply' }, 'no-answer', ' · api $0.01'],
  ['a timeout', { reason: 'aborted' }, 'timeout', ' · api $0.00'],
  ['a run the engine refuses', { deny: 'run not allowed' }, 'cli-failed', ' · api $0.00'],
  ['a reply that used its whole cap', { text: options.output, tokens: SHORT_MAX_TOKENS }, 'truncated', ' · api $0.01'],
  ['a rewrite that fails validation', 'Not in the format at all.', 'no-banner', ' · api $0.01'],
  ['a rewrite that drops an id', options.output.replace(/`v3\.0\.0`/g, 'the release'), 'missing-id', ' · api $0.01'],
]
for (const [name, reply, reason, tail] of FAILS) {
  test(`${name}: the original stays, the reason is recorded`, async ($, on) => {
    const b = await boot($, on)
    b.w.replies.set(options.source, reply)
    await orchestrate($)
    await finish($, b, options.source)
    expect(b.w.calls).toHaveLength(1)
    const ui = await show($, options.source)
    expect(await isOriginal(ui)).toBe(true)
    const pane = await settingsPane($)
    expect((await optionRow(pane)).note).toBe(`formatted 0 · as written 1 · last: ${reason} (short/${SHORT_MODEL})${tail}`)
    // The same text is not asked twice.
    await finish($, b, options.source)
    expect(b.w.calls).toHaveLength(1)
    await ui.unmount()
    await pane.unmount()
  })
}

test('a reply one token under its cap is not truncated', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, { text: options.output, tokens: SHORT_MAX_TOKENS - 1 })
  await orchestrate($)
  await finish($, b, options.source)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(false)
  await ui.unmount()
})

test('summary rows and other surfaces are left as they are', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  const summary = await show($, options.source, { isSummary: true })
  expect(await isOriginal(summary)).toBe(true)
  const desktop = await $.ui.mount({ plugin: 'orch-ui', surface: 'desktop', component: 'AssistantMessage', requestId: 'd1', props: { text: options.source, isFirstOfReply: true } })
  expect(await desktop.drawn()).toMatchObject({ type: 'engine' })
  await summary.unmount()
  await desktop.unmount()
})

// -- the settings pane ----------------------------------------------------------------------------------

test('session start registers /orch-ui once and /orch-ui opens the pane', async ($, on) => {
  const b = await boot($, on)
  expect(b.w.commands).toEqual(['orch-ui'])
  const out = await $.command.run({ command: 'orch-ui', args: '' } as never)
  await b.clock.settle()
  expect(out.text).toBe('orch-ui settings opened.')
  expect(b.w.opened).toHaveLength(1)
  expect(b.w.opened[0]).toMatchObject({ id: 'orch-ui', title: 'orch-ui', closeOnEscape: true })
})

test('the pane holds the Format replies row and the five setting rows, in order', async ($, on) => {
  await boot($, on, SETTINGS_SEED)
  const ui = await settingsPane($)
  expect((await ui.findAll({ type: 'Button' })).map(x => x.key)).toEqual(['opt-format', ...ROW_KEYS])
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  await ui.unmount()
})

// The setting rows: stored keys, the pane's button keys and the default stored values.
const SETTINGS_SEED = { 'opt:format': true, 'opt:format-trigger': undefined }
const ROW_KEYS = ['opt-format-trigger', 'opt-format-model', 'opt-format-effort', 'opt-format-billing', 'opt-format-key']
type SettingsPane = Awaited<ReturnType<typeof settingsPane>>
const buttonText = async (ui: SettingsPane, key: string) => (await ui.find({ type: 'Button', key }))?.text
const buttonKeys = async (ui: SettingsPane) => (await ui.findAll({ type: 'Button' })).map(x => x.key)
const paneTexts = async (ui: SettingsPane) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

// -- the settings row ------------------------------------------------------------------------------------

test('Format replies: off by default, a press flips it and the store keeps it, the store is read at session start', async ($, on) => {
  const b = await boot($, on, {})
  const ui = await settingsPane($)
  expect((await optionRow(ui)).label).toBe('[ ] Format replies')
  expect((await optionRow(ui)).note).toBeUndefined()
  await ui.press({ key: 'opt-format' })
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  expect(b.w.store.get('opt:format')).toBe(true)
  await ui.press({ key: 'opt-format' })
  expect((await optionRow(ui)).label).toBe('[ ] Format replies')
  expect(b.w.store.get('opt:format')).toBe(false)
  await ui.unmount()
})

test('Format replies reads the stored option at session start', async ($, on) => {
  await boot($, on, { 'opt:format': true })
  const ui = await settingsPane($)
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  await ui.unmount()
})

// -- the setting rows -----------------------------------------------------------------------------------

test('setting rows: labels, values and notes at the defaults', async ($, on) => {
  await boot($, on, SETTINGS_SEED)
  const ui = await settingsPane($)
  expect(await buttonText(ui, 'opt-format-trigger')).toBe('Format trigger: marked')
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: opus')
  expect(await buttonText(ui, 'opt-format-effort')).toBe('Format effort: low')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: API key')
  expect(await buttonText(ui, 'opt-format-key')).toBe('Format API key: ANTHROPIC_API_KEY')
  const texts_ = await paneTexts(ui)
  expect(texts_).toContain('only replies the orchestrator marks')
  expect(texts_).toContain("API key: billed to that key's account")
  expect(texts_).toContain('from ANTHROPIC_API_KEY')
  await ui.unmount()
})

const CYCLES: [string, string, string, [string, string][]][] = [
  ['trigger', 'opt-format-trigger', 'opt:format-trigger', [['Format trigger: auto', 'auto'], ['Format trigger: marked', 'marked']]],
  ['model', 'opt-format-model', 'opt:format-model', [['Format model: sonnet', 'sonnet'], ['Format model: haiku', 'haiku'], ['Format model: opus', 'opus']]],
  ['effort', 'opt-format-effort', 'opt:format-effort', [['Format effort: medium', 'medium'], ['Format effort: high', 'high'], ['Format effort: low', 'low']]],
  ['billing', 'opt-format-billing', 'opt:format-billing', [['Format billing: subscription', 'subscription'], ['Format billing: API key', 'api']]],
  ['key', 'opt-format-key', 'opt:format-key', [['Format API key: ~/.claude/settings.local.json', 'file'], ['Format API key: ANTHROPIC_API_KEY', 'env']]],
]
for (const [name, key, storeKey, steps] of CYCLES) {
  test(`setting row ${name}: each press moves to the next value and stores it under ${storeKey}`, async ($, on) => {
    const b = await boot($, on, SETTINGS_SEED)
    const ui = await settingsPane($)
    expect(b.w.store.get(storeKey)).toBeUndefined()
    for (const [shown, stored] of steps) {
      await ui.press({ key })
      expect(await buttonText(ui, key)).toBe(shown)
      expect(b.w.store.get(storeKey)).toBe(stored)
    }
    await ui.unmount()
  })
}

test('setting rows: the notes follow the values', async ($, on) => {
  await boot($, on, SETTINGS_SEED)
  const ui = await settingsPane($)
  await ui.press({ key: 'opt-format-trigger' })
  expect(await paneTexts(ui)).toContain('every eligible reply')
  expect(await paneTexts(ui)).not.toContain('only replies the orchestrator marks')
  await ui.press({ key: 'opt-format-key' })
  expect(await paneTexts(ui)).toContain('from ~/.claude/settings.local.json')
  await ui.press({ key: 'opt-format-billing' })
  expect(await paneTexts(ui)).toContain('subscription: counts toward your plan')
  expect(await paneTexts(ui)).not.toContain("API key: billed to that key's account")
  await ui.unmount()
})

test('setting rows: the API key row is drawn only while billing is api', async ($, on) => {
  await boot($, on, SETTINGS_SEED)
  const ui = await settingsPane($)
  expect(await buttonKeys(ui)).toContain('opt-format-key')
  await ui.press({ key: 'opt-format-billing' })
  expect(await buttonKeys(ui)).toEqual(['opt-format', 'opt-format-trigger', 'opt-format-model', 'opt-format-effort', 'opt-format-billing'])
  expect((await paneTexts(ui)).some(t => t.startsWith('from '))).toBe(false)
  await ui.press({ key: 'opt-format-billing' })
  expect(await buttonKeys(ui)).toEqual(['opt-format', ...ROW_KEYS])
  await ui.unmount()
})

test('setting rows: an unknown stored value reads as the default', async ($, on) => {
  await boot($, on, { 'opt:format': true, 'opt:format-trigger': 'sometimes', 'opt:format-model': 'fable', 'opt:format-effort': 'max', 'opt:format-billing': 'oauth', 'opt:format-key': 7 })
  const ui = await settingsPane($)
  expect(await buttonText(ui, 'opt-format-trigger')).toBe('Format trigger: marked')
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: opus')
  expect(await buttonText(ui, 'opt-format-effort')).toBe('Format effort: low')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: API key')
  expect(await buttonText(ui, 'opt-format-key')).toBe('Format API key: ANTHROPIC_API_KEY')
  // the first press moves on from the default, not from the unknown value
  await ui.press({ key: 'opt-format-model' })
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: sonnet')
  await ui.unmount()
})

test('setting rows: the stored values are read at session start', async ($, on) => {
  await boot($, on, { 'opt:format': true, 'opt:format-trigger': 'auto', 'opt:format-model': 'haiku', 'opt:format-effort': 'high', 'opt:format-billing': 'subscription', 'opt:format-key': 'file' })
  const ui = await settingsPane($)
  expect(await buttonText(ui, 'opt-format-trigger')).toBe('Format trigger: auto')
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: haiku')
  expect(await buttonText(ui, 'opt-format-effort')).toBe('Format effort: high')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: subscription')
  expect(await buttonKeys(ui)).not.toContain('opt-format-key')
  await ui.unmount()
})

test('setting rows: a press applies from the next call', async ($, on) => {
  const b = await boot($, on, SETTINGS_SEED)
  const ui = await settingsPane($)
  await ui.press({ key: 'opt-format-trigger' })
  await ui.press({ key: 'opt-format-model' })
  await ui.press({ key: 'opt-format-effort' })
  await ui.press({ key: 'opt-format-billing' })
  await ui.unmount()
  await convertOne($, b)
  expect(lastCall(b)).toMatchObject({ model: 'sonnet', effort: 'medium', maxTokens: LIMITS.short.medium.maxTokens, timeoutMs: LIMITS.short.medium.timeoutMs })
  expect(lastCall(b).argv.includes('--bare')).toBe(false)
})

for (const id of ['opt-format-trigger', 'opt-format-model', 'opt-format-effort', 'opt-format-billing', 'opt-format-key']) {
  test(`setting rows: a press of ${id} clears a pause`, async ($, on) => {
    const b = await boot($, on)
    b.w.replies.set(options.source, { stdout: cli.stream(cli.init('none'), cli.resultOk(options.output, { total_cost_usd: 0.0061 })) })
    await orchestrate($)
    await finish($, b, options.source)
    const ui = await settingsPane($)
    expect((await optionRow(ui)).note).toMatch(/paused: billing-mismatch$/)
    await ui.press({ key: id })
    expect((await optionRow(ui)).note).not.toMatch(/paused/)
    await ui.unmount()
  })
}

test('setting rows: the key row names the source and the last key reason, and shows no key, no gateway value', async ($, on) => {
  const URL = 'https://gateway.example.test/sentinel-path'
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' }, { HOME: '/home/u', ANTHROPIC_BASE_URL: URL })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  const ui = await settingsPane($)
  expect(await paneTexts(ui)).toContain('from ~/.claude/settings.local.json · last: base-url-set')
  const all = JSON.stringify(await paneTexts(ui))
  expect(all.includes(cli.KEY)).toBe(false)
  expect(all.includes('sentinel')).toBe(false)
  expect(all.includes('gateway.example')).toBe(false)
  await ui.unmount()
})

test('setting rows: no ANTHROPIC_API_KEY under API billing shows billing-mismatch as the key row\'s last reason', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, { stdout: cli.stream(cli.init('none'), cli.resultNoCredential()) })
  await orchestrate($)
  await finish($, b, options.source)
  const ui = await settingsPane($)
  expect(await paneTexts(ui)).toContain('from ANTHROPIC_API_KEY · last: billing-mismatch')
  expect((await optionRow(ui)).note).toMatch(/paused: billing-mismatch$/)
  await ui.unmount()
})

test('setting rows: a missing key file is the last key reason', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  await convertOne($, b)
  const ui = await settingsPane($)
  expect(await paneTexts(ui)).toContain('from ~/.claude/settings.local.json · last: key-file-missing')
  await ui.unmount()
})

test('setting rows: after a success the key row carries no reason', async ($, on) => {
  const b = await boot($, on, SETTINGS_SEED)
  await convertOne($, b, options.source, options.output)
  const ui = await settingsPane($)
  expect(await paneTexts(ui)).toContain('from ANTHROPIC_API_KEY')
  expect((await paneTexts(ui)).some(t => t.startsWith('from ') && t.includes('last:'))).toBe(false)
  await ui.unmount()
})

// -- raw ---------------------------------------------------------------------------------------------

const OTHER_SOURCE = done.source
async function twoFormatted($: Engine, b: Booted) {
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(OTHER_SOURCE, done.output)
  await orchestrate($)
  await finish($, b, options.source)
  await finish($, b, OTHER_SOURCE)
  const first = await show($, options.source)
  const second = await show($, OTHER_SOURCE)
  return { first, second }
}

test('the raw tool is registered when the session is marked, and not before', async ($, on) => {
  const b = await boot($, on)
  expect(formatTools(b.w)).toEqual([])
  await orchestrate($)
  expect(formatTools(b.w)).toEqual([FORMAT_TOOL])
  await orchestrate($)
  expect(formatTools(b.w)).toEqual([FORMAT_TOOL])
  expect(FORMAT_TOOL_FULL).toBe('mcp__orch-ui__set_message_format')
})

test('raw with the default scope shows only the newest formatted message as written, and the next reply is formatted again', async ($, on) => {
  const b = await boot($, on)
  const { first, second } = await twoFormatted($, b)
  const r = await callTool($, { format: 'raw' })
  expect(resultOf(r)).toContain('Scope latest')
  expect(resultOf(r)).toContain('next message will be formatted again')
  expect(await isOriginal(second)).toBe(true)
  expect(await isOriginal(first)).toBe(false)
  // Asking again says so and changes nothing.
  expect(resultOf(await callTool($, { format: 'raw', scope: 'latest' }))).toContain('already shown as written')
  expect(await isOriginal(first)).toBe(false)
  b.w.replies.set(review.source, review.output)
  await finish($, b, review.source)
  const third = await show($, review.source)
  expect(await isOriginal(third)).toBe(false)
  expect(b.w.calls).toHaveLength(3)
  // The newest is now the third.
  await callTool($, { format: 'raw' })
  expect(await isOriginal(third)).toBe(true)
  expect(await isOriginal(first)).toBe(false)
})

test('raw for the session shows every row as written and starts no conversion; formatted brings both back', async ($, on) => {
  const b = await boot($, on)
  const { first, second } = await twoFormatted($, b)
  const r = await callTool($, { format: 'raw', scope: 'session' })
  expect(resultOf(r)).toContain('Scope session')
  expect(resultOf(r)).toContain('stored option in orch-ui is untouched')
  expect(await isOriginal(first)).toBe(true)
  expect(await isOriginal(second)).toBe(true)
  b.w.replies.set(review.source, review.output)
  await finish($, b, review.source)
  expect(b.w.calls).toHaveLength(2)
  expect(b.w.store.get('opt:format')).toBe(true)
  // Latest marks while the session is raw change nothing visible, and formatted clears them all.
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('Formatted again')
  expect(await isOriginal(first)).toBe(false)
  expect(await isOriginal(second)).toBe(false)
  await finish($, b, review.source)
  expect(b.w.calls).toHaveLength(3)
})

test('formatted clears a latest mark too, and its scope is ignored', async ($, on) => {
  const b = await boot($, on)
  const { second } = await twoFormatted($, b)
  await callTool($, { format: 'raw' })
  expect(await isOriginal(second)).toBe(true)
  await callTool($, { format: 'formatted', scope: 'latest' })
  expect(await isOriginal(second)).toBe(false)
})

test('raw with nothing formatted changes nothing', async ($, on) => {
  await boot($, on)
  await orchestrate($)
  expect(resultOf(await callTool($, { format: 'raw' }))).toContain('No formatted message to show raw')
})

test('an unknown scope or format is refused with a result that says so', async ($, on) => {
  const b = await boot($, on)
  const { first, second } = await twoFormatted($, b)
  for (const input of [{ format: 'raw', scope: 'all' }, { format: 'raw', scope: 5 }, { format: 'plain' }, {}]) {
    expect(resultOf(await callTool($, input))).toMatch(/^Refused: .* Nothing changed\.$/)
  }
  expect(await isOriginal(first)).toBe(false)
  expect(await isOriginal(second)).toBe(false)
})

test('with the option off the tool says so and changes nothing', async ($, on) => {
  await boot($, on, {})
  await orchestrate($)
  for (const input of [{ format: 'raw' }, { format: 'raw', scope: 'session' }, { format: 'formatted' }]) {
    expect(resultOf(await callTool($, input))).toBe("Formatting is off in orch-ui's settings (/orch-ui); nothing changed.")
  }
  const ui = await settingsPane($)
  expect((await optionRow(ui)).note).toBeUndefined()
  await ui.unmount()
})

test('the settings row shows the raw state, and a press clears it and keeps the option on', async ($, on) => {
  const b = await boot($, on)
  const { first, second } = await twoFormatted($, b)
  const ui = await settingsPane($)
  expect((await optionRow(ui)).note).toMatch(/^formatted 2 · as written 0 · last: ok/)
  await callTool($, { format: 'raw' })
  expect((await optionRow(ui)).note).toMatch(/^raw: 1 message\(s\) · formatted 2/)
  await ui.press({ key: 'opt-format' })
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  expect(await isOriginal(second)).toBe(false)
  await callTool($, { format: 'raw', scope: 'session' })
  expect((await optionRow(ui)).note).toMatch(/^raw: this session · formatted 2/)
  await ui.press({ key: 'opt-format' })
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  expect(await isOriginal(first)).toBe(false)
  expect(b.w.store.get('opt:format')).toBe(true)
  // With no raw state a press flips the option.
  await ui.press({ key: 'opt-format' })
  expect((await optionRow(ui)).label).toBe('[ ] Format replies')
  await ui.unmount()
})

test('/clear forgets the marking, the raw state and the list; the option stays', async ($, on) => {
  const b = await boot($, on)
  const { first, second } = await twoFormatted($, b)
  await callTool($, { format: 'raw' })
  await callTool($, { format: 'raw', scope: 'session' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  // No longer an orchestrator session: every row is the engine's.
  expect(await isOriginal(first)).toBe(true)
  expect(await isOriginal(second)).toBe(true)
  b.w.replies.set(review.source, review.output)
  await finish($, b, review.source)
  expect(b.w.calls).toHaveLength(2)
  // Loaded again: nothing is raw any more, the old entries draw formatted, and the list is empty so "raw" has nothing to mark.
  await orchestrate($)
  expect(await isOriginal(first)).toBe(false)
  expect(await isOriginal(second)).toBe(false)
  expect(resultOf(await callTool($, { format: 'raw' }))).toContain('No formatted message to show raw')
  expect(b.w.store.get('opt:format')).toBe(true)
})

// -- /clear: every atom reads its default while $.store holds the user's choices ---------------------------------
// A /clear gives the session a new id and fires no session.start, and the engine resets the plugin's atoms with the
// session. The kit keeps atoms across session.end, so this builds the same state directly: boot with an empty store
// (session.start loads the defaults into the atoms; boot's own trigger seed is dropped), then store the choices.

const CHOSEN = { 'opt:format': true, 'opt:format-trigger': 'auto', 'opt:format-model': 'sonnet', 'opt:format-effort': 'medium', 'opt:format-billing': 'subscription', 'opt:format-key': 'file' }
async function bootThenStore($: Engine, on: On, stored: Record<string, unknown> = CHOSEN) {
  const b = await boot($, on, { 'opt:format-trigger': undefined })
  for (const [k, v] of Object.entries(stored)) b.w.store.set(k, v)
  return b
}

test('after a /clear the stored model, effort and billing are the ones a conversion uses and the pane draws', async ($, on) => {
  const b = await bootThenStore($, on)
  // The instrument: the atoms really read their defaults here (a pane left open draws them; see the README).
  const before = await settingsPane($)
  expect((await optionRow(before)).label).toBe('[ ] Format replies')
  expect(await buttonText(before, 'opt-format-model')).toBe('Format model: opus')
  await before.unmount()
  await convertOne($, b)
  expect(b.w.calls).toHaveLength(1)
  // Stored subscription billing: no --bare, so no API key can pay for this call.
  expect(lastCall(b)).toMatchObject({ model: 'sonnet', effort: 'medium', maxTokens: LIMITS.short.medium.maxTokens, timeoutMs: LIMITS.short.medium.timeoutMs })
  expect(lastCall(b).argv.includes('--bare')).toBe(false)
  expect(await noteOf($)).toBe('formatted 1 · as written 0 · last: ok (short/sonnet) · plan $0.01')
  const ui = await settingsPane($)
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: sonnet')
  expect(await buttonText(ui, 'opt-format-effort')).toBe('Format effort: medium')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: subscription')
  await ui.unmount()
})

test('after a /clear /orch-ui loads the stored settings before the pane opens', async ($, on) => {
  const b = await bootThenStore($, on)
  await $.command.run({ command: 'orch-ui', args: '' } as never)
  await b.clock.settle()
  const ui = await settingsPane($)
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  expect(await buttonText(ui, 'opt-format-trigger')).toBe('Format trigger: auto')
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: sonnet')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: subscription')
  await ui.unmount()
})

test('after a /clear a press of the Format replies row flips the stored option, not the default', async ($, on) => {
  const b = await bootThenStore($, on)
  const ui = await settingsPane($)
  await ui.press({ key: 'opt-format' })
  expect(b.w.store.get('opt:format')).toBe(false)
  expect((await optionRow(ui)).label).toBe('[ ] Format replies')
  // The other choices were loaded by the same press and stay as stored.
  expect(await buttonText(ui, 'opt-format-model')).toBe('Format model: sonnet')
  expect(await buttonText(ui, 'opt-format-billing')).toBe('Format billing: subscription')
  await ui.unmount()
})

const AFTER_CLEAR: [string, string, string, string][] = [
  ['trigger', 'opt-format-trigger', 'opt:format-trigger', 'marked'],
  ['model', 'opt-format-model', 'opt:format-model', 'haiku'],
  ['effort', 'opt-format-effort', 'opt:format-effort', 'high'],
  ['billing', 'opt-format-billing', 'opt:format-billing', 'api'],
  ['key', 'opt-format-key', 'opt:format-key', 'env'],
]
for (const [name, key, storeKey, expected] of AFTER_CLEAR) {
  test(`after a /clear the first press of the ${name} row moves on from the stored value (${expected}) and the other stored values stay`, async ($, on) => {
    // Billing is api here so the key row exists; every other stored value is the user's.
    const stored = name === 'key' ? { ...CHOSEN, 'opt:format-billing': 'api' } : CHOSEN
    const b = await bootThenStore($, on, stored)
    const ui = await settingsPane($)
    await ui.press({ key })
    expect(b.w.store.get(storeKey)).toBe(expected)
    for (const [k, v] of Object.entries(stored)) if (k !== storeKey && k !== 'opt:format') expect(b.w.store.get(k)).toBe(v)
    expect(b.w.store.get('opt:format')).toBe(true)
    await ui.unmount()
  })
}

test('a session end for another reason keeps the state', async ($, on) => {
  const b = await boot($, on)
  const { second } = await twoFormatted($, b)
  await callTool($, { format: 'raw' })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: {} } as never)
  expect(await isOriginal(second)).toBe(true)
})

test('"latest" is the newest turn, not the newest result', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(OTHER_SOURCE, done.output)
  // The first turn's rewrite lands after the second's.
  b.w.delays.set(options.source, 5000)
  await orchestrate($)
  await $.turn.complete({ answer: options.source, durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' })
  await b.clock.settle()
  await $.turn.complete({ answer: OTHER_SOURCE, durationMs: 1, isAborted: false, turnId: 'b', reason: 'answer' })
  await b.clock.settle()
  const second = await show($, OTHER_SOURCE)
  expect(await isOriginal(second)).toBe(false)
  await b.clock.advance(5000)
  const first = await show($, options.source)
  expect(await isOriginal(first)).toBe(false)
  await callTool($, { format: 'raw' })
  expect(await isOriginal(second)).toBe(true)
  expect(await isOriginal(first)).toBe(false)
})

// -- the drawing ---------------------------------------------------------------------------------------------

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (x: unknown): x is Node => typeof x === 'object' && x !== null
// Every element of a drawn tree with its parent, in document order.
function walk(root: unknown): { node: Node; parent: Node | null }[] {
  const out: { node: Node; parent: Node | null }[] = []
  const go = (n: unknown, parent: Node | null) => {
    if (!isNode(n)) return
    out.push({ node: n, parent })
    for (const c of n.children ?? []) go(c, n)
  }
  go(root, null)
  return out
}
const PILLS = new Set(Object.values(KINDS).map(k => k.pill))
const plain = (n: Node) => (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')

async function tree($: Engine, b: Booted, source: string, output: string) {
  b.w.replies.set(source, output)
  await orchestrate($)
  await finish($, b, source)
  const ui = await show($, source)
  const nodes = walk(await ui.drawn())
  return { ui, nodes }
}

test('drawing: one banner, the only element with a background but the pills, colored by its tag', async ($, on) => {
  const cases: [string, string, string][] = [
    [options.source, options.output, 'error'],
    [done.source, done.output, 'success'],
    [INFO_SOURCE, INFO_OUTPUT, 'permission'],
  ]
  const b = await boot($, on)
  for (const [source, output, color] of cases) {
    const { ui, nodes } = await tree($, b, source, output)
    const backgrounds = nodes.filter(x => x.node.props?.backgroundColor !== undefined && !PILLS.has(String(x.node.props.backgroundColor)))
    expect(backgrounds).toHaveLength(1)
    expect(backgrounds[0]?.node).toMatchObject({ type: 'Text', props: { bold: true, color: 'inverseText', backgroundColor: color } })
    // No box has a background: the card and the sections are drawn by their border and their title.
    expect(nodes.filter(x => x.node.type === 'Box' && x.node.props?.backgroundColor !== undefined)).toEqual([])
    await ui.unmount()
  }
})

test('drawing: section titles are bold, underlined and in the text color, with their icon', async ($, on) => {
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, options.source, options.output)
  const titles = nodes.filter(x => x.node.type === 'Text' && x.node.props?.underline === true)
  expect(titles.map(x => plain(x.node))).toEqual(['What is already in place', 'Pick a, b, or later'])
  for (const { node, parent } of titles) {
    expect(node.props).toMatchObject({ underline: true, color: 'text' })
    expect(parent).toMatchObject({ type: 'Text', props: { bold: true } })
  }
  // The icon is the title's first sibling: the ask section's in the success color, the others' in permission.
  expect(titles.map(x => (x.parent?.children?.[0] as Node).props?.color)).toEqual(['permission', 'success'])
  expect(titles.map(x => plain(x.parent?.children?.[0] as Node).trim())).toEqual(['ℹ', '❯'])
  await ui.unmount()
})

test('drawing: backticks in the banner, section, card and ask titles are not drawn', async ($, on) => {
  const b = await boot($, on)
  // A banner with an id: done.output's title is "Cache eviction fix is merged to `main`".
  expect(done.output.split('\n')[0]).toContain('`main`')
  const first = await tree($, b, done.source, done.output)
  const banner = first.nodes.find(x => x.node.props?.backgroundColor === 'success')?.node as Node
  expect(plain(banner)).toBe(' Cache eviction fix is merged to main ')
  await first.ui.unmount()

  const source = FILLER.repeat(5) + 'The file `src/a.ts` is unchanged. Reply `go` or `stop`.'
  const output = ['# [info] `src/a.ts` is unchanged', '', '## [card] Check `src/a.ts` first', '',
    '- [note] The file `src/a.ts` is unchanged', '  Work continues as planned and nothing else has changed since the last report.', '',
    '## [more] About `src/a.ts`', '- **File:** `src/a.ts` is unchanged.', '',
    '## [ask] Reply `go` or `stop`', '- **`go`:** go on', '- **`stop`:** stop'].join('\n')
  const second = await tree($, b, source, output)
  const n = second.nodes
  const banner2 = n.find(x => x.node.props?.backgroundColor === 'permission')?.node as Node
  const card = n.find(x => x.node.props?.borderStyle === 'round')?.node as Node
  const cardTitle = (card.children ?? []).find(c => isNode(c) && c.type === 'Text') as Node
  const sections = n.filter(x => x.node.type === 'Text' && x.node.props?.underline === true).map(x => plain(x.node))
  expect([plain(banner2), plain(cardTitle), ...sections]).toEqual([' src/a.ts is unchanged ', 'Check src/a.ts first', 'About src/a.ts', 'Reply go or stop'])
  await second.ui.unmount()
})

test('drawing: the do section has its icon in the error color, the ask section in the success color', async ($, on) => {
  const source = 'Fixed `a.ts`. ' + FILLER.repeat(4) + 'Reply `go` or `stop`.'
  const output = ['# [act] Fixed `a.ts`', '', '## [do] Review the change', '- **Review:** read `a.ts`.', '',
    '## [ask] Go on?', '- **`go`:** go on', '- **`stop`:** stop'].join('\n')
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, source, output)
  const iconOf = (glyph: string) => nodes.find(x => x.node.type === 'Text' && plain(x.node) === `${glyph} `)?.node.props?.color
  expect(iconOf('▶')).toBe('error')
  expect(iconOf('❯')).toBe('success')
  // Reply pills use the reply kind.
  const pills = nodes.filter(x => x.node.type === 'Text' && x.node.props?.backgroundColor === KINDS.reply.pill)
  expect(pills.map(x => plain(x.node))).toEqual([`${KINDS.reply.icon} go`, `${KINDS.reply.icon} stop`])
  await ui.unmount()
})

test('drawing: the card is a round border without a background, colored by its worst row, with a plain title', async ($, on) => {
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, review.source, review.output)
  const cards = nodes.filter(x => x.node.type === 'Box' && x.node.props?.borderStyle === 'round')
  expect(cards).toHaveLength(1)
  const card = cards[0]?.node as Node
  expect(card.props?.backgroundColor).toBeUndefined()
  // The review fixture has an error and a warn row: the worst decides.
  expect(card.props?.borderColor).toBe('error')
  const title = (card.children ?? []).find(c => isNode(c) && c.type === 'Text') as Node
  expect(title.props).toMatchObject({ bold: true, color: 'error' })
  expect(title.props?.underline).toBeUndefined()
  const icons = walk(card).filter(x => x.node.type === 'Text' && ['✖', '⚠', 'ℹ', '✔'].includes(plain(x.node).trim()))
  expect(icons.map(x => [plain(x.node).trim(), x.node.props?.color])).toEqual([['✖', 'error'], ['⚠', 'warning']])
  await ui.unmount()

  // A card of notes and good rows is colored by the worst of those.
  const source = FILLER.repeat(5) + 'The file `src/a.ts` is unchanged.'
  const output = '# [info] `src/a.ts` is unchanged\n\n## [card] Worth knowing\n\n- [good] The file `src/a.ts` is unchanged\n  Work continues as planned and nothing else has changed since the last report.\n- [note] Nothing else changed'
  const second = await tree($, b, source, output)
  const only = second.nodes.find(x => x.node.props?.borderStyle === 'round')?.node
  expect(only?.props?.borderColor).toBe('permission')
  await second.ui.unmount()
})

test('drawing: bullets are one line with a dot, a bold white lead-in, no dimmed body, and a margin under each title', async ($, on) => {
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, options.source, options.output)
  const dots = nodes.filter(x => x.node.type === 'Text' && plain(x.node) === '•')
  expect(dots.length).toBeGreaterThan(2)
  for (const { parent } of dots) {
    // A row: the dot box, then one box with the text. No column of labels, no stacked label over text.
    const row = nodes.find(x => x.node === parent)?.parent
    expect(row).toMatchObject({ type: 'Box', props: { flexDirection: 'row' } })
    expect(row?.children).toHaveLength(2)
  }
  const leads = nodes.filter(x => x.node.type === 'Text' && x.node.props?.bold === true && x.node.props?.color === '#ffffff')
  expect(leads.length).toBeGreaterThan(2)
  expect(nodes.filter(x => x.node.props?.dimColor !== undefined)).toEqual([])
  // Under every section title, the body box has a margin of one line.
  const titled = nodes.filter(x => x.node.type === 'Text' && x.node.props?.underline === true).map(x => x.parent)
  for (const t of titled) {
    const section = nodes.find(x => x.node === t)?.parent
    const bodyBox = (section?.children ?? []).find(c => isNode(c) && c !== t) as Node
    expect(bodyBox.props).toMatchObject({ flexDirection: 'column', marginTop: 1 })
  }
  await ui.unmount()
})

test('drawing: ids, files, urls, versions and issues get their own pill kinds', async ($, on) => {
  const source = FILLER.repeat(4) + 'See `src/a.ts`, `https://example.com/x`, `v1.2.3`, `#42`, `Q33` and `9be41d07` and `cargo test`.'
  const output = '# [info] Where it stands\n\n## [more] References\n\n- **Refs:** `src/a.ts`, `https://example.com/x`, `v1.2.3`, `#42`, `Q33`, `9be41d07`, `cargo test`.\n- **Work:** it continues as planned and nothing else has changed since the last report.'
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, source, output)
  const pill = (value: string) => nodes.find(x => x.node.type === 'Text' && x.node.props?.backgroundColor !== undefined && plain(x.node).endsWith(value))?.node.props
  expect(pill('src/a.ts')).toMatchObject({ color: KINDS.file.color, backgroundColor: KINDS.file.pill })
  expect(pill('https://example.com/x')).toMatchObject({ backgroundColor: KINDS.url.pill })
  expect(pill('v1.2.3')).toMatchObject({ backgroundColor: KINDS.version.pill })
  expect(pill('#42')).toMatchObject({ backgroundColor: KINDS.issue.pill })
  expect(pill('Q33')).toMatchObject({ backgroundColor: KINDS.id.pill })
  expect(pill('9be41d07')).toMatchObject({ backgroundColor: KINDS.commit.pill })
  expect(pill('cargo test')).toMatchObject({ backgroundColor: KINDS.code.pill })
  await ui.unmount()
})

// -- the child process: settings, key, environment, working directory -------------------------------------

const KEY_PATH = '/home/u/.claude/settings.local.json'
const KEY_FILE = `{\n  "orchUi": { "formatApiKey": "${cli.KEY}" }\n}\n`
const claudeRuns = (b: Booted) => b.w.runs.filter(a => a[0] === 'claude')
const lastCall = (b: Booted) => b.w.calls[b.w.calls.length - 1]!

async function convertOne($: Engine, b: Booted, source = options.source, output = options.output) {
  b.w.replies.set(source, output)
  await orchestrate($)
  await finish($, b, source)
}
const noteOf = async ($: Engine) => {
  const pane = await settingsPane($)
  const note = (await optionRow(pane)).note
  await pane.unmount()
  return note
}

test('settings: model, effort and billing come from the store, and the limits follow the length and effort', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-model': 'sonnet', 'opt:format-effort': 'medium', 'opt:format-billing': 'subscription' })
  await convertOne($, b)
  expect(b.w.calls).toHaveLength(1)
  expect(lastCall(b)).toMatchObject({ model: 'sonnet', effort: 'medium', maxTokens: LIMITS.short.medium.maxTokens, timeoutMs: LIMITS.short.medium.timeoutMs, system: FORMAT_SYSTEM, prompt: options.source })
  expect(lastCall(b).argv.includes('--bare')).toBe(false)
  b.w.replies.set(long.source, long.output)
  await finish($, b, long.source)
  expect(lastCall(b)).toMatchObject({ model: 'sonnet', effort: 'medium', maxTokens: LIMITS.long.medium.maxTokens, timeoutMs: LIMITS.long.medium.timeoutMs })
  expect(await noteOf($)).toBe('formatted 2 · as written 0 · last: ok (long/sonnet) · plan $0.01')
})

// Spend is kept per billing: a switch inside a session never relabels money already spent.
const SWITCH_CASES: [string, string, string, string][] = [
  ['api then subscription', 'api', 'subscription', 'api $0.02 · plan $0.04'],
  ['subscription then api', 'subscription', 'api', 'api $0.04 · plan $0.02'],
]
for (const [name, first, second, spend] of SWITCH_CASES) {
  test(`settings: switching billing in a session labels each amount with its own billing (${name})`, async ($, on) => {
    const b = await boot($, on, { 'opt:format': true, 'opt:format-billing': first })
    b.w.replies.set(options.source, options.output)
    b.w.replies.set(done.source, done.output)
    await orchestrate($)
    b.w.cost = 0.02
    await finish($, b, options.source)
    expect(await noteOf($)).toMatch(new RegExp(`${first === 'api' ? 'api' : 'plan'} \\$0\\.02$`))
    const ui = await settingsPane($)
    await ui.press({ key: 'opt-format-billing' })
    await ui.unmount()
    b.w.cost = 0.04
    await finish($, b, done.source)
    expect(b.w.calls.map(c => c.argv.includes('--bare'))).toEqual([first === 'api', second === 'api'])
    expect(await noteOf($)).toBe(`formatted 2 · as written 0 · last: ok (short/opus) · ${spend}`)
  })
}

test('settings: a stored value of another kind reads as the default (opus, low, api, env)', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-model': 'fable', 'opt:format-effort': 'max', 'opt:format-billing': 'oauth', 'opt:format-key': 7 })
  await convertOne($, b)
  expect(lastCall(b)).toMatchObject(SHORT_ROUTE)
  expect(lastCall(b).argv.includes('--bare')).toBe(true)
  expect(b.w.stats).toEqual([])
})

const BILLING_CASES: [string, Record<string, unknown>][] = [
  ['api + env', { 'opt:format': true }],
  ['api + file', { 'opt:format': true, 'opt:format-key': 'file' }],
  ['subscription', { 'opt:format': true, 'opt:format-billing': 'subscription' }],
]
for (const [name, seed] of BILLING_CASES) {
  test(`billing ${name}: ${name === 'subscription' ? 'no --bare, the key is blanked' : '--bare'}, and ANTHROPIC_AUTH_TOKEN is blank`, async ($, on) => {
    const b = await boot($, on, seed)
    b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
    b.w.env.ANTHROPIC_API_KEY = 'sentinel-session-key-000000'
    b.w.env.ANTHROPIC_AUTH_TOKEN = 'sentinel-bearer-000000'
    await convertOne($, b)
    const c = lastCall(b)
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(c.argv.includes('--bare')).toBe(name !== 'subscription')
    if (name === 'subscription') expect(c.env.ANTHROPIC_API_KEY).toBe('')
    if (name === 'api + env') expect('ANTHROPIC_API_KEY' in c.env).toBe(false)
    if (name === 'api + file') expect(c.env.ANTHROPIC_API_KEY).toBe(cli.KEY)
    expect(Object.keys(c.env).sort().filter(k => k !== 'ANTHROPIC_API_KEY')).toEqual(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'])
    expect(JSON.stringify([c.argv, c.prompt]).includes('sentinel')).toBe(false)
  })
}

// Everything a leak could reach: argv of every run, stdin, ui.log, the store, the paths touched, the note, the tool result
// and the drawn rows. The env of the claude run is the one place the key may be.
async function visible($: Engine, b: Booted, ui: Ui) {
  const pane = await settingsPane($)
  const all = JSON.stringify({
    runs: b.w.runs, prompts: b.w.calls.map(c => c.prompt), logs: b.w.logs, store: [...b.w.store], written: b.w.written, stats: b.w.stats, reads: b.w.reads,
    asked: b.w.envAsked, pane: (await pane.findAll({ type: 'Text' })).map(t => t.text), row: await texts(ui), drawn: JSON.stringify(await ui.drawn()),
    tool: resultOf(await callTool($, { format: 'raw' })) + resultOf(await callTool($, { format: 'formatted' })),
    envs: b.w.calls.map(c => Object.fromEntries(Object.entries(c.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY'))),
  })
  await pane.unmount()
  return all
}

test('key file: the key reaches exactly one place, the child\'s ANTHROPIC_API_KEY', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  expect(b.w.calls).toHaveLength(1)
  expect(lastCall(b).env.ANTHROPIC_API_KEY).toBe(cli.KEY)
  expect(lastCall(b).argv.some(a => a.includes(cli.KEY))).toBe(false)
  expect(lastCall(b).prompt.includes(cli.KEY)).toBe(false)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(false)
  const seen = await visible($, b, ui)
  expect(seen.includes('orch-ui-format') && seen.includes('--system-prompt')).toBe(true) // instrument: the haystack holds what it should
  expect(seen.includes(cli.KEY)).toBe(false)
  // the file was checked, then read once, by the paths of D28
  expect(b.w.stats).toEqual([KEY_PATH])
  expect(b.w.reads).toEqual([KEY_PATH])
  expect(b.w.runs.filter(a => a[0] === 'ls')).toEqual([['ls', '-ln', '--', KEY_PATH]])
  await ui.unmount()
})

test('key file: it is read again for each call, never kept', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  b.w.files.set(KEY_PATH, { text: KEY_FILE.replace('000000', '111111'), mode: '-rw-------' })
  await convertOne($, b, done.source, done.output)
  expect(b.w.calls.map(c => c.env.ANTHROPIC_API_KEY)).toEqual([cli.KEY, cli.KEY.replace('000000', '111111')])
  expect(b.w.reads).toEqual([KEY_PATH, KEY_PATH])
})

test('key source env: the session\'s key and bearer are never read, passed, or shown', async ($, on) => {
  const SESSION_KEY = 'sentinel-session-key-000000'
  const BEARER = 'sentinel-bearer-000000'
  const b = await boot($, on, { 'opt:format': true }, { HOME: '/home/u', ANTHROPIC_API_KEY: SESSION_KEY, ANTHROPIC_AUTH_TOKEN: BEARER })
  await convertOne($, b)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(false)
  expect(b.w.envAsked).not.toContain('ANTHROPIC_API_KEY')
  expect(b.w.envAsked).not.toContain('ANTHROPIC_AUTH_TOKEN')
  const c = lastCall(b)
  expect(JSON.stringify([c.env, c.argv, c.prompt]).includes(SESSION_KEY)).toBe(false)
  expect(JSON.stringify([c.env, c.argv, c.prompt]).includes(BEARER)).toBe(false)
  const all = await visible($, b, ui)
  expect(all.includes(SESSION_KEY)).toBe(false)
  expect(all.includes(BEARER)).toBe(false)
  // the only environment names read are the cloud providers, the gateway, and the home folder
  expect([...new Set(b.w.envAsked)].sort()).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX', 'HOME', 'OS'])
  await ui.unmount()
})

test('key file: an extended attribute without an ACL passes after a second ls', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------@' })
  await convertOne($, b)
  expect(claudeRuns(b)).toHaveLength(1)
  expect(b.w.runs.filter(a => a[0] === 'ls')).toEqual([['ls', '-ln', '--', KEY_PATH], ['ls', '-led', '--', KEY_PATH]])
})

test('key file: a plain mode never asks for the second ls', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  expect(claudeRuns(b)).toHaveLength(1)
  expect(b.w.runs.filter(a => a[0] === 'ls')).toEqual([['ls', '-ln', '--', KEY_PATH]])
})

const KEY_FAILS: [string, (b: Booted) => void, string][] = [
  ['a missing file', b => b.w.files.delete(KEY_PATH), 'key-file-missing'],
  ['group-readable', b => b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-r-----' }), 'key-file-unsafe'],
  ['other-readable', b => b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw----r--' }), 'key-file-unsafe'],
  ['an ACL', b => b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------+' }), 'key-file-unsafe'],
  ['an ACL behind an extended attribute', b => b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------@', acl: ['group:everyone allow read'] }), 'key-file-unsafe'],
  ['an extended attribute whose ACL check failed', b => { b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------@' }); b.w.aclExit = 1 }, 'key-file-unsafe'],
  ['a link', b => b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: 'lrwx------' }), 'key-file-unsafe'],
  ['a failed ls', b => { b.w.lsExit = 1 }, 'key-file-unsafe'],
  ['a file over 64 KiB', b => b.w.files.set(KEY_PATH, { text: KEY_FILE + ' '.repeat(65536), mode: '-rw-------' }), 'key-file-unsafe'],
  ['a key of the wrong length', b => b.w.files.set(KEY_PATH, { text: KEY_FILE.replace(cli.KEY, 'short'), mode: '-rw-------' }), 'key-file-invalid'],
  ['only the old orchPane object', b => b.w.files.set(KEY_PATH, { text: KEY_FILE.replace('orchUi', 'orchPane'), mode: '-rw-------' }), 'key-file-invalid'],
]
for (const [name, setup, reason] of KEY_FAILS) {
  test(`key file: ${name} is ${reason}, the child never runs and formatting is not paused`, async ($, on) => {
    const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
    b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
    setup(b)
    await convertOne($, b)
    expect(claudeRuns(b)).toEqual([])
    expect(await noteOf($)).toBe(`formatted 0 · as written 1 · last: ${reason} (short/opus) · api $0.00`)
    const all = JSON.stringify([b.w.logs, [...b.w.store]])
    expect(all.includes(cli.KEY)).toBe(false)
    // not paused: the next reply tries again
    await convertOne($, b, done.source, done.output)
    expect(b.w.stats.length).toBeGreaterThanOrEqual(1)
  })
}

test('key file: Windows never reads one', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' }, { OS: 'Windows_NT', USERPROFILE: 'C:\\home\\u', HOME: '/home/u' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  expect(claudeRuns(b)).toEqual([])
  expect(b.w.stats).toEqual([])
  expect(await noteOf($)).toContain('last: key-file-unsafe')
})

test('gateway: with the file key a set ANTHROPIC_BASE_URL stops the run before the key file is touched', async ($, on) => {
  const URL = 'https://user:secret-in-url@gateway.example/v1'
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' }, { HOME: '/home/u', ANTHROPIC_BASE_URL: URL })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  expect(claudeRuns(b)).toEqual([])
  expect(b.w.stats).toEqual([])
  expect(b.w.reads).toEqual([])
  expect(b.w.runs.filter(a => a[0] === 'ls')).toEqual([])
  const note = await noteOf($)
  expect(note).toBe('formatted 0 · as written 1 · last: base-url-set (short/opus) · paused: base-url-set')
  expect(JSON.stringify([note, b.w.logs, [...b.w.store]]).includes('secret-in-url')).toBe(false)
})

for (const [name, seed] of [['api + env', { 'opt:format': true }], ['subscription', { 'opt:format': true, 'opt:format-billing': 'subscription' }]] as const) {
  test(`gateway: ${name} still runs, and the note says so without showing the value`, async ($, on) => {
    const URL = 'https://user:secret-in-url@gateway.example/v1'
    const b = await boot($, on, seed, { HOME: '/home/u', ANTHROPIC_BASE_URL: URL })
    await convertOne($, b)
    expect(claudeRuns(b)).toHaveLength(1)
    const note = await noteOf($)
    expect(note).toBe(`formatted 1 · as written 0 · last: ok (short/opus) · ${name === 'subscription' ? 'plan' : 'api'} $0.01 · via ANTHROPIC_BASE_URL`)
    expect(JSON.stringify([note, b.w.logs, [...b.w.store], b.w.calls.map(c => [c.argv, c.prompt])]).includes('secret-in-url')).toBe(false)
  })
}

test('gateway: an empty ANTHROPIC_BASE_URL acts as unset', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' }, { HOME: '/home/u', ANTHROPIC_BASE_URL: '' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  await convertOne($, b)
  expect(claudeRuns(b)).toHaveLength(1)
  expect(await noteOf($)).toBe('formatted 1 · as written 0 · last: ok (short/opus) · api $0.01')
})

const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE']
for (const name of CLOUD_FLAGS) {
  test(`cloud providers: ${name} stops every run and pauses`, async ($, on) => {
    const b = await boot($, on, { 'opt:format': true }, { HOME: '/home/u', [name]: '1' })
    await convertOne($, b)
    expect(claudeRuns(b)).toEqual([])
    expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: cloud-provider (short/opus) · paused: cloud-provider')
  })
}

test('cloud providers: an empty value does not count', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true }, { HOME: '/home/u', CLAUDE_CODE_USE_BEDROCK: '' })
  await convertOne($, b)
  expect(claudeRuns(b)).toHaveLength(1)
})

test('working directory: under the home folder, never TMPDIR, TEMP or /tmp', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true }, { HOME: '/home/u', TMPDIR: '/tmp/x', TEMP: '/tmp/y' })
  await convertOne($, b)
  expect(lastCall(b).cwd).toBe('/home/u/.claude/orch-ui-format')
  expect(b.w.written).toEqual(['/home/u/.claude/orch-ui-format/.keep'])
  expect(b.w.envAsked).not.toContain('TMPDIR')
  expect(b.w.envAsked).not.toContain('TEMP')
})

test('working directory: Windows uses USERPROFILE with forward slashes', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true }, { OS: 'Windows_NT', USERPROFILE: 'C:\\home\\u' })
  await convertOne($, b)
  expect(lastCall(b).cwd).toBe('C:/home/u/.claude/orch-ui-format')
  // the kit resolves a path that is not absolute on this host against the session folder, so only its tail is the plugin's
  expect(b.w.written.map(w => w.slice(-'C:/home/u/.claude/orch-ui-format/.keep'.length))).toEqual(['C:/home/u/.claude/orch-ui-format/.keep'])
})

test('working directory: no home folder is workdir-failed, a pause, and no run', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true }, { TMPDIR: '/tmp/x' })
  await convertOne($, b)
  expect(claudeRuns(b)).toEqual([])
  expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: workdir-failed (short/opus) · api $0.00 · paused: workdir-failed')
})

const TIMEOUT_CASES: [string, Reply, string][] = [
  ['killed at the limit', { rejectAfter: LIMITS.short.low.timeoutMs }, 'timeout'],
  ['killed 250 ms early on the clock', { rejectAfter: LIMITS.short.low.timeoutMs - 250 }, 'timeout'],
  ['an early failure whose message says time', { deny: 'the time zone database could not be read' }, 'cli-failed'],
  ['an early rejection', { rejectAfter: 1000 }, 'cli-failed'],
  ['just under the slack', { rejectAfter: LIMITS.short.low.timeoutMs - 251 }, 'cli-failed'],
  ['a missing program', { deny: 'spawn claude ENOENT' }, 'cli-missing'],
  ['a missing program, said otherwise', { deny: 'claude: command not found' }, 'cli-missing'],
]
for (const [name, reply, reason] of TIMEOUT_CASES) {
  test(`timeouts are told by elapsed time, not by the message: ${name} is ${reason}`, async ($, on) => {
    const b = await boot($, on)
    b.w.replies.set(options.source, reply)
    await orchestrate($)
    await finish($, b, options.source)
    expect((await noteOf($))?.includes(`last: ${reason} (`)).toBe(true)
  })
}

test('a truncated stdout is cli-output', async ($, on) => {
  const b = await boot($, on)
  b.w.truncated = true
  await convertOne($, b)
  expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: cli-output (short/opus) · api $0.00')
})

// -- pause ---------------------------------------------------------------------------------------------

for (const [name, source] of [['a key source', 'ANTHROPIC_API_KEY'], ['an unreadable key source', 5]] as const) {
  test(`a billing mismatch under subscription billing is api spend when the run reports ${name}`, async ($, on) => {
    const b = await boot($, on, { 'opt:format': true, 'opt:format-billing': 'subscription' })
    b.w.replies.set(options.source, { stdout: cli.stream({ ...cli.init('none'), apiKeySource: source }, cli.resultOk(options.output, { total_cost_usd: 0.0061 })) })
    await orchestrate($)
    await finish($, b, options.source)
    expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: billing-mismatch (short/opus) · api $0.01 · paused: billing-mismatch')
  })
}

test('a billing mismatch pauses formatting for the session; /clear lifts it', async ($, on) => {
  const b = await boot($, on)
  // An api run whose init says "none": a key-less run that fell back to something else. No key paid, so the spend is plan use.
  b.w.replies.set(options.source, { stdout: cli.stream(cli.init('none'), cli.resultOk(options.output, { total_cost_usd: 0.0061 })) })
  await orchestrate($)
  await finish($, b, options.source)
  expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: billing-mismatch (short/opus) · plan $0.01 · paused: billing-mismatch')
  b.w.replies.set(done.source, done.output)
  await finish($, b, done.source)
  await finish($, b, done.source)
  expect(b.w.calls).toHaveLength(1)
  const ui = await show($, done.source)
  expect(await isOriginal(ui)).toBe(true)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await orchestrate($)
  await finish($, b, done.source)
  expect(b.w.calls).toHaveLength(2)
  expect(await isOriginal(ui)).toBe(false)
  expect(await noteOf($)).toBe('formatted 1 · as written 0 · last: ok (short/opus) · api $0.01')
  await ui.unmount()
})

const PAUSE_CASES: [string, Reply, string, boolean][] = [
  ['auth failure', { stdout: cli.stream(cli.init('ANTHROPIC_API_KEY'), cli.resultApiError(401)) }, 'auth-failed', true],
  // `--bare` with no key: the CLI reports no key source (init 'none') and a "Not logged in" error, so the billing proof fails first
  ['no key under API billing', { stdout: cli.stream(cli.init('none'), cli.resultNoCredential()) }, 'billing-mismatch', true],
  ['a model that is not the one asked', { stdout: cli.stream(cli.init('ANTHROPIC_API_KEY'), cli.resultOk(options.output, { modelUsage: { 'claude-sonnet-5-5': {} } })) }, 'model-mismatch', true],
  ['a missing program', { deny: 'spawn claude ENOENT' }, 'cli-missing', true],
  ['a rate limit', { stdout: cli.stream(cli.init('ANTHROPIC_API_KEY'), cli.resultApiError(429)) }, 'rate-limited', false],
  ['an overload', { stdout: cli.stream(cli.init('ANTHROPIC_API_KEY'), cli.resultApiError(529)) }, 'overloaded', false],
  ['two result lines', { stdout: cli.stream(cli.init('ANTHROPIC_API_KEY'), cli.resultOk('a'), cli.resultOk('b')) }, 'cli-output', false],
]
for (const [name, reply, reason, pauses] of PAUSE_CASES) {
  test(`${name} (${reason}) ${pauses ? 'pauses formatting' : 'does not pause formatting'}`, async ($, on) => {
    const b = await boot($, on)
    b.w.replies.set(options.source, reply)
    await orchestrate($)
    await finish($, b, options.source)
    const note = await noteOf($)
    expect(note?.includes(`last: ${reason} (`)).toBe(true)
    expect(note?.includes(`paused: ${reason}`)).toBe(pauses)
    await finish($, b, done.source)
    expect(b.w.calls.length).toBe(pauses ? 1 : 2)
  })
}

test('a normal session never starts the child, even when the option is on', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-key': 'file' })
  b.w.files.set(KEY_PATH, { text: KEY_FILE, mode: '-rw-------' })
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(long.source, long.output)
  await finish($, b, options.source)
  await finish($, b, long.source)
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await finish($, b, options.source)
  expect(claudeRuns(b)).toEqual([])
  expect(b.w.runs.filter(a => a[0] === 'ls')).toEqual([])
  expect(b.w.stats).toEqual([])
  expect(b.w.written).toEqual([])
})

// -- trigger, marker, on request ---------------------------------------------------------------------------

const marked = (text: string) => `${text}\n\n${MARK}`
// `trigger` unset: an empty store (the default is marked); the other tests run in auto.
const MARKED_MODE = { 'opt:format': true, 'opt:format-trigger': undefined }
const rowsOf = (b: Booted) => b.w.engineRows

test('the default trigger with an empty store is marked: a marked reply converts from its stripped text, an unmarked one does not', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  await finish($, b, done.source)
  expect(b.w.calls).toEqual([])
  await finish($, b, marked(options.source))
  expect(b.w.calls).toHaveLength(1)
  expect(b.w.calls[0]!.prompt).toBe(options.source)
  // the row of the marked reply (marker and all) is drawn in the format; the unmarked one is not
  const ui = await show($, marked(options.source))
  expect(await isOriginal(ui)).toBe(false)
  const other = await show($, done.source)
  expect(await isOriginal(other)).toBe(true)
  await ui.unmount()
  await other.unmount()
})

test('auto converts every eligible reply, marked or not, and the marker never reaches the model', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-trigger': 'auto' })
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  await finish($, b, done.source)
  await finish($, b, marked(options.source))
  expect(b.w.calls.map(c => c.prompt)).toEqual([done.source, options.source])
  expect(b.w.calls.some(c => c.prompt.includes('orch-ui -->'))).toBe(false)
})

test('a marked and an unmarked copy of one reply share a key: one call', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, marked(options.source))
  await finish($, b, marked(options.source))
  expect(b.w.calls).toHaveLength(1)
})

test('a marker on an ineligible reply starts nothing and is not the latest', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await finish($, b, marked('Short.'))
  await finish($, b, marked(options.source + '\n```\ncode\n```'))
  await finish($, b, marked(options.source), { agentId: 'sub-1' })
  expect(b.w.calls).toEqual([])
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('no reply to format')
  expect(b.w.calls).toEqual([])
})

test('the row note counts marked replies and requests in marked mode', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  const pane = await settingsPane($)
  expect((await optionRow(pane)).note).toBeUndefined()
  await finish($, b, marked(options.source))
  expect((await optionRow(pane)).note).toBe('formatted 1 · as written 0 · marked 1 of 1 · asked 0 · last: ok (short/opus) · api $0.01')
  await finish($, b, done.source)
  expect((await optionRow(pane)).note).toBe('formatted 1 · as written 0 · marked 1 of 2 · asked 0 · last: ok (short/opus) · api $0.01')
  await callTool($, { format: 'formatted' })
  await b.clock.settle()
  expect((await optionRow(pane)).note).toBe('formatted 2 · as written 0 · marked 1 of 2 · asked 1 · last: ok (short/opus) · api $0.01')
  await pane.unmount()
})

test('in auto the note does not count marks', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, marked(options.source))
  expect(await noteOf($)).toBe('formatted 1 · as written 0 · last: ok (short/opus) · api $0.01')
})

// -- the marker on screen ------------------------------------------------------------------------------------

test('a marked row is drawn without its marker line when it is not converted: option off, marked mode unmarked, other surfaces, summaries', async ($, on) => {
  const b = await boot($, on, {})
  const text = `${done.source}\n\n${MARK}\n`
  const ui = await show($, text)
  expect(rowsOf(b)).toEqual([done.source])
  await ui.unmount()
  // an orchestrator session with the option off
  await orchestrate($)
  const again = await show($, text)
  expect(rowsOf(b)).toEqual([done.source, done.source])
  await again.unmount()
  // a summary and a desktop row lose it too
  const summary = await show($, text, { isSummary: true })
  const desktop = await $.ui.mount({ plugin: 'orch-ui', surface: 'desktop', component: 'AssistantMessage', requestId: 'd9', props: { text, isFirstOfReply: true } })
  expect(rowsOf(b).slice(2)).toEqual([done.source, done.source])
  await summary.unmount()
  await desktop.unmount()
})

test('a normal session: only the marker line goes, a marker elsewhere and every other row pass untouched', async ($, on) => {
  const b = await boot($, on)
  const rows = [
    `Plain reply.\n\n${MARK}`,
    `Plain reply.\n${MARK}\nmore text`,
    `${MARK}\nPlain reply.`,
    `Plain ${MARK}`,
    'A reply with no marker at all.',
    'Streaming reply\n<!-- or',
  ]
  for (const text of rows) {
    const ui = await show($, text)
    await ui.unmount()
  }
  expect(rowsOf(b)).toEqual(['Plain reply.', rows[1], rows[2], rows[3], rows[4], rows[5]])
  expect(b.w.calls).toEqual([])
  expect(formatTools(b.w)).toEqual([])
})

test('a half-written marker is hidden while an orchestrator reply streams, and not in a normal session', async ($, on) => {
  const b = await boot($, on)
  const normal = await show($, 'Streaming reply\n\n<!-- orch-')
  await normal.unmount()
  expect(rowsOf(b)).toEqual(['Streaming reply\n\n<!-- orch-'])
  await orchestrate($)
  const ui = await show($, 'Streaming reply\n\n<!-- orch-')
  await ui.unmount()
  const short = await show($, 'Streaming reply\n<!-')
  await short.unmount()
  expect(rowsOf(b).slice(1)).toEqual(['Streaming reply', 'Streaming reply\n<!-'])
})

// -- format that ---------------------------------------------------------------------------------------------

const FORMATTED_AGAIN = 'Formatted again'

test('"formatted" converts the latest reply that was left as written, once', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  expect(b.w.calls).toEqual([])
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(true)
  const r = resultOf(await callTool($, { format: 'formatted' }))
  expect(r).toContain(FORMATTED_AGAIN)
  expect(r).toContain('Latest reply: formatting the latest reply now.')
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(1)
  expect(await isOriginal(ui)).toBe(false)
  // done: nothing more
  expect(resultOf(await callTool($, { format: 'formatted', scope: 'session' }))).toContain('Latest reply: already formatted.')
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(1)
  await ui.unmount()
})

test('"formatted" is a conversion like any other: no second call while it runs, and one claim per text', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 5000)
  await orchestrate($)
  await finish($, b, options.source)
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('formatting the latest reply now')
  await b.clock.settle()
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('it is being formatted already')
  await b.clock.advance(5000)
  expect(b.w.calls).toHaveLength(1)
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('already formatted')
})

test('"formatted" gives a reply that ended as written one more try, then says so', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, 'Not in the format at all.')
  await orchestrate($)
  await finish($, b, options.source)
  expect(b.w.calls).toHaveLength(1)
  expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: no-banner (short/opus) · api $0.01')
  // the retry fails again: still one reply written as written, not two
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('formatting the latest reply now')
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(2)
  expect(await noteOf($)).toBe('formatted 0 · as written 1 · last: no-banner (short/opus) · api $0.01')
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('tried once more already and stays as written')
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(2)
})

test('"formatted" after a failure that clears: the retry draws the reply and the count moves from written to formatted', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, 'Not in the format at all.')
  await orchestrate($)
  await finish($, b, options.source)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(true)
  b.w.replies.set(options.source, options.output)
  await callTool($, { format: 'formatted' })
  await b.clock.settle()
  expect(await isOriginal(ui)).toBe(false)
  expect(await noteOf($)).toBe('formatted 1 · as written 0 · last: ok (short/opus) · api $0.01')
  await ui.unmount()
})

test('"formatted" takes the newest reply by turn.complete order, and an ineligible one is not a reply to format', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  await finish($, b, options.source)
  await finish($, b, done.source)
  await finish($, b, 'Short.')
  await callTool($, { format: 'formatted' })
  await b.clock.settle()
  expect(b.w.calls.map(c => c.prompt)).toEqual([done.source])
  // an older one cannot be asked for
  const old = await show($, options.source)
  expect(await isOriginal(old)).toBe(true)
  await old.unmount()
})

test('"formatted" says why and makes no call when formatting is off or paused, or there is nothing to format', async ($, on) => {
  const off = await boot($, on, { 'opt:format': false })
  await orchestrate($)
  await finish($, off, options.source)
  expect(resultOf(await callTool($, { format: 'formatted' }))).toBe("Formatting is off in orch-ui's settings (/orch-ui); nothing changed.")
  expect(off.w.calls).toEqual([])
})

test('"formatted" while paused makes no call', async ($, on) => {
  const b = await boot($, on, MARKED_MODE, { HOME: '/home/u', CLAUDE_CODE_USE_BEDROCK: '1' })
  await orchestrate($)
  await finish($, b, marked(options.source))
  expect(await noteOf($)).toContain('paused: cloud-provider')
  const r = resultOf(await callTool($, { format: 'formatted' }))
  expect(r).toContain('Latest reply: paused: cloud-provider.')
  await b.clock.settle()
  expect(b.w.runs.filter(a => a[0] === 'claude')).toEqual([])
})

test('"formatted" with no reply yet, and in a session that never loaded the skill', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  expect(formatTools(b.w)).toEqual([])
  await orchestrate($)
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('Latest reply: no reply to format.')
})

test('"formatted" in auto converts the latest reply that was sent during a session-wide raw', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await callTool($, { format: 'raw', scope: 'session' })
  await finish($, b, options.source)
  expect(b.w.calls).toEqual([])
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('formatting the latest reply now')
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(1)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(false)
  await ui.unmount()
})

test('/clear forgets the latest reply', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await finish($, b, options.source)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await orchestrate($)
  expect(resultOf(await callTool($, { format: 'formatted' }))).toContain('no reply to format')
})

test('the raw tool\'s description names "format that" and forbids writing the reply again', async ($, on) => {
  const b = await boot($, on)
  await orchestrate($)
  expect(b.w.descriptions.some(d => d.includes('"format that"') && d.includes('never write the reply again'))).toBe(true)
})
