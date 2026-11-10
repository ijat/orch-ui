import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { FORMAT_SYSTEM, KINDS, LIMITS, MARK, TAG_EDGE, TAG_ONE, TAG_ZERO, stripTag, tagOf, untag } from '../hooks/format'
import { FMT_MAX_BYTES, FMT_MAX_ENTRIES, FORMAT_TOOL, FORMAT_TOOL_FULL, FRAMES, PILL_LEFT, PILL_RIGHT } from '../hooks/format-view'
import * as cli from './fixtures/format/cli'
import * as done from './fixtures/format/done'
import * as long from './fixtures/format/long'
import * as options from './fixtures/format/options'
import * as review from './fixtures/format/review'
import { textKey } from '../hooks/lib'

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
  // how many fake child runs are moving the clock to their end right now (see boot)
  advancing: number
  // how many periods the animation timer was asked for (one clock.every dispatch each)
  periods: number
  // the text the engine itself was asked to draw (a row no hook redrew)
  engineRows: string[]
  // the description of each tool registered
  descriptions: string[]
  // every store call as `op:key` (keys has none), and a switch that makes the writes under `fmt:` fail
  storeOps: string[]; denyFmtWrites: boolean; denyFmtReads: boolean
  // the stream hook's neighbours: a state read held until a gate opens, and a delay of the final flush beneath the plugin
  gate: { key: string; until: Promise<void> } | null; finalDelay: number
}

const CLAUDE_BIN = 'claude'
const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? ''

// The engine beneath the plugin: just enough for session.start, the child process, the files, the store and the tool registry.
async function boot($: Engine, on: On, seed: Record<string, unknown> = { 'opt:format': true }, envVars: Record<string, string> = { HOME: '/home/u' }) {
  const periodsSeen = { n: 0 }
  on('clock.every', { ms: 100 }, async (_, e, next) => {
    periodsSeen.n += 1
    return next(e)
  })
  const mc = mock.clock(on, { now: Date.parse('2026-11-10T10:00Z') })
  const w: World = {
    calls: [], tools: [], commands: [], opened: [], store: new Map(Object.entries({ 'opt:format-trigger': 'auto', ...seed })), replies: new Map(), delays: new Map(),
    env: { ...envVars }, envAsked: [], files: new Map(), stats: [], reads: [], written: [], runs: [], logs: [], cost: 0.0061, lsExit: 0, aclExit: 0, truncated: false, advancing: 0, periods: 0, engineRows: [], descriptions: [], storeOps: [], denyFmtWrites: false, denyFmtReads: false, gate: null, finalDelay: 0,
  }
  // A fake run that lasts N ms moves the clock N ms from inside its hook. The animation timer ticks every 100 ms on the
  // way, and the mock clock resolves them one at a time as the test's own calls come, so settle and advance go on until such a run is over.
  // Moves the clock exactly `ms` on. With the animation timer running, advance stops at its last tick, not at the end; a
  // wait due at the end makes it stop there.
  const moveBy = async (ms: number) => {
    const wake = mc.sleep(ms)
    await mc.advance(ms)
    await wake
  }
  const drain = async () => {
    for (let i = 0; i < 5000 && w.advancing > 0; i++) await mc.settle()
  }
  Object.defineProperty(w, 'periods', { get: () => periodsSeen.n })
  const clock: MockClock = {
    ...mc,
    settle: async () => {
      await mc.settle()
      await drain()
    },
    advance: async ms => {
      await mc.advance(ms)
      await drain()
    },
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
      w.advancing++
      try {
        await moveBy(r.rejectAfter)
      } finally {
        w.advancing--
      }
      return { deny: 'killed' }
    }
    if ('stdout' in r) return { value: { exitCode: 0, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if ('tokens' in r) return ran(cli.resultOk(r.text, { ...used, usage: { input_tokens: 1, output_tokens: r.tokens } }))
    if (r.reason === 'api-error') return ran(cli.resultApiError(500, used))
    if (r.reason === 'aborted') {
      // The run reaches its time limit: the clock shows it, and the call rejects.
      w.advancing++
      try {
        await moveBy(e.init?.timeoutMs ?? 0)
      } finally {
        w.advancing--
      }
      return { deny: 'timed out' }
    }
    return ran(cli.resultOk('', used))
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // nothing beneath the plugin answers a flush; a delay here is a hook of the settings that takes its time
  on('classic.MessageDisplay', async (_, e) => {
    if (w.finalDelay > 0 && e.final) await clock.sleep(w.finalDelay)
    return {}
  })
  on('state.get', async (_, e, next) => {
    if (w.gate && w.gate.key === e.key) await w.gate.until
    return next(e)
  })
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
    w.descriptions.push(e.description)
    return { value: { tool: `mcp__orch-ui__${e.name}` } }
  })
  on('store.get', (_, e) => {
    w.storeOps.push(`get:${e.key}`)
    if (w.denyFmtReads && e.key.startsWith('fmt:')) return { deny: 'store is unreadable' }
    return { value: w.store.get(e.key) }
  })
  on('store.set', (_, e) => {
    w.storeOps.push(`set:${e.key}`)
    if (w.denyFmtWrites && e.key.startsWith('fmt:')) return { deny: 'store is full' }
    // the store holds JSON: what is read back is a copy
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.storeOps.push(`delete:${e.key}`)
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => {
    w.storeOps.push('keys')
    return { value: [...w.store.keys()] }
  })
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

test('pills keep their Nerd Font round caps and the kinds keep their icons', () => {
  expect(PILL_LEFT).toBe('\ue0b6')
  expect(PILL_RIGHT).toBe('\ue0b4')
  const icons: Record<string, string> = { branch: '\ue725', file: '\uf15b', commit: '\uf417', reply: '\uf112' }
  for (const [name, icon] of Object.entries(icons)) expect(KINDS[name as keyof typeof KINDS].icon).toBe(icon)
})

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
  // No longer an orchestrator session: nothing new is converted. A finished page still draws (it is a saved page; D7).
  expect(await isOriginal(first)).toBe(false)
  expect(await isOriginal(second)).toBe(false)
  b.w.replies.set(review.source, review.output)
  await finish($, b, review.source)
  expect(b.w.calls).toHaveLength(2)
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
  const card = n.find(x => x.node.props?.borderStyle === 'round' && x.node.props?.borderColor !== 'inactive')?.node as Node
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

test('drawing: the whole reply sits on one rounded page with comfortable padding', async ($, on) => {
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, review.source, review.output)
  const pages = nodes.filter(x => x.node.type === 'Box' && x.node.props?.borderStyle === 'round' && x.node.props?.borderColor === 'inactive')
  expect(pages).toHaveLength(1)
  expect(pages[0]?.node.props).toMatchObject({ flexDirection: 'column', paddingX: 2, paddingY: 1 })
  // The card is drawn inside the page.
  const inside = walk(pages[0]?.node as Node).filter(x => x.node.type === 'Box' && x.node.props?.borderStyle === 'round' && x.node.props?.borderColor !== 'inactive')
  expect(inside).toHaveLength(1)
  await ui.unmount()
})

test('drawing: the card is a round border without a background, colored by its worst row, with a plain title', async ($, on) => {
  const b = await boot($, on)
  const { ui, nodes } = await tree($, b, review.source, review.output)
  const cards = nodes.filter(x => x.node.type === 'Box' && x.node.props?.borderStyle === 'round' && x.node.props?.borderColor !== 'inactive')
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
  const only = second.nodes.find(x => x.node.props?.borderStyle === 'round' && x.node.props?.borderColor !== 'inactive')?.node
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

test('a normal session: only the marker line goes (first or last line), a marker elsewhere and every other row pass untouched', async ($, on) => {
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
  expect(rowsOf(b)).toEqual(['Plain reply.', rows[1], 'Plain reply.', rows[3], rows[4], rows[5]])
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

// -- the first-line marker and the placeholder -------------------------------------------------------------------
// A marked reply is drawn as a one-line rounded page with a spinner from its first streamed characters until the
// formatted page is ready; a failure or a pause draws the text as written with one dim reason line.

const first = (text: string) => `${MARK}\n\n${text}`
const spin = (n: number, secs: number) => `${FRAMES[n % FRAMES.length]} formatting reply · ${secs}s`
const REASON = (why: string) => `orch-ui: shown as written (${why})`
let turnSeq = 0
async function startTurn($: Engine, b: Booted, extra: Record<string, unknown> = {}) {
  turnSeq += 1
  await $.turn.start({ text: 'go', turnId: `u${turnSeq}`, ...extra } as never)
  await b.clock.settle()
}
async function endTurn($: Engine, b: Booted, reason: string) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: `u${turnSeq}`, reason } as never)
  await b.clock.settle()
}
// Moves the clock on and returns how many periods of the animation timer that took.
async function quiet(b: Booted, ms = 1000) {
  const before = b.w.periods
  await b.clock.advance(ms)
  return b.w.periods - before
}

test('a reply that starts with the marker converts from the text after it; one that ends with it still does, and both strip', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  await finish($, b, first(options.source))
  await finish($, b, marked(done.source))
  expect(b.w.calls.map(c => c.prompt)).toEqual([options.source, done.source])
  for (const text of [first(options.source), marked(done.source), first(done.source)]) {
    const ui = await show($, text)
    expect(await isOriginal(ui)).toBe(false)
    await ui.unmount()
  }
  // the same reply with the marker on either end is one key
  expect(b.w.calls).toHaveLength(2)
})

const STREAMING: [string, string][] = [
  ['the first character of the marker', '<'],
  ['a start of the marker', '<!-- orch'],
  ['the whole marker', MARK],
  ['the marker and a newline', `${MARK}\n`],
  ['the marker and the start of the text', `${MARK}\n\nThe migration needs`],
]
for (const [name, text] of STREAMING) {
  test(`while a marked reply streams in, ${name} is drawn as the placeholder and the text never shows`, async ($, on) => {
    const b = await boot($, on, MARKED_MODE)
    await orchestrate($)
    await startTurn($, b)
    const ui = await show($, text)
    expect(await isOriginal(ui)).toBe(false)
    expect(await texts(ui)).toEqual([spin(0, 0)])
    expect(rowsOf(b)).toEqual([])
    await ui.unmount()
  })
}

test('the placeholder is the same rounded page as the formatted reply, with the spinner line inside', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await startTurn($, b)
  const stream = await show($, MARK)
  const root = (await stream.drawn()) as Node
  expect(root.props).toMatchObject({ borderStyle: 'round', borderColor: 'inactive', paddingX: 2, paddingY: 1, flexDirection: 'column' })
  await stream.unmount()
  const page = await tree($, b, options.source, options.output)
  const formatted = page.nodes.find(x => x.node.type === 'Box' && x.node.props?.borderStyle === 'round' && x.node.props?.borderColor === 'inactive')!.node
  await page.ui.unmount()
  for (const k of ['borderStyle', 'borderColor', 'paddingX', 'paddingY', 'flexDirection']) expect([k, root.props?.[k]]).toEqual([k, formatted.props?.[k]])
})

test('a pending conversion is the placeholder: frames every 100 ms, whole seconds since it started, then the formatted page', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 2600)
  await orchestrate($)
  await finish($, b, first(options.source))
  const ui = await show($, first(options.source))
  expect(await texts(ui)).toEqual([spin(0, 0)])
  for (const [ms, frame, secs] of [[100, 1, 0], [100, 2, 0], [100, 3, 0], [700, 10, 1], [1000, 20, 2]] as const) {
    await b.clock.advance(ms)
    expect([ms, await texts(ui)]).toEqual([ms, [spin(frame, secs)]])
  }
  expect(rowsOf(b)).toEqual([])
  await b.clock.advance(1000)
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui)).some(t => t.includes('formatting reply'))).toBe(false)
  expect((await texts(ui)).join('\n')).toContain('Choose how to run the schema migration')
  await ui.unmount()
})

test('the streaming placeholder counts its seconds from the start of the turn, and the pending one goes on from there (no restart at the claim)', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 5000)
  await orchestrate($)
  await startTurn($, b)
  const ui = await show($, MARK)
  await b.clock.advance(2000)
  expect(await texts(ui)).toEqual([spin(20, 2)])
  await finish($, b, first(options.source))
  const row = await show($, first(options.source))
  expect(await texts(row)).toEqual([spin(20, 2)])
  await b.clock.advance(1000)
  expect(await texts(row)).toEqual([spin(30, 3)])
  await ui.unmount()
  await row.unmount()
})

test('the row goes from the streaming placeholder to the pending one with no plain text between', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 5000)
  await orchestrate($)
  await startTurn($, b)
  const ui = await show($, first(options.source))
  expect(await texts(ui)).toEqual([spin(0, 0)])
  // the turn ends and the hook returns before the timer that starts the call has run
  await $.turn.complete({ answer: first(options.source), durationMs: 1, isAborted: false, turnId: `u${turnSeq}`, reason: 'answer' } as never)
  expect(b.w.calls).toEqual([])
  expect(await texts(ui)).toEqual([spin(0, 0)])
  expect(rowsOf(b)).toEqual([])
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(1)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await ui.unmount()
})

test('the timer exists only while a conversion is pending or a turn runs: none remains after the conversion and the turn end', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 2000)
  await orchestrate($)
  expect(await quiet(b)).toBe(0)
  await startTurn($, b)
  expect(await quiet(b)).toBeGreaterThan(0)
  await finish($, b, first(options.source))
  expect(await quiet(b, 500)).toBeGreaterThan(0)
  // the call ends at 2000 ms; after it nothing runs
  await b.clock.advance(1600)
  expect(b.w.calls).toHaveLength(1)
  expect(await quiet(b)).toBe(0)
  expect(await quiet(b, 5000)).toBe(0)
  // and a new turn starts one again
  await startTurn($, b)
  expect(await quiet(b)).toBeGreaterThan(0)
  await endTurn($, b, 'aborted')
  expect(await quiet(b, 3000)).toBe(0)
})

for (const reason of ['aborted', 'error', 'refusal']) {
  test(`a turn that ends with ${reason} ends the turn: the timer stops and the streaming row is as written`, async ($, on) => {
    const b = await boot($, on, MARKED_MODE)
      await orchestrate($)
    await startTurn($, b)
    const ui = await show($, first(options.source))
    expect(await texts(ui)).toEqual([spin(0, 0)])
    await endTurn($, b, reason)
    expect(await quiet(b, 2000)).toBeLessThan(2)
    expect(await quiet(b, 2000)).toBe(0)
    expect(rowsOf(b)).toEqual([options.source])
    await ui.unmount()
  })
}

test('one timer serves several pending conversions; it stops when the last one ends', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  b.w.delays.set(options.source, 1000)
  b.w.delays.set(done.source, 3000)
  await orchestrate($)
  await finish($, b, first(options.source))
  await finish($, b, first(done.source))
  const one = await quiet(b, 500)
  const ui = await show($, first(done.source))
  await b.clock.advance(1000)
  expect(b.w.calls).toHaveLength(2)
  // 1500 ms in: the first ended, the second still runs
  expect(await texts(ui)).toEqual([spin(15, 1)])
  expect(one).toBeGreaterThan(0)
  expect(await quiet(b, 500)).toBeGreaterThan(0)
  await b.clock.advance(1100)
  expect(await isOriginal(ui)).toBe(false)
  expect(await quiet(b, 3000)).toBe(0)
  await ui.unmount()
})

test('/clear stops the timer, and a conversion that ends afterwards does not start it again', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 3000)
  await orchestrate($)
  await startTurn($, b)
  await finish($, b, first(options.source))
  expect(await quiet(b, 500)).toBeGreaterThan(0)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(await quiet(b, 100)).toBeLessThan(2)
  expect(await quiet(b, 4000)).toBe(0)
})

test('a marked reply that failed is the original text without the marker plus one dim reason line', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, { reason: 'api-error' })
  await orchestrate($)
  await finish($, b, first(options.source))
  const ui = await show($, first(options.source))
  expect(rowsOf(b)).toEqual([options.source])
  expect(await texts(ui)).toEqual([REASON('api-error')])
  const dim = (await ui.findAll({ type: 'Text' })).find(t => t.text === REASON('api-error'))
  expect(dim).toBeDefined()
  expect(((await ui.drawn()) as Node).type).not.toBe('engine')
  await ui.unmount()
  // the old place of the marker ends the same way
  const last = await show($, marked(options.source))
  expect(await texts(last)).toEqual([REASON('api-error')])
  expect(rowsOf(b)).toEqual([options.source, options.source])
  await last.unmount()
})

test('a marked reply that was paused shows the pause as the reason', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, 'opt:format-trigger': undefined })
  b.w.replies.set(options.source, { stdout: cli.stream(cli.init('none'), cli.resultOk(options.output, { total_cost_usd: 0.0061 })) })
  await orchestrate($)
  await finish($, b, first(options.source))
  expect(await noteOf($)).toContain('paused: billing-mismatch')
  // a later marked reply is not asked for; it shows the pause at once, even while it streams
  await startTurn($, b)
  const ui = await show($, first(done.source))
  expect(rowsOf(b)).toEqual([done.source])
  expect(await texts(ui)).toEqual([REASON('paused: billing-mismatch')])
  const streaming = await show($, MARK)
  expect(await texts(streaming)).toEqual([REASON('paused: billing-mismatch')])
  await ui.unmount()
  await streaming.unmount()
})

test('a raw reply is the original text with no reason line, streaming or not', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await callTool($, { format: 'raw', scope: 'session' })
  await finish($, b, first(options.source))
  await startTurn($, b)
  const ui = await show($, first(options.source))
  expect(await isOriginal(ui)).toBe(true)
  expect(rowsOf(b)).toEqual([options.source])
  const streaming = await show($, MARK)
  expect(await isOriginal(streaming)).toBe(true)
  await ui.unmount()
  await streaming.unmount()
})

test('with the option off a marked row is the original text with no reason line', async ($, on) => {
  const b = await boot($, on, {})
  await orchestrate($)
  await startTurn($, b)
  const row = await show($, first(options.source))
  expect(await isOriginal(row)).toBe(true)
  expect(rowsOf(b).at(-1)).toBe(options.source)
  await row.unmount()
})

test('"format that" on a marked reply that ended as written draws the placeholder again, then the page', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, { reason: 'api-error' })
  b.w.delays.set(options.source, 1500)
  await orchestrate($)
  await finish($, b, first(options.source))
  await b.clock.advance(1500)
  const ui = await show($, first(options.source))
  expect(await texts(ui)).toEqual([REASON('api-error')])
  b.w.replies.set(options.source, options.output)
  await callTool($, { format: 'formatted' })
  await b.clock.settle()
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await b.clock.advance(2000)
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui)).some(t => t.includes('formatting reply') || t.includes('shown as written'))).toBe(false)
  await ui.unmount()
})

test('a marked reply with no entry that is not streaming is as written: an old one never spins in a later turn', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  // drawn before any turn (a resumed transcript): as written
  const old = await show($, first(options.source))
  expect(await isOriginal(old)).toBe(true)
  expect(rowsOf(b)).toEqual([options.source])
  await startTurn($, b)
  expect(await isOriginal(old)).toBe(true)
  // a row that begins in this turn spins
  const live = await show($, first(done.source))
  expect(await texts(live)).toEqual([spin(0, 0)])
  // the turn ends with no answer; the row is as written, and in the next turn it does not spin again
  await endTurn($, b, 'aborted')
  expect(await isOriginal(live)).toBe(true)
  await startTurn($, b)
  expect(await isOriginal(live)).toBe(true)
  expect(await isOriginal(old)).toBe(true)
  const fresh = await show($, MARK)
  expect(await texts(fresh)).toEqual([spin(0, 0)])
  await old.unmount()
  await live.unmount()
  await fresh.unmount()
})

test('a marked reply that was ineligible for the model (short) spins only while it streams', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await startTurn($, b)
  const ui = await show($, first('Done.'))
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await finish($, b, first('Done.'))
  expect(b.w.calls).toEqual([])
  expect(await isOriginal(ui)).toBe(true)
  expect(rowsOf(b)).toEqual(['Done.'])
  expect(await quiet(b, 2000)).toBe(0)
  await ui.unmount()
})

test('unchanged: unmarked replies, normal sessions, subagent turns, summaries and other surfaces draw as before', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  // a normal session: the skill never loaded, a turn runs, a marked row is the text without its marker and nothing animates
  await startTurn($, b)
  const normal = await show($, first(options.source))
  expect(await isOriginal(normal)).toBe(true)
  const partial = await show($, '<!-- orch')
  expect(await isOriginal(partial)).toBe(true)
  await endTurn($, b, 'aborted')
  expect(await quiet(b, 1000)).toBe(0)
  expect(rowsOf(b)).toEqual([options.source, '<!-- orch'])
  await orchestrate($)
  // a subagent's turn is not the main turn
  await startTurn($, b, { agentId: 'sub-1' })
  const sub = await show($, first(done.source))
  expect(await isOriginal(sub)).toBe(true)
  expect(await quiet(b, 1000)).toBe(0)
  // an unmarked reply streams as written
  await startTurn($, b)
  const plain = await show($, options.source.slice(0, 50))
  expect(await isOriginal(plain)).toBe(true)
  // a summary and a desktop row never get the placeholder
  const summary = await show($, first(options.source), { isSummary: true })
  expect(await isOriginal(summary)).toBe(true)
  const desktop = await $.ui.mount({ plugin: 'orch-ui', surface: 'desktop', component: 'AssistantMessage', requestId: 'd7', props: { text: first(options.source), isFirstOfReply: true } })
  expect(rowsOf(b).slice(-2)).toEqual([options.source, options.source])
  for (const ui of [normal, partial, sub, plain, summary, desktop]) await ui.unmount()
})

test('with the option off or switched off, a turn runs no timer and marked rows are as written', async ($, on) => {
  const b = await boot($, on, {})
  await orchestrate($)
  await startTurn($, b)
  expect(await quiet(b, 1000)).toBe(0)
  const ui = await show($, MARK)
  expect(await isOriginal(ui)).toBe(true)
  await ui.unmount()
})

// -- the saved outcomes: persisted `done` pages, drawn again on resume ----------------------------------------------

const saved = (source: string) => `fmt:${textKey(source.trim())}`
const SEEDED = (title: string) => ({ v: 1, state: 'done', kind: 'short', parts: [{ kind: 'banner', tag: 'info', title }] })
const fmtKeys = (b: Booted) => [...b.w.store.keys()].filter(k => k.startsWith('fmt:'))
const indexOf = (b: Booted) => (b.w.store.get('fmt:index') as { v: number; items: { k: string; n: number }[] } | undefined)
const tk = (n: number) => `p1-${n.toString(16).padStart(14, '0')}`
// A store seeded with `count` valid pages, oldest first, and the index that lists them. Each page has `pad` characters of body.
function seedPages(count: number, pad = 0, from = 0) {
  const seed: Record<string, unknown> = {}
  const items: { k: string; n: number }[] = []
  for (let i = from; i < from + count; i++) {
    const value = { v: 1, state: 'done', kind: 'short', parts: [{ kind: 'plain', body: `page ${i}${'x'.repeat(pad)}` }] }
    seed[`fmt:${tk(i)}`] = value
    items.push({ k: tk(i), n: JSON.stringify(value).length })
  }
  seed['fmt:index'] = { v: 1, items }
  return seed
}

test('a done conversion is saved under fmt:<key> and listed in fmt:index; a failed one is not', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  expect(fmtKeys(b).sort()).toEqual([saved(options.source), 'fmt:index'].sort())
  const value = b.w.store.get(saved(options.source)) as { v: number; state: string; kind: string; parts: unknown[] }
  expect(value).toMatchObject({ v: 1, state: 'done', kind: 'short' })
  expect(value.parts.length).toBeGreaterThan(0)
  expect(indexOf(b)).toEqual({ v: 1, items: [{ k: textKey(options.source.trim()), n: JSON.stringify(value).length }] })
  // a reply the model does not rewrite is as written and leaves no trace
  b.w.replies.set(done.source, 'not a rewrite')
  await finish($, b, done.source)
  expect(b.w.calls).toHaveLength(2)
  expect(fmtKeys(b)).toHaveLength(2)
  // the same text again is not saved again
  const before = b.w.storeOps.length
  await finish($, b, options.source)
  expect(b.w.calls).toHaveLength(2)
  expect(b.w.storeOps.slice(before).filter(o => o.startsWith('set:'))).toEqual([])
})

test('a new session with a saved page draws it with no model call and without the skill', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, [saved(INFO_SOURCE)]: SEEDED('Seeded title'), 'fmt:index': { v: 1, items: [{ k: textKey(INFO_SOURCE.trim()), n: 80 }] } })
  const ui = await show($, INFO_SOURCE)
  expect(await isOriginal(ui)).toBe(false)
  expect(await texts(ui)).toEqual([' Seeded title '])
  // a marked copy of the same reply draws the same page; another text is untouched
  const mk = await show($, `${MARK}\n\n${INFO_SOURCE}`)
  expect(await texts(mk)).toEqual([' Seeded title '])
  const other = await show($, done.source)
  expect(await isOriginal(other)).toBe(true)
  expect(b.w.calls).toEqual([])
  expect(b.w.tools).not.toContain(FORMAT_TOOL)
  await ui.unmount()
  await mk.unmount()
  await other.unmount()
})

test('the load costs one index read and one read per saved page, and drawing reads no store', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, ...seedPages(3) })
  const loads = b.w.storeOps.filter(o => o.startsWith('get:fmt:'))
  expect(loads).toEqual(['get:fmt:index', ...[0, 1, 2].map(i => `get:fmt:${tk(i)}`)])
  expect(b.w.storeOps).not.toContain('keys')
  const before = b.w.storeOps.length
  const ui = await show($, INFO_SOURCE)
  const again = await show($, done.source)
  expect(b.w.storeOps.length).toBe(before)
  await ui.unmount()
  await again.unmount()
})

test('with the option off nothing is drawn from the saved pages', async ($, on) => {
  const b = await boot($, on, { 'opt:format': false, [saved(INFO_SOURCE)]: SEEDED('Seeded title'), 'fmt:index': { v: 1, items: [{ k: textKey(INFO_SOURCE.trim()), n: 80 }] } })
  const ui = await show($, INFO_SOURCE)
  expect(await isOriginal(ui)).toBe(true)
  await orchestrate($)
  expect(await isOriginal(ui)).toBe(true)
  // switching it on in settings brings the page back: the entries were loaded
  const pane = await settingsPane($)
  await pane.press({ key: 'opt-format' })
  await b.clock.settle()
  expect(await isOriginal(ui)).toBe(false)
  expect(await texts(ui)).toEqual([' Seeded title '])
  await pane.unmount()
  await ui.unmount()
})

test('a saved page of a reply shown raw is drawn as written, as for any page', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  const ui = await show($, options.source)
  expect(await isOriginal(ui)).toBe(false)
  await callTool($, { format: 'raw', scope: 'session' })
  await b.clock.settle()
  expect(await isOriginal(ui)).toBe(true)
  await ui.unmount()
})

test('/clear leaves the saved pages in the store', async ($, on) => {
  const b = await boot($, on)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  const before = JSON.stringify([...b.w.store.entries()].filter(([k]) => k.startsWith('fmt:')))
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await b.clock.settle()
  expect(JSON.stringify([...b.w.store.entries()].filter(([k]) => k.startsWith('fmt:')))).toBe(before)
  expect(b.w.storeOps.filter(o => o.startsWith('delete:'))).toEqual([])
})

test(`eviction by count: past ${FMT_MAX_ENTRIES} pages the oldest go first and the newest is kept`, async ($, on) => {
  const b = await boot($, on, { 'opt:format': true, ...seedPages(FMT_MAX_ENTRIES) })
  expect(indexOf(b)!.items).toHaveLength(FMT_MAX_ENTRIES)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  const items = indexOf(b)!.items
  expect(items).toHaveLength(FMT_MAX_ENTRIES)
  expect(items[0]!.k).toBe(tk(1))
  expect(items[items.length - 1]!.k).toBe(textKey(options.source.trim()))
  expect(b.w.store.has(`fmt:${tk(0)}`)).toBe(false)
  expect(b.w.store.has(`fmt:${tk(1)}`)).toBe(true)
  expect(fmtKeys(b)).toHaveLength(FMT_MAX_ENTRIES + 1)
  // a second one evicts the next oldest
  b.w.replies.set(done.source, done.output)
  await finish($, b, done.source)
  expect(indexOf(b)!.items[0]!.k).toBe(tk(2))
  expect(fmtKeys(b)).toHaveLength(FMT_MAX_ENTRIES + 1)
})

test('eviction by size: past 1 MiB of JSON the oldest go first until the rest fits', async ($, on) => {
  // four pages of about 400 KB: only two fit with the new page
  const b = await boot($, on, { 'opt:format': true, ...seedPages(4, 400_000) })
  const total = indexOf(b)!.items.reduce((s, it) => s + it.n, 0)
  expect(total).toBeGreaterThan(FMT_MAX_BYTES)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  const items = indexOf(b)!.items
  expect(items.reduce((s, it) => s + it.n, 0)).toBeLessThanOrEqual(FMT_MAX_BYTES)
  expect(items.map(it => it.k)).toEqual([tk(2), tk(3), textKey(options.source.trim())])
  expect(b.w.store.has(`fmt:${tk(0)}`)).toBe(false)
  expect(b.w.store.has(`fmt:${tk(1)}`)).toBe(false)
  // the sizes in the index are the sizes of what is stored
  for (const it of items) expect(JSON.stringify(b.w.store.get(`fmt:${it.k}`)).length).toBe(it.n)
  // the stored JSON under the prefix stays within the allowance
  const all = fmtKeys(b).filter(k => k !== 'fmt:index').reduce((s, k) => s + JSON.stringify(b.w.store.get(k)).length, 0)
  expect(all).toBeLessThanOrEqual(FMT_MAX_BYTES)
})

test('a stored value of another shape or version is ignored, then deleted by the next save', async ($, on) => {
  const goodKey = textKey(INFO_SOURCE.trim())
  const rows = [options, done, long, review].map(f => textKey(f.source.trim()))
  const seed = {
    'opt:format': true,
    [`fmt:${goodKey}`]: SEEDED('Good title'),
    [`fmt:${rows[0]}`]: { ...SEEDED('v2'), v: 2 },
    [`fmt:${rows[1]}`]: { v: 1, state: 'kept', kind: 'short', reason: 'timeout' },
    [`fmt:${rows[2]}`]: { v: 1, state: 'done', kind: 'short', parts: [{ kind: 'banner', tag: 'nope', title: 'x' }] },
    // listed in the index but gone from the store
    // (rows[3] has no entry); and one key under the prefix that the index does not list
    'fmt:p1-00000000000abc': SEEDED('stray'),
    'fmt:index': { v: 1, items: [goodKey, ...rows].map(k => ({ k, n: 100 })) },
  }
  const b = await boot($, on, seed)
  const good = await show($, INFO_SOURCE)
  expect(await texts(good)).toEqual([' Good title '])
  for (const f of [options, done, long, review]) {
    const ui = await show($, f.source)
    expect(await isOriginal(ui)).toBe(true)
    await ui.unmount()
  }
  // the bad values stay in the store until a save
  expect(b.w.storeOps.filter(o => o.startsWith('delete:'))).toEqual([])
  expect(fmtKeys(b)).toHaveLength(6)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, options.source)
  expect(fmtKeys(b).sort()).toEqual(['fmt:index', `fmt:${goodKey}`, saved(options.source)].sort())
  expect(indexOf(b)!.items.map(it => it.k)).toEqual([goodKey, textKey(options.source.trim())])
  await good.unmount()
})

const BAD_INDEXES: [string, unknown][] = [
  ['text', 'not an index'],
  ['another version', { v: 2, items: [{ k: textKey(INFO_SOURCE.trim()), n: 1 }] }],
  ['items not a list', { v: 1, items: 'x' }],
  ['items that are not text keys', { v: 1, items: [{ k: 'opt:format', n: 1 }, { k: '../x', n: 1 }, { k: textKey(INFO_SOURCE.trim()) }] }],
]
for (const [name, bad] of BAD_INDEXES) {
  test(`a bad index (${name}) is ignored: nothing is loaded from it and the next save replaces it`, async ($, on) => {
    const key = textKey(INFO_SOURCE.trim())
    const b = await boot($, on, { 'opt:format': true, [`fmt:${key}`]: SEEDED('lost'), 'fmt:index': bad })
    const ui = await show($, INFO_SOURCE)
    expect(await isOriginal(ui)).toBe(true)
    // the load read only the index, and never a key outside the prefix
    expect(b.w.storeOps.filter(o => o.startsWith('get:fmt:'))).toEqual(['get:fmt:index'])
    expect(b.w.store.get('opt:format')).toBe(true)
    b.w.replies.set(options.source, options.output)
    await orchestrate($)
    await finish($, b, options.source)
    expect(fmtKeys(b).sort()).toEqual(['fmt:index', saved(options.source)].sort())
    expect(indexOf(b)!.items.map(it => it.k)).toEqual([textKey(options.source.trim())])
    expect(b.w.store.get('opt:format')).toBe(true)
    await ui.unmount()
  })
}

test('a store that refuses the writes never fails the conversion: the page is drawn and the session goes on', async ($, on) => {
  const b = await boot($, on)
  b.w.denyFmtWrites = true
  b.w.replies.set(options.source, options.output)
  b.w.replies.set(done.source, done.output)
  await orchestrate($)
  const ui = await show($, options.source)
  await finish($, b, options.source)
  expect(await isOriginal(ui)).toBe(false)
  expect(fmtKeys(b)).toEqual([])
  // later saves still work once the store does
  b.w.denyFmtWrites = false
  await finish($, b, done.source)
  expect(fmtKeys(b).sort()).toEqual(['fmt:index', saved(done.source)].sort())
  expect(await quiet(b, 1000)).toBe(0)
  await ui.unmount()
})

test('a store that cannot be read leaves the replies as written and the option still works', async ($, on) => {
  const b = await boot($, on, { 'opt:format': true })
  // a /clear resets the session; the next skill load reads the store again, now unreadable under fmt:
  b.w.store.set(saved(INFO_SOURCE), SEEDED('Seeded title'))
  b.w.store.set('fmt:index', { v: 1, items: [{ k: textKey(INFO_SOURCE.trim()), n: 80 }] })
  b.w.denyFmtReads = true
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await orchestrate($)
  await b.clock.settle()
  const ui = await show($, INFO_SOURCE)
  expect(await isOriginal(ui)).toBe(true)
  // readable again: the next load (after another /clear) brings the page back
  b.w.denyFmtReads = false
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await orchestrate($)
  await b.clock.settle()
  expect(await isOriginal(ui)).toBe(false)
  await ui.unmount()
})

// -- hiding a marked reply while it streams (D9-D11) ---------------------------------------------------------------
// The terminal draws streaming text without the render hook; `classic.MessageDisplay` is the one place the text can be
// held back. A marked reply gets one placeholder line plus an invisible tag, every other flush passes through, and the
// committed row (whose text is the concatenation of what the flushes returned) finds its original by the tag.

type Flush = { id: string; index: number; final: boolean; delta: string; agent?: string }
const flushOf = ($: Engine, f: Flush) =>
  $.classic.MessageDisplay({ turn_id: 'tt', message_id: f.id, index: f.index, final: f.final, delta: f.delta, ...(f.agent ? { agent_id: f.agent } : {}) } as never) as Promise<{ displayContent?: string }>
// A reply as the engine streams it: batches of whole lines, the last one final. The row is what the engine commits:
// the model's delta where the hook left it, else what the hook returned.
function flushesOf(id: string, text: string, per = 3): Flush[] {
  const lines = text.split('\n')
  const out: Flush[] = []
  for (let i = 0; i < lines.length; i += per) {
    const rest = lines.slice(i, i + per)
    const last = i + per >= lines.length
    out.push({ id, index: out.length, final: last, delta: rest.join('\n') + (last ? '' : '\n') })
  }
  return out
}
async function streamReply($: Engine, id: string, text: string, per = 3) {
  const flushes = flushesOf(id, text, per)
  const results: { displayContent?: string }[] = []
  for (const f of flushes) results.push(await flushOf($, f))
  const row = results.map((r, i) => r.displayContent ?? flushes[i]!.delta).join('')
  return { flushes, results, row }
}
const bare = (s: string) => s.replace(/[\u200b\u200c\u2060]/g, '')
const STREAM_PLACEHOLDER = `${FRAMES[0]} formatting reply`
const REPLY = first(options.source)

const untouched = (r: { displayContent?: string }) => 'displayContent' in r

test('unmarked replies, a last-line marker, a subagent and a raw session: every flush passes through untouched', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  const cases: [string, string][] = [
    ['an unmarked reply', options.source],
    ['a marker on the last line', marked(options.source)],
    ['a marker that is not alone on its line', `${MARK} ${options.source}`],
    ['a marker after the first line', `Intro\n${REPLY}`],
  ]
  for (const [name, text] of cases) {
    const { results, row } = await streamReply($, `u-${name}`, text)
    for (const r of results) expect([name, untouched(r)]).toEqual([name, false])
    expect([name, row]).toEqual([name, text])
  }
  // a subagent's marked reply is not redrawn
  for (const f of flushesOf('u-sub', REPLY).map(f => ({ ...f, agent: 'sub-1' }))) expect(untouched(await flushOf($, f))).toBe(false)
  // raw for the session: as written
  await callTool($, { format: 'raw', scope: 'session' })
  for (const r of (await streamReply($, 'u-raw', REPLY)).results) expect(untouched(r)).toBe(false)
  expect(rowsOf(b)).toEqual([])
})

test('a normal session (the skill never loaded) and the option off never hide a marked reply', async ($, on) => {
  await boot($, on, MARKED_MODE)
  const one = await streamReply($, 'n-1', REPLY)
  for (const r of one.results) expect(untouched(r)).toBe(false)
  expect(one.row).toBe(REPLY)
})

test('with the option off, the skill loaded, a marked reply is not hidden', async ($, on) => {
  const off = await boot($, on, {})
  await orchestrate($)
  const two = await streamReply($, 'n-2', REPLY)
  for (const r of two.results) expect(untouched(r)).toBe(false)
  expect(two.row).toBe(REPLY)
  expect(off.w.calls).toEqual([])
})

test('a paused session does not hide a marked reply', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, { stdout: cli.stream(cli.init('none'), cli.resultOk(options.output, { total_cost_usd: 0.0061 })) })
  await orchestrate($)
  await finish($, b, REPLY)
  expect(await noteOf($)).toContain('paused: billing-mismatch')
  const paused = await streamReply($, 'p-1', REPLY)
  for (const r of paused.results) expect(untouched(r)).toBe(false)
  // /clear lifts the pause and the skill loads again: hidden once more
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await orchestrate($)
  const again = await streamReply($, 'p-2', REPLY)
  expect(again.results[0]?.displayContent).toContain(STREAM_PLACEHOLDER)
})

test('a marked reply streams as one placeholder line plus an invisible tag, and none of the model\'s text', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await startTurn($, b)
  const body = Array.from({ length: 12 }, (_, i) => `Line ${i} of the schema migration plan.`).join('\n')
  const { flushes, results, row } = await streamReply($, 'm-1', `${MARK}\n\n${body}`, 1)
  expect(flushes.length).toBeGreaterThan(7)
  // flush 0: the placeholder and the tag; then a dot per flush for the first five; then nothing; the final flush adds nothing
  const tag = untag(results[0]!.displayContent!)!
  expect(results[0]!.displayContent).toBe(STREAM_PLACEHOLDER + tagOf(tag))
  expect(results.slice(1).map(r => r.displayContent)).toEqual(flushes.slice(1).map((f, i) => (!f.final && i + 1 <= 5 ? ' .' : '')))
  // nothing of the model's text, and the tag is invisible text only
  for (const [i, r] of results.entries()) {
    const out = r.displayContent ?? ''
    expect([i, out.includes(MARK)]).toEqual([i, false])
    for (const word of ['migration', 'schema', 'Line']) expect([i, bare(out).includes(word)]).toEqual([i, false])
  }
  expect(row.includes('migration')).toBe(false)
  expect(bare(row)).toBe(`${STREAM_PLACEHOLDER} . . . . .`)
  const invisible = [...row].filter(c => bare(c) === '')
  expect(invisible).toHaveLength(34)
  expect(invisible.every(c => [TAG_ZERO, TAG_ONE, TAG_EDGE].includes(c))).toBe(true)
  // the tag is in the committed row exactly once, and the id is not the message id itself
  expect(untag(row)).toBe(tag)
  expect(stripTag(row)).toBe(bare(row))
  expect(tag).toMatch(/^[0-9a-f]{8}$/)
})

test('a one-flush marked reply, and several text blocks of one turn, each get their own tag', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await startTurn($, b)
  const single = await flushOf($, { id: 's-1', index: 0, final: true, delta: REPLY })
  expect(single.displayContent).toMatch(new RegExp(`^${STREAM_PLACEHOLDER}[\\u200b\\u200c\\u2060]{34}$`))
  const other = await streamReply($, 's-2', `${MARK}\nSecond block of the turn`)
  const a = untag(single.displayContent!)
  const c = untag(other.row)
  expect(a).not.toBeNull()
  expect(c).not.toBeNull()
  expect(a).not.toBe(c)
  // each row finds its own original
  const rowA = await show($, single.displayContent!)
  const rowC = await show($, other.row)
  expect(await texts(rowA)).toEqual([spin(0, 0)])
  expect(await texts(rowC)).toEqual([spin(0, 0)])
  await rowA.unmount()
  await rowC.unmount()
})

test('flushes of one message never decide before flush 0: they wait for it, whichever ends first', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  // the read flush 0 makes first is held until the gate opens
  let open!: () => void
  b.w.gate = { key: 'fmtOrch', until: new Promise<void>(resolve => { open = resolve }) }
  const flushes = flushesOf('c-1', REPLY, 4)
  const settled: number[] = []
  const pending = flushes.map((f, i) => flushOf($, f).then(r => (settled.push(i), r)))
  await b.clock.settle()
  // flush 0 is held at its decision, so no later flush has answered
  expect(settled).toEqual([])
  b.w.gate = null
  open()
  const results = await Promise.all(pending)
  expect(results[0]!.displayContent).toBe(STREAM_PLACEHOLDER + tagOf(untag(results[0]!.displayContent!)!))
  for (const r of results.slice(1)) expect(bare(r.displayContent ?? 'unset')).not.toContain('migration')
  expect(results.slice(1).every(r => r.displayContent === ' .' || r.displayContent === '')).toBe(true)
  // the final flush filed the whole original
  const row = results.map(r => r.displayContent).join('')
  await startTurn($, b)
  const ui = await show($, row)
  expect(await isOriginal(ui)).toBe(false)
  await ui.unmount()
})

test('a later flush whose flush 0 never came passes through after the wait', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  let result: { displayContent?: string } | undefined
  const pending = flushOf($, { id: 'w-1', index: 2, final: false, delta: 'later line\n' }).then(r => (result = r))
  await b.clock.settle()
  expect(result).toBeUndefined()
  await b.clock.advance(2000)
  await pending
  expect('displayContent' in result!).toBe(false)
})

test('an error in the handler leaves the flush as it is: no text is hidden', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  // a flush the handler cannot file (no message id) throws inside it; the reply is not hidden
  const broken = await $.classic.MessageDisplay({ turn_id: 'tt', index: 0, final: false, delta: `${MARK}\nbody\n` } as never)
  expect('displayContent' in broken).toBe(false)
  // the next reply is hidden as usual
  const ok = await streamReply($, 'e-2', REPLY)
  expect(ok.results[0]?.displayContent).toContain(STREAM_PLACEHOLDER)
  expect(b.w.calls).toEqual([])
})

test('the committed row never shows plain text: placeholder, spinner while the final flush is slow, then the page', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 1500)
  await orchestrate($)
  await startTurn($, b)
  const flushes = flushesOf('f-1', REPLY, 3)
  const results: { displayContent?: string }[] = []
  for (const f of flushes.slice(0, -1)) results.push(await flushOf($, f))
  // the engine commits and draws the row before the final flush has ended
  const ui = await show($, results.map(r => r.displayContent ?? '').join(''))
  expect(await isOriginal(ui)).toBe(false)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  // the final flush is slow (a hook beneath ours takes 500 ms)
  b.w.finalDelay = 500
  const finalPending = flushOf($, flushes[flushes.length - 1]!)
  await b.clock.advance(300)
  expect(await isOriginal(ui)).toBe(false)
  expect(await texts(ui)).toEqual([spin(3, 0)])
  b.w.finalDelay = 0
  await b.clock.advance(300)
  const last = await finalPending
  expect(last.displayContent).toBe('')
  // the original is complete now; the turn still runs, so the row is still the spinner
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui))[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] formatting reply · 0s$/)
  // the turn ends: the conversion is claimed at once and the row stays the spinner, then becomes the page
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: `u${turnSeq}`, reason: 'answer' } as never)
  expect(await isOriginal(ui)).toBe(false)
  await b.clock.settle()
  expect(b.w.calls).toHaveLength(1)
  expect(b.w.calls[0]!.prompt).toBe(options.source)
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui))[0]).toMatch(/formatting reply · \ds$/)
  await b.clock.advance(1600)
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui)).join('\n')).toContain('Choose how to run the schema migration')
  expect((await texts(ui)).join('\n')).not.toContain('formatting reply')
  // the model's text was never drawn by the engine, at any point
  expect(rowsOf(b)).toEqual([])
  await ui.unmount()
})

test('the row draws again when the final flush files the original, with no timer to do it', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  // no turn runs, so nothing ticks: only the final flush can move the row (a short reply is not converted, so it ends as written)
  const SHORT = `${MARK}\nAll done, nothing to decide.\nThe checks all pass.\nNothing else is open.`
  const flushes = flushesOf('r-1', SHORT, 3)
  const results: { displayContent?: string }[] = []
  for (const f of flushes.slice(0, -1)) results.push(await flushOf($, f))
  const ui = await show($, results.map(r => r.displayContent ?? '').join(''))
  expect(await texts(ui)).toEqual([spin(0, 0)])
  expect(await quiet(b, 500)).toBe(0)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await flushOf($, flushes[flushes.length - 1]!)
  await b.clock.settle()
  // an old marked reply with no entry and no turn: as written, marker gone
  expect(await isOriginal(ui)).toBe(true)
  expect(rowsOf(b).at(-1)).toBe(SHORT.replace(`${MARK}\n`, ''))
  expect(b.w.calls).toEqual([])
  await ui.unmount()
})

test('a hidden reply whose conversion failed is the original with its marker removed, the tag gone, and one reason line', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, { reason: 'api-error' })
  await orchestrate($)
  await startTurn($, b)
  const { row } = await streamReply($, 'k-1', REPLY)
  const ui = await show($, row)
  await finish($, b, REPLY)
  expect(b.w.calls).toHaveLength(1)
  expect(await isOriginal(ui)).toBe(false)
  const t = await texts(ui)
  expect(t).toContain(REASON('api-error'))
  // the original text goes to the engine: marker and tag are gone
  expect(rowsOf(b)).toEqual([options.source.trim()])
  expect(rowsOf(b).join('').match(/[\u200b\u200c\u2060]/)).toBeNull()
  await ui.unmount()
})

test('a hidden reply that is not eligible for the model (short) is as written once the turn ends; it spins only while it streams', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await startTurn($, b)
  const short = `${MARK}\nAll done, nothing to decide.`
  const { row } = await streamReply($, 'sh-1', short)
  const ui = await show($, row)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await finish($, b, short)
  expect(b.w.calls).toEqual([])
  expect(rowsOf(b)).toEqual(['All done, nothing to decide.'])
  await ui.unmount()
})

test('a turn that ends without its last flush shows what was received as written', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  await startTurn($, b)
  const flushes = flushesOf('a-1', REPLY, 3)
  const results: { displayContent?: string }[] = []
  for (const f of flushes.slice(0, 3)) results.push(await flushOf($, f))
  const row = results.map(r => r.displayContent ?? '').join('')
  const ui = await show($, row)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await endTurn($, b, 'aborted')
  expect(await isOriginal(ui)).toBe(true)
  const drawn = rowsOf(b)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]).toContain('The migration to the new database schema')
  expect(drawn[0]).not.toContain(MARK)
  expect(drawn[0]!.match(/[\u200b\u200c\u2060]/)).toBeNull()
  await ui.unmount()
})

test('a tag whose original is gone (a reload, a /clear) is drawn as its own line with the tag removed', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  await orchestrate($)
  const lost = await show($, STREAM_PLACEHOLDER + tagOf('0badf00d'))
  expect(await isOriginal(lost)).toBe(true)
  expect(rowsOf(b)).toEqual([STREAM_PLACEHOLDER])
  await lost.unmount()
  // a /clear forgets the originals of the session
  await startTurn($, b)
  const { row } = await streamReply($, 'x-1', REPLY)
  const ui = await show($, row)
  expect(await texts(ui)).toEqual([spin(0, 0)])
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await b.clock.settle()
  expect(await isOriginal(ui)).toBe(true)
  expect(rowsOf(b).at(-1)).toBe(bare(row))
  await ui.unmount()
})

test('hiding a reply saves nothing in the store: only a finished page is saved, under its own key', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await startTurn($, b)
  const { row } = await streamReply($, 'z-1', REPLY)
  expect(b.w.storeOps.filter(o => o.startsWith('set:fmt:'))).toEqual([])
  const ui = await show($, row)
  await finish($, b, REPLY)
  expect(fmtKeys(b).sort()).toEqual(['fmt:index', saved(options.source)].sort())
  expect(JSON.stringify([...b.w.store.values()]).match(/[\u200b\u200c\u2060]/)).toBeNull()
  await ui.unmount()
})

test('unchanged: a row without a tag (a resumed reply, an unmarked one) draws as before', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  await orchestrate($)
  await finish($, b, REPLY)
  const page = await show($, REPLY)
  expect(await isOriginal(page)).toBe(false)
  const plain = await show($, 'Plain reply that nobody marked.')
  expect(await isOriginal(plain)).toBe(true)
  await page.unmount()
  await plain.unmount()
})

// -- each marked block converts at its own final flush (D12), one counter per block (D13) -----------------------------

const secsOf = (t: string | undefined) => Number(/· (\d+)s$/.exec(t ?? '')?.[1] ?? NaN)
const SECOND = first(INFO_SOURCE)

test('two marked blocks around a slow tool call both convert, each to its own page, and neither spins past its own conversion', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 800)
  b.w.replies.set(INFO_SOURCE, INFO_OUTPUT)
  b.w.delays.set(INFO_SOURCE, 800)
  await orchestrate($)
  await startTurn($, b)
  const a = await streamReply($, 'blk-a', REPLY)
  const rowA = await show($, a.row)
  // block A's original is complete: its conversion starts at once, not at the turn's end
  await b.clock.advance(100)
  expect(b.w.calls.map(c => c.prompt)).toEqual([options.source])
  expect((await texts(rowA))[0]).toMatch(/formatting reply · \ds$/)
  // a slow tool call: the turn goes on for 5 s with no reply text
  await b.clock.advance(5000)
  expect(await isOriginal(rowA)).toBe(false)
  expect((await texts(rowA)).join('\n')).toContain('Choose how to run the schema migration')
  expect((await texts(rowA)).join('\n')).not.toContain('formatting reply')
  // the second block after the tool
  const c = await streamReply($, 'blk-b', SECOND)
  const rowB = await show($, c.row)
  await b.clock.advance(100)
  expect(b.w.calls.map(x => x.prompt)).toEqual([options.source, INFO_SOURCE])
  // the turn ends with the second block as its answer: it was claimed at its flush, so nothing is converted twice
  await finish($, b, SECOND)
  expect(b.w.calls.map(x => x.prompt)).toEqual([options.source, INFO_SOURCE])
  await b.clock.advance(2000)
  expect(b.w.calls.map(x => x.prompt)).toEqual([options.source, INFO_SOURCE])
  for (const ui of [rowA, rowB]) {
    expect(await isOriginal(ui)).toBe(false)
    expect((await texts(ui)).join('\n')).not.toContain('formatting reply')
  }
  expect((await texts(rowB)).join('\n')).toContain('is unchanged')
  expect(rowsOf(b)).toEqual([])
  // nothing is left running: no pending conversion, no turn, no timer
  expect(await quiet(b, 3000)).toBe(0)
  expect(fmtKeys(b).sort()).toEqual(['fmt:index', saved(options.source), saved(INFO_SOURCE)].sort())
  await rowA.unmount()
  await rowB.unmount()
})

test('a block converted at its final flush is not converted again at the turn\'s end, even while its call still runs', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 3000)
  await orchestrate($)
  await startTurn($, b)
  const { row } = await streamReply($, 'dd-1', REPLY)
  const ui = await show($, row)
  await b.clock.advance(100)
  expect(b.w.calls).toHaveLength(1)
  // the turn ends while the call from the final flush runs
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: `u${turnSeq}`, reason: 'answer' } as never)
  await b.clock.advance(500)
  expect(b.w.calls).toHaveLength(1)
  expect((await texts(ui))[0]).toMatch(/formatting reply · \ds$/)
  await b.clock.advance(3000)
  expect(b.w.calls).toHaveLength(1)
  expect(await isOriginal(ui)).toBe(false)
  expect((await texts(ui)).join('\n')).not.toContain('formatting reply')
  // the stats count the answer once
  expect(await noteOf($)).toContain('formatted 1')
  expect(await quiet(b, 2000)).toBe(0)
  await ui.unmount()
})

test('a block whose conversion failed before the turn ends shows its written text and one reason line, not a spinner', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, { reason: 'api-error' })
  await orchestrate($)
  await startTurn($, b)
  const { row } = await streamReply($, 'ff-1', REPLY)
  const ui = await show($, row)
  await b.clock.advance(1000)
  // the turn still runs (a tool call), yet the block is settled
  expect(await texts(ui)).toContain(REASON('api-error'))
  expect((await texts(ui)).join('\n')).not.toContain('formatting reply')
  expect(rowsOf(b)).toEqual([options.source.trim()])
  await ui.unmount()
})

test('the elapsed seconds of one block never decrease: streaming, final flush, pending, page', async ($, on) => {
  const b = await boot($, on, MARKED_MODE)
  b.w.replies.set(options.source, options.output)
  b.w.delays.set(options.source, 3000)
  await orchestrate($)
  await startTurn($, b)
  // the model thinks for 2 s before the reply begins: the counter starts at the reply's first flush
  await b.clock.advance(2000)
  const flushes = flushesOf('el-1', REPLY, 3)
  const results: { displayContent?: string }[] = []
  for (const f of flushes.slice(0, -1)) results.push(await flushOf($, f))
  const ui = await show($, results.map(r => r.displayContent ?? '').join(''))
  const seen: number[] = [secsOf((await texts(ui))[0])]
  expect(seen[0]).toBe(0)
  for (let i = 0; i < 12; i++) {
    await b.clock.advance(250)
    seen.push(secsOf((await texts(ui))[0]))
  }
  // the final flush: the conversion is claimed, the row is the pending one
  await flushOf($, flushes[flushes.length - 1]!)
  for (let i = 0; i < 20; i++) {
    await b.clock.advance(100)
    const t = (await texts(ui))[0]
    if (t?.includes('formatting reply')) seen.push(secsOf(t))
  }
  // the turn ends: the claim is already taken, the counter goes on
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: `u${turnSeq}`, reason: 'answer' } as never)
  for (let i = 0; i < 6; i++) {
    await b.clock.advance(100)
    const t = (await texts(ui))[0]
    if (t?.includes('formatting reply')) seen.push(secsOf(t))
  }
  expect(seen.every(n => Number.isFinite(n))).toBe(true)
  for (let i = 1; i < seen.length; i++) expect([i, seen[i]! >= seen[i - 1]!]).toEqual([i, true])
  // 3 s of streaming, then the call: the counter passed 3 and 5 on the way
  expect(Math.max(...seen)).toBeGreaterThanOrEqual(5)
  await b.clock.advance(3000)
  expect((await texts(ui)).join('\n')).not.toContain('formatting reply')
  await ui.unmount()
})
