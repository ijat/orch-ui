// The reply formatter's hooks and drawing. The pure core (routes, prompt, validation, pill kinds) is in
// format.ts. Display only: the transcript text never changes, so raw is a redraw of the same message.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On, RenderChildren } from 'claude-code'

import type { Billing, FmtEntry, FmtLatest, FmtOrderItem, FmtStats, KeySource, Trigger } from '../types'
import { formatCall } from './format-call'
import type { CallSeen } from './format-call'
import {
  DEFAULT_BILLING, DEFAULT_EFFORT, DEFAULT_KEY_SOURCE, DEFAULT_MODEL, EFFORTS, KINDS, MODELS, PAUSE_REASONS, endsWithPartialMark, formatOnce, hidePartialMark,
  kindOf, route, stripMark,
} from './format'
import type { Kind, Part, Route, Row, RowTag } from './format'
import { textKey } from './lib'

const SKILL = 'orchestrate'
export const FORMAT_TOOL = 'set_message_format'
export const FORMAT_TOOL_FULL = 'mcp__orch-ui__set_message_format'
const OPT_KEY = 'opt:format'
const DEFAULT_TRIGGER = 'marked'
const TRIGGERS = ['marked', 'auto'] as const
const OPT_MODEL = 'opt:format-model'
const OPT_EFFORT = 'opt:format-effort'
const OPT_BILLING = 'opt:format-billing'
const OPT_KEY_SOURCE = 'opt:format-key'
const OPT_TRIGGER = 'opt:format-trigger'

// -- state -----------------------------------------------------------------------------------------
// The option (also kept in $.store) and what one session knows. Nothing but the option outlives the session.

const fmtOn = atom({ plugin: 'orch-ui', key: 'fmtOn' } as const, false)
// True once the orchestrate skill has loaded in this session; /clear resets it.
const fmtOrch = atom({ plugin: 'orch-ui', key: 'fmtOrch' } as const, false)
// Raw for the whole session: every row as written, no new conversion.
const fmtRaw = atom({ plugin: 'orch-ui', key: 'fmtRaw' } as const, false)
// Counts turns that started a conversion, so the list below keeps turn.complete order, not completion order.
const fmtSeq = atom({ plugin: 'orch-ui', key: 'fmtSeq' } as const, 0)
const EMPTY_ORDER: FmtOrderItem[] = []
// The keys that received a valid entry, oldest turn first.
const fmtOrder = atom({ plugin: 'orch-ui', key: 'fmtOrder' } as const, EMPTY_ORDER)
const EMPTY_STATS: FmtStats = { formatted: 0, kept: 0, last: null, spentUsd: 0, billing: null, viaBaseUrl: false, eligible: 0, marked: 0, asked: 0 }
// A stored value of another shape reads as the empty counts.
const isStats = (s: unknown): s is FmtStats =>
  typeof s === 'object' && s !== null && ['formatted', 'kept', 'spentUsd', 'eligible', 'marked', 'asked'].every(k => typeof (s as Record<string, unknown>)[k] === 'number')
const fmtStats = atom({ plugin: 'orch-ui', key: 'fmtStats' } as const, EMPTY_STATS)
// The settings, also kept in $.store (loaded at session start; a stored value of another kind reads as the default).
const fmtModel = atom({ plugin: 'orch-ui', key: 'fmtModel' } as const, DEFAULT_MODEL as string)
const fmtEffort = atom({ plugin: 'orch-ui', key: 'fmtEffort' } as const, DEFAULT_EFFORT as string)
const fmtBilling = atom({ plugin: 'orch-ui', key: 'fmtBilling' } as const, DEFAULT_BILLING as Billing)
const fmtKey = atom({ plugin: 'orch-ui', key: 'fmtKey' } as const, DEFAULT_KEY_SOURCE as KeySource)
// The reason formatting stopped for this session (a credential, model or setup failure), else null. Only a
// settings press, a settings change or /clear clears it.
const fmtPause = atom({ plugin: 'orch-ui', key: 'fmtPause' } as const, null as string | null)
const fmtTrigger = atom({ plugin: 'orch-ui', key: 'fmtTrigger' } as const, DEFAULT_TRIGGER as Trigger)
// The newest eligible reply of this session, converted or not (what "format that" means).
const fmtLatest = atom({ plugin: 'orch-ui', key: 'fmtLatest' } as const, null as FmtLatest | null)

// One entry and one raw mark per message, by the key of its text.
// The reference is written out in each call: the scan that lists what a module reads and writes needs literal
// plugin and key, and only the id may be computed.
const readEntry = ($: EngineInterface, id: string) => read($, { plugin: 'orch-ui', key: 'fmtEntries', id } as const)
const changeEntry = ($: EngineInterface, id: string, change: (cur: FmtEntry | undefined) => FmtEntry) =>
  update($, { plugin: 'orch-ui', key: 'fmtEntries', id } as const, change)
const readMark = ($: EngineInterface, id: string) => read($, { plugin: 'orch-ui', key: 'fmtMarks', id } as const)
const setMark = ($: EngineInterface, id: string, value: boolean) => update($, { plugin: 'orch-ui', key: 'fmtMarks', id } as const, () => value)

// A stored value of another shape reads as the default.
async function orderOf($: EngineInterface): Promise<FmtOrderItem[]> {
  const v = await read($, fmtOrder)
  return Array.isArray(v) ? v : EMPTY_ORDER
}
async function statsOf($: EngineInterface): Promise<FmtStats> {
  const v = await read($, fmtStats)
  return isStats(v) ? v : EMPTY_STATS
}

const keyOf = (text: string) => textKey(text.trim())
const PENDING: FmtEntry = { state: 'pending' }

// -- conversion ------------------------------------------------------------------------------------

// The key joins the list of messages that have a valid entry, as the newest of its turn (a repeat moves it up).
const enqueue = ($: EngineInterface, key: string, seq: number) =>
  update($, fmtOrder, list => [...(Array.isArray(list) ? list : []).filter(x => x.key !== key), { key, seq }].sort((a, b) => a.seq - b.seq))

// Records one outcome: the entry, this session's counts and spend, and the last reason. `ran` is what the call
// reported once it got as far as a run (its billing, and whether a gateway is set); without it the last stays.
async function record($: EngineInterface, key: string, entry: FmtEntry, seq: number, a: { r: Route; model: string; retry: boolean }, reason: string, costUsd: number, ran: CallSeen | null) {
  const ok = entry.state === 'done'
  if (ok) await enqueue($, key, seq)
  await changeEntry($, key, () => entry)
  await update($, fmtStats, s => {
    const cur = isStats(s) ? s : EMPTY_STATS
    return {
      ...cur,
      formatted: cur.formatted + (ok ? 1 : 0),
      // a second try of a reply already counted as written is not counted twice
      kept: Math.max(0, cur.kept + (ok ? 0 : 1) - (a.retry ? 1 : 0)),
      last: { reason, kind: a.r.kind, model: a.model },
      spentUsd: cur.spentUsd + costUsd,
      billing: ran ? ran.billing : cur.billing,
      viaBaseUrl: ran ? ran.viaBaseUrl : cur.viaBaseUrl,
    }
  })
}

const BILLINGS = ['api', 'subscription'] as const
const KEY_SOURCES = ['env', 'file'] as const
const settingOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)

// Asks for the rewrite of one reply (one `claude -p` call) and records the outcome. Anything that is not a valid
// rewrite leaves the original on screen and records why.
async function convert($: EngineInterface, text: string, seq: number, retry = false) {
  const source = text.trim()
  const r = route(source)
  if (!r) return
  const key = keyOf(source)

  // Raw for the session, a switched-off option or a pause may have come in since the turn ended.
  if ((await read($, fmtRaw)) || !(await read($, fmtOn)) || (await read($, fmtPause)) != null) return
  let claimed = false
  await changeEntry($, key, cur => {
    // A request may take one more try at a reply whose first try ended as written.
    claimed = cur === undefined || (retry && cur.state === 'kept')
    return claimed ? PENDING : (cur as FmtEntry)
  })
  if (!claimed) {
    // The same text again: its entry stands, and it becomes the newest message.
    if ((await readEntry($, key))?.state === 'done') await enqueue($, key, seq)
    return
  }

  const model = settingOf(await read($, fmtModel), MODELS, DEFAULT_MODEL)
  const effort = settingOf(await read($, fmtEffort), EFFORTS, DEFAULT_EFFORT)
  const billing = settingOf(await read($, fmtBilling), BILLINGS, DEFAULT_BILLING)
  const keySource = settingOf(await read($, fmtKey), KEY_SOURCES, DEFAULT_KEY_SOURCE)
  let ran: CallSeen | null = null
  const res = await formatOnce(source, { model, effort, kind: r.kind }, req =>
    formatCall($, req, { billing, keySource }, { seen: info => { ran = info } }))
  if (!res.ok) {
    if ((PAUSE_REASONS as readonly string[]).includes(res.reason)) await update($, fmtPause, () => res.reason)
    await record($, key, { state: 'kept', kind: r.kind, reason: res.reason }, seq, { r, model, retry }, res.reason, res.costUsd, ran)
    return
  }
  await record($, key, { state: 'done', kind: r.kind, parts: res.parts }, seq, { r, model, retry }, 'ok', res.costUsd, ran)
}

// -- raw -------------------------------------------------------------------------------------------

async function markedKeys($: EngineInterface): Promise<string[]> {
  const out: string[] = []
  for (const x of await orderOf($)) if ((await readMark($, x.key)) === true) out.push(x.key)
  return out
}

// Back to formatted: the session flag and every per-message mark.
async function clearRaw($: EngineInterface) {
  const marked = await markedKeys($)
  await update($, fmtRaw, () => false)
  for (const key of marked) await setMark($, key, false)
}

// Formatting may start again; called by the settings rows (step 11) and by /clear.
export async function clearPause($: EngineInterface) {
  await update($, fmtPause, () => null)
}

async function resetSession($: EngineInterface) {
  await clearRaw($)
  await clearPause($)
  await update($, fmtOrch, () => false)
  await update($, fmtOrder, () => EMPTY_ORDER)
  await update($, fmtStats, () => EMPTY_STATS)
  await update($, fmtLatest, () => null)
}

// "Format that": converts the session's latest eligible reply when it was left as written. Only that reply; an older
// one cannot be asked for. No entry yet starts a conversion, a reply that ended as written gets one more try, a done or
// running one is left alone. Paused formatting makes no call. It starts like any conversion, on a timer.
async function formatLatest($: EngineInterface): Promise<string> {
  const pause = await read($, fmtPause)
  if (pause != null) return `paused: ${pause}`
  const latest = await read($, fmtLatest)
  if (!latest) return 'no reply to format'
  const entry = await readEntry($, latest.key)
  if (entry?.state === 'done') return 'already formatted'
  if (entry?.state === 'pending') return 'it is being formatted already'
  if (entry?.state === 'kept') {
    if (latest.retried) return 'it was tried once more already and stays as written'
    await update($, fmtLatest, l => (l ? { ...l, retried: true } : l))
  }
  await update($, fmtStats, s => {
    const cur = isStats(s) ? s : EMPTY_STATS
    return { ...cur, asked: cur.asked + 1 }
  })
  const retry = entry !== undefined
  $.clock.after(0, () => void convert($, latest.text, latest.seq, retry).catch(() => undefined))
  return 'formatting the latest reply now'
}

const OFF_TEXT = "Formatting is off in orch-ui's settings (/orch-ui); nothing changed."

async function setFormat($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string }> {
  const format = e.format
  const scope = e.scope === undefined ? 'latest' : e.scope
  if (format !== 'raw' && format !== 'formatted') return { result: 'Refused: format must be "raw" or "formatted". Nothing changed.' }
  if (scope !== 'latest' && scope !== 'session') return { result: 'Refused: scope must be "latest" or "session". Nothing changed.' }
  if (!(await read($, fmtOrch))) return { result: 'Formatting is not active in this session (the orchestrate skill has not been loaded). Nothing changed.' }
  if (!(await read($, fmtOn))) return { result: OFF_TEXT }

  if (format === 'formatted') {
    await clearRaw($)
    const base = 'Formatted again: the session-wide raw mode and every message shown as written are cleared (scope ignored). New and earlier formatted messages are drawn formatted.'
    return { result: `${base} Latest reply: ${await formatLatest($)}.` }
  }
  if (scope === 'session') {
    await update($, fmtRaw, () => true)
    return { result: 'Scope session: every message in this session is shown as written and no new message is formatted. The stored option in orch-ui is untouched. Formatting returns on request (format "formatted"), from the Format replies row in orch-ui\'s settings (/orch-ui), or in a new session.' }
  }
  const order = await orderOf($)
  const newest = order[order.length - 1]
  if (!newest) return { result: 'No formatted message to show raw. Nothing changed.' }
  if ((await readMark($, newest.key)) === true) return { result: 'Scope latest: the newest formatted message is already shown as written. Nothing changed; the next message will be formatted again.' }
  await setMark($, newest.key, true)
  return { result: 'Scope latest: the newest formatted message is now shown as written. The next message will be formatted again. The stored option is untouched.' }
}

const FORMAT_TOOL_DESCRIPTION = 'Show orch-ui\'s formatted redraw of your replies as written, or bring the formatting back. Call it only when the user explicitly asks about the formatting '
  + '(for example "show raw", "give me unfiltered", "turn off orch-ui", "bring the formatting back"), never because something was unclear: "I don\'t get it" means explain better, not call this. '
  + 'format "raw" shows messages as written, "formatted" restores the formatting. scope "latest" (the default) affects only the newest formatted message, and the next message is formatted again; '
  + 'use it unless the user\'s words cover more than the last message. scope "session" for "turn off orch-ui", "stop formatting", "keep it raw", "for the rest of the session", "all messages". '
  + 'format "formatted" also formats your latest reply if it was left as written: "format that" or "show that in orch-ui" mean call it with "formatted", and never write the reply again. '
  + 'It changes how replies are drawn only, never the stored text, and not the stored option.'

async function registerTool($: EngineInterface) {
  try {
    await $.tool.register({
      name: FORMAT_TOOL,
      description: FORMAT_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['raw', 'formatted'], description: '"raw": show as written. "formatted": restore the formatting.' },
          scope: { type: 'string', enum: ['latest', 'session'], description: '"latest" (default): the newest formatted message only. "session": every message, until asked otherwise.' },
        },
        required: ['format'],
        additionalProperties: false,
      },
    })
  } catch {
    // No tool this session; the settings row still restores the formatting.
  }
}

// -- the settings row ---------------------------------------------------------------------------------

// Called from register.tsx's session.start: a second unmatched hook on that event is refused.
export async function loadFormat($: EngineInterface) {
  try {
    const stored = await $.store.get(OPT_KEY)
    if (typeof stored === 'boolean') await update($, fmtOn, () => stored)
  } catch {
    // The default stays: off.
  }
  const load = async <T extends string>(storeKey: string, allowed: readonly T[], fallback: T, set: (v: T) => Promise<unknown>) => {
    try {
      await set(settingOf(await $.store.get(storeKey), allowed, fallback))
    } catch {
      // The default stays.
    }
  }
  await load(OPT_MODEL, MODELS, DEFAULT_MODEL, v => update($, fmtModel, () => v))
  await load(OPT_EFFORT, EFFORTS, DEFAULT_EFFORT, v => update($, fmtEffort, () => v))
  await load(OPT_BILLING, BILLINGS, DEFAULT_BILLING, v => update($, fmtBilling, () => v))
  await load(OPT_KEY_SOURCE, KEY_SOURCES, DEFAULT_KEY_SOURCE, v => update($, fmtKey, () => v))
  await load(OPT_TRIGGER, TRIGGERS, DEFAULT_TRIGGER, v => update($, fmtTrigger, () => v))
}

// What the row shows: the option, and a note on raw state, this session's counts and the last outcome.
export async function formatRow($: EngineInterface): Promise<{ on: boolean; note: string | null }> {
  const on = (await read($, fmtOn)) === true
  const raw = (await read($, fmtRaw)) === true
  const marked = raw ? 0 : (await markedKeys($)).length
  const stats = await statsOf($)
  const bits: string[] = []
  if (raw) bits.push('raw: this session')
  else if (marked > 0) bits.push(`raw: ${marked} message(s)`)
  if (stats.formatted + stats.kept > 0) bits.push(`formatted ${stats.formatted} · as written ${stats.kept}`)
  if (stats.eligible > 0 && settingOf(await read($, fmtTrigger), TRIGGERS, DEFAULT_TRIGGER) === 'marked') bits.push(`marked ${stats.marked} of ${stats.eligible}`, `asked ${stats.asked}`)
  if (stats.last) bits.push(`last: ${stats.last.reason} (${stats.last.kind}/${stats.last.model})`)
  if (stats.billing) bits.push(`${stats.billing === 'api' ? 'api' : 'plan'} $${stats.spentUsd.toFixed(2)}`)
  if (stats.viaBaseUrl) bits.push('via ANTHROPIC_BASE_URL')
  const pause = await read($, fmtPause)
  if (pause) bits.push(`paused: ${pause}`)
  return { on, note: bits.length ? bits.join(' · ') : null }
}

// A press with any raw state set clears it and keeps the option on; otherwise it flips the option.
export async function pressFormat($: EngineInterface) {
  if ((await read($, fmtRaw)) === true || (await markedKeys($)).length > 0) {
    await clearRaw($)
    return
  }
  const next = (await read($, fmtOn)) !== true
  await update($, fmtOn, () => next)
  try {
    await $.store.set(OPT_KEY, next)
  } catch {
    // This session keeps it; the next one starts from the default.
  }
}

// -- the settings rows (D30, D43) ---------------------------------------------------------------------
// Five rows under `Format replies` in the /orch-ui pane. Each press moves to the next value, stores it and lifts a
// pause; the new value applies from the next call. Nothing here reads or shows key material or a gateway value.

export type SettingId = 'trigger' | 'model' | 'effort' | 'billing' | 'key'
export type SettingRow = { id: SettingId; key: string; label: string; value: string; note: string | null }

const KEY_FILE_LABEL = '~/.claude/settings.local.json'
// The last outcomes that say something about the credential, for the key row's note.
const KEY_REASONS: readonly string[] = ['no-credential', 'auth-failed', 'base-url-set', 'key-file-missing', 'key-file-unsafe', 'key-file-invalid']

async function settingsNow($: EngineInterface) {
  return {
    trigger: settingOf(await read($, fmtTrigger), TRIGGERS, DEFAULT_TRIGGER),
    model: settingOf(await read($, fmtModel), MODELS, DEFAULT_MODEL),
    effort: settingOf(await read($, fmtEffort), EFFORTS, DEFAULT_EFFORT),
    billing: settingOf(await read($, fmtBilling), BILLINGS, DEFAULT_BILLING),
    keySource: settingOf(await read($, fmtKey), KEY_SOURCES, DEFAULT_KEY_SOURCE),
  }
}

// What the rows show, in the pane's order. The key row is there only while billing is `api`.
export async function settingRows($: EngineInterface): Promise<SettingRow[]> {
  const s = await settingsNow($)
  const lastReason = (await statsOf($)).last?.reason
  const keyBits = [s.keySource === 'env' ? 'from ANTHROPIC_API_KEY' : `from ${KEY_FILE_LABEL}`]
  if (lastReason && KEY_REASONS.includes(lastReason)) keyBits.push(`last: ${lastReason}`)
  const rows: SettingRow[] = [
    { id: 'trigger', key: 'opt-format-trigger', label: 'Format trigger', value: s.trigger, note: s.trigger === 'marked' ? 'only replies the orchestrator marks' : 'every eligible reply' },
    { id: 'model', key: 'opt-format-model', label: 'Format model', value: s.model, note: null },
    { id: 'effort', key: 'opt-format-effort', label: 'Format effort', value: s.effort, note: null },
    {
      id: 'billing', key: 'opt-format-billing', label: 'Format billing', value: s.billing === 'api' ? 'API key' : 'subscription',
      note: s.billing === 'api' ? "API key: billed to that key's account" : 'subscription: counts toward your plan',
    },
  ]
  if (s.billing === 'api') {
    rows.push({ id: 'key', key: 'opt-format-key', label: 'Format API key', value: s.keySource === 'env' ? 'ANTHROPIC_API_KEY' : KEY_FILE_LABEL, note: keyBits.join(' · ') })
  }
  return rows
}

const nextOf = <T extends string>(all: readonly T[], cur: T): T => all[(all.indexOf(cur) + 1) % all.length] as T

// One press: lifts a pause, moves the setting to its next value and stores it.
export async function pressSetting($: EngineInterface, id: SettingId) {
  await clearPause($)
  const s = await settingsNow($)
  let storeKey: string
  let value: string
  switch (id) {
    case 'trigger': {
      const v = nextOf(TRIGGERS, s.trigger)
      await update($, fmtTrigger, () => v)
      storeKey = OPT_TRIGGER
      value = v
      break
    }
    case 'model': {
      const v = nextOf(MODELS, s.model)
      await update($, fmtModel, () => v)
      storeKey = OPT_MODEL
      value = v
      break
    }
    case 'effort': {
      const v = nextOf(EFFORTS, s.effort)
      await update($, fmtEffort, () => v)
      storeKey = OPT_EFFORT
      value = v
      break
    }
    case 'billing': {
      const v = nextOf(BILLINGS, s.billing)
      await update($, fmtBilling, () => v)
      storeKey = OPT_BILLING
      value = v
      break
    }
    case 'key': {
      const v = nextOf(KEY_SOURCES, s.keySource)
      await update($, fmtKey, () => v)
      storeKey = OPT_KEY_SOURCE
      value = v
      break
    }
  }
  try {
    await $.store.set(storeKey, value)
  } catch {
    // This session keeps it; the next one starts from the default.
  }
}

// -- drawing -----------------------------------------------------------------------------------------

type Block = { kind: 'text'; text: string } | { kind: 'item'; text: string }

const FENCE = /^\s*(```|~~~)/
const ITEM = /^[-*]\s+(.+)$/

// A section body as bullets and text. Indented lines continue the bullet above; fences stay text.
function parseBody(body: string): Block[] {
  const blocks: Block[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    const m = inFence || FENCE.test(line) ? null : ITEM.exec(line)
    const last = blocks[blocks.length - 1]
    if (m) {
      // `**Lead-in:** explanation` stays on one line; the bold comes from the inline drawing.
      blocks.push({ kind: 'item', text: m[1] ?? '' })
    } else if (!inFence && /^\s+\S/.test(line) && last?.kind === 'item') {
      last.text += ' ' + line.trim()
    } else if (last?.kind === 'text') {
      last.text += '\n' + line
    } else if (line.trim() || inFence) {
      blocks.push({ kind: 'text', text: line })
    }
  }
  return blocks
}

// Alert cards: the row's tag picks its icon and color. The title stays the model's own words.
const CARD: Record<RowTag, { color: 'error' | 'warning' | 'permission' | 'success'; icon: string }> = {
  error: { color: 'error', icon: '✖' },
  warn: { color: 'warning', icon: '⚠' },
  note: { color: 'permission', icon: 'ℹ' },
  good: { color: 'success', icon: '✔' },
}
const SEVERITY: RowTag[] = ['error', 'warn', 'note', 'good']
const BANNER_COLOR = { act: 'error', info: 'permission', ok: 'success' } as const
const SECTION = {
  do: { color: 'error', icon: '▶' },
  ask: { color: 'success', icon: '❯' },
  more: { color: 'permission', icon: 'ℹ' },
} as const

// Titles are drawn as plain text: the model backticks identifiers in them, and a pill inside the inverse
// banner would clash. Validation reads the raw output, so only the drawing drops the marks.
const plainTitle = (t: string) => t.replace(/`([^`\n]+)`/g, '$1')

const PILL_LEFT = ''
const PILL_RIGHT = ''
const HEX = '(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}'
const IS_HEX = new RegExp(`^${HEX}$`)
const TOKEN = new RegExp('(`[^`]+`|\\*\\*[^*]+\\*\\*|\\b' + HEX + '\\b)', 'g')
const NOT_INLINE = /\[[^\]]+\]\(|^\s*(#|>|\d+\.\s|```|~~~|\|)|(^|[^*])\*[^*\s][^*]*\*([^*]|$)/m

// The tree of a rewritten reply: a banner, then titled sections and at most one panel.
export function drawParts(el: ElementTable<'terminal'>, parts: readonly Part[]) {
  const { Box, Text, Markdown } = el

  const inline = (text: string, force?: Kind): RenderChildren[] =>
    text.split(TOKEN).filter(Boolean).map((t, n) => {
      if (t.startsWith('**') && t.endsWith('**') && t.length > 4) return <Text key={`t${n}`} bold color="#ffffff">{inline(t.slice(2, -2), force)}</Text>
      const isCode = t.startsWith('`') && t.endsWith('`') && t.length > 2
      if (!isCode && !IS_HEX.test(t)) return t
      const value = isCode ? t.slice(1, -1) : t
      const kind = KINDS[(isCode && force) || kindOf(value)]
      return (
        <Text key={`t${n}`}>
          <Text color={kind.pill}>{PILL_LEFT}</Text>
          <Text color={kind.color} backgroundColor={kind.pill}>{kind.icon ? `${kind.icon} ${value}` : value}</Text>
          <Text color={kind.pill}>{PILL_RIGHT}</Text>
        </Text>
      )
    })

  // Markdown for anything richer than bold and code, so links and lists keep working.
  const rich = (text: string, force?: Kind) =>
    NOT_INLINE.test(text) ? <Markdown text={text} /> : <Text>{inline(text, force)}</Text>

  const body = (text: string, force?: Kind) => (
    <Box flexDirection="column" marginTop={1}>
      {parseBody(text).map((b, n) =>
        b.kind === 'text' ? (
          <Box key={`b${n}`}>{rich(b.text.trim(), force)}</Box>
        ) : (
          <Box key={`b${n}`} flexDirection="row">
            <Box width={2} flexShrink={0}><Text color="inactive">•</Text></Box>
            <Box flexGrow={1} flexShrink={1}>{rich(b.text, force)}</Box>
          </Box>
        ),
      )}
    </Box>
  )

  const rowDetail = (r: Row) => (r.detail.length ? <Box paddingLeft={2}>{rich(r.detail.join('\n'))}</Box> : null)

  return (
    <Box flexDirection="column">
      {parts.map((p, i) => {
        if (p.kind === 'banner') {
          return (
            <Box key={`p${i}`} marginTop={i === 0 ? 0 : 2}>
              <Text bold color="inverseText" backgroundColor={BANNER_COLOR[p.tag]}>{` ${plainTitle(p.title)} `}</Text>
            </Box>
          )
        }
        if (p.kind === 'plain') {
          return (
            <Box key={`p${i}`} marginTop={i === 0 ? 0 : 1}>
              <Markdown text={p.body} />
            </Box>
          )
        }
        if (p.kind === 'card') {
          const worst = SEVERITY.find(s => p.rows.some(r => r.tag === s)) ?? 'note'
          const border = CARD[worst].color
          return (
            <Box key={`p${i}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor={border}>
              <Text bold color={border}>{plainTitle(p.title)}</Text>
              {p.rows.map((r, n) => (
                <Box key={`p${i}r${n}`} flexDirection="column" marginTop={1}>
                  <Text bold>
                    <Text color={CARD[r.tag].color}>{`${CARD[r.tag].icon} `}</Text>
                    {inline(r.title)}
                  </Text>
                  {rowDetail(r)}
                </Box>
              ))}
            </Box>
          )
        }
        const s = SECTION[p.tag]
        return (
          <Box key={`p${i}`} flexDirection="column" marginTop={1}>
            <Text bold><Text color={s.color}>{`${s.icon} `}</Text><Text underline color="text">{plainTitle(p.title)}</Text></Text>
            {p.body ? body(p.body, p.tag === 'ask' ? 'reply' : undefined) : null}
          </Box>
        )
      })}
    </Box>
  )
}

// -- hooks -------------------------------------------------------------------------------------------

export function registerFormat(on: On) {
  // The orchestrator session is the one where the orchestrate skill loaded. After a restart nothing is
  // formatted until it loads again; the resume flow loads it.
  on('skill.prompt', { skill: SKILL }, async ($, e, next) => {
    const out = await next(e)
    if ((await read($, fmtOrch)) !== true) {
      await update($, fmtOrch, () => true)
      await registerTool($)
    }
    return out
  })

  // A /clear ends the conversation without a new session.start: forget this session's state, keep the option.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await resetSession($)
    return next(e)
  })

  // The main loop's finished reply. The work starts on a timer so this hook returns at once.
  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || (await read($, fmtOrch)) !== true) return done
    // The marker is not part of the reply: it is stripped first, and the key, the route and the source all come from the rest.
    const { marked, text } = stripMark(e.answer)
    if (route(text) === null) return done
    const seq = await update($, fmtSeq, n => (n ?? 0) + 1)
    // Every eligible reply is the session's latest, whether it is converted or not.
    await update($, fmtLatest, () => ({ key: keyOf(text), text, seq, retried: false }))
    await update($, fmtStats, s => {
      const cur = isStats(s) ? s : EMPTY_STATS
      return { ...cur, eligible: cur.eligible + 1, marked: cur.marked + (marked ? 1 : 0) }
    })
    const trigger = settingOf(await read($, fmtTrigger), TRIGGERS, DEFAULT_TRIGGER)
    if ((trigger === 'auto' || marked) && (await read($, fmtOn)) === true && (await read($, fmtRaw)) !== true && (await read($, fmtPause)) == null) {
      $.clock.after(0, () => void convert($, text, seq).catch(() => undefined))
    }
    return done
  })

  on('tool.call', { tool: FORMAT_TOOL_FULL }, async ($, e) => setFormat($, e as unknown as Record<string, unknown>))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // The marker line is never shown, in any session and on any surface; a half-written one is hidden while the reply
    // streams in an orchestrator session. A row without either is passed on untouched.
    const original = e.props.text
    const orchestrator = (await read($, fmtOrch)) === true
    const { marked, text } = stripMark(original)
    const shown = marked ? text : orchestrator && endsWithPartialMark(original) ? hidePartialMark(original) : original
    const asIs = () => (shown === original ? next(e) : next({ ...e, props: { ...e.props, text: shown } }))
    if (e.surface !== 'terminal' || e.props.isSummary) return asIs()
    if (!orchestrator || (await read($, fmtOn)) !== true || (await read($, fmtRaw)) === true) return asIs()
    const key = keyOf(text)
    if ((await readMark($, key)) === true) return asIs()
    const entry = await readEntry($, key)
    if (entry?.state !== 'done') return asIs()
    return drawParts($.ui.resolve(e), entry.parts)
  })
}
