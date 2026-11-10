import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import {
  FORMAT_SYSTEM, KINDS, LONG_EFFORT, LONG_MAX_TOKENS, LONG_MODEL, LONG_TIMEOUT_MS, SHORT_EFFORT, SHORT_MAX_TOKENS, SHORT_MODEL, SHORT_TIMEOUT_MS,
} from '../hooks/format'
import { FORMAT_TOOL, FORMAT_TOOL_FULL } from '../hooks/format-view'
import * as done from './fixtures/format/done'
import * as long from './fixtures/format/long'
import * as options from './fixtures/format/options'
import * as review from './fixtures/format/review'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
type Call = { model: string; effort?: string; maxTokens?: number; timeoutMs?: number; system?: string; prompt: string }
type Reply = string | { reason: 'api-error' | 'empty-reply' | 'aborted' } | { deny: string } | { text: string; tokens: number }

// A short source with no digits and one id, and a rewrite of it with an `info` banner.
const FILLER = 'The work continues as planned and nothing else has changed since the last report. '
const INFO_SOURCE = FILLER.repeat(5) + 'The file `src/a.ts` is unchanged.'
const INFO_OUTPUT = '# [info] `src/a.ts` is unchanged\n\n## [more] Where it stands\n\n- **File:** `src/a.ts` is unchanged.\n- **Work:** it continues as planned and nothing else has changed since the last report.'

// The compaction tool is there from session start; the formatter's is the one that comes with the marking.
const formatTools = (w: { tools: string[] }) => w.tools.filter(t => t === FORMAT_TOOL)

type World = { calls: Call[]; tools: string[]; commands: string[]; opened: Record<string, unknown>[]; store: Map<string, unknown>; replies: Map<string, Reply>; delays: Map<string, number> }

// The engine beneath the plugin: just enough for session.start, the model, the store and the tool registry.
async function boot($: Engine, on: On, seed: Record<string, unknown> = { 'opt:format': true }) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-10T10:00Z') })
  const w: World = { calls: [], tools: [], commands: [], opened: [], store: new Map(Object.entries(seed)), replies: new Map(), delays: new Map() }
  mock.env(on, { HOME: '/home/u' })
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
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no orch', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
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
  on('model.complete', async (_, e) => {
    w.calls.push({ model: e.model, effort: e.effort, maxTokens: e.maxTokens, timeoutMs: e.timeoutMs, system: e.system, prompt: e.prompt })
    const delay = w.delays.get(e.prompt)
    if (delay) await clock.sleep(delay)
    const r = w.replies.get(e.prompt)
    if (r === undefined) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    if (typeof r === 'string') return { value: { isAnswered: true as const, text: r, usage: USAGE } }
    if ('deny' in r) return { deny: r.deny }
    if ('tokens' in r) return { value: { isAnswered: true as const, text: r.text, usage: { ...USAGE, output_tokens: r.tokens } } }
    if (r.reason === 'api-error') return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage: USAGE } }
    if (r.reason === 'aborted') return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
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

const SHORT_ROUTE = { model: SHORT_MODEL, effort: SHORT_EFFORT, maxTokens: SHORT_MAX_TOKENS, timeoutMs: SHORT_TIMEOUT_MS }
const LONG_ROUTE = { model: LONG_MODEL, effort: LONG_EFFORT, maxTokens: LONG_MAX_TOKENS, timeoutMs: LONG_TIMEOUT_MS }

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
  expect((await optionRow(ui)).note).toBe(`formatted 1 · as written 0 · last: ok (long/${LONG_MODEL})`)
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

const FAILS: [string, Reply, string][] = [
  ['an API error', { reason: 'api-error' }, 'no-answer'],
  ['an empty reply', { reason: 'empty-reply' }, 'no-answer'],
  ['a timeout', { reason: 'aborted' }, 'timeout'],
  ['a model the engine refuses', { deny: 'model not allowed' }, 'refused: orch-ui: $.model.complete: model not allowed'],
  ['a reply that used its whole cap', { text: options.output, tokens: SHORT_MAX_TOKENS }, 'truncated'],
  ['a rewrite that fails validation', 'Not in the format at all.', 'no-banner'],
  ['a rewrite that drops an id', options.output.replace(/`v3\.0\.0`/g, 'the release'), 'missing-id'],
]
for (const [name, reply, reason] of FAILS) {
  test(`${name}: the original stays, the reason is recorded`, async ($, on) => {
    const b = await boot($, on)
    b.w.replies.set(options.source, reply)
    await orchestrate($)
    await finish($, b, options.source)
    expect(b.w.calls).toHaveLength(1)
    const ui = await show($, options.source)
    expect(await isOriginal(ui)).toBe(true)
    const pane = await settingsPane($)
    expect((await optionRow(pane)).note).toBe(`formatted 0 · as written 1 · last: ${reason} (short/${SHORT_MODEL})`)
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

test('the pane holds the Format replies row and nothing else', async ($, on) => {
  await boot($, on)
  const ui = await settingsPane($)
  expect((await ui.findAll({ type: 'Button' })).map(x => x.key)).toEqual(['opt-format'])
  expect((await optionRow(ui)).label).toBe('[x] Format replies')
  await ui.unmount()
})

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
