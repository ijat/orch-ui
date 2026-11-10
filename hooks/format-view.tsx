// The reply formatter's hooks and drawing. The pure core (routes, prompt, validation, pill kinds) is in
// format.ts. Display only: the transcript text never changes, so raw is a redraw of the same message.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On, RenderChildren, Timer } from 'claude-code'

import type { Billing, FmtEntry, FmtFrame, FmtLatest, FmtOrderItem, FmtStats, FmtTurn, KeySource, RouteKind, Trigger } from '../types'
import { formatCall } from './format-call'
import type { CallSeen } from './format-call'
import {
  DEFAULT_BILLING, DEFAULT_EFFORT, DEFAULT_KEY_SOURCE, DEFAULT_MODEL, EFFORTS, KINDS, MODELS, PAUSE_REASONS, endsWithPartialMark, formatOnce, hidePartialMark,
  kindOf, route, startsWithMark, startsWithPartialMark, stripMark, stripTag, tagOf, untag,
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
// The option (also kept in $.store) and what one session knows. Only the option, the settings and the `done` pages (see
// the saved outcomes, below) outlive the session.

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
const EMPTY_STATS: FmtStats = { formatted: 0, kept: 0, last: null, spentApiUsd: 0, spentPlanUsd: 0, billing: null, viaBaseUrl: false, eligible: 0, marked: 0, asked: 0 }
// A stored value of another shape reads as the empty counts.
const isStats = (s: unknown): s is FmtStats =>
  typeof s === 'object' && s !== null && ['formatted', 'kept', 'spentApiUsd', 'spentPlanUsd', 'eligible', 'marked', 'asked'].every(k => typeof (s as Record<string, unknown>)[k] === 'number')
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
// True once a hook that waited for it has read the settings from $.store into this session's atoms. A /clear gives the
// session a new id and fires no session.start, and the engine resets every atom with it: this flag goes back to false
// with the settings, which is what asks for the next load.
const fmtLoaded = atom({ plugin: 'orch-ui', key: 'fmtLoaded' } as const, false)
// The main loop's turns: `n` counts the turns that started, `at` is the start time while one runs. Set at turn.start,
// cleared at turn.complete of any reason, so a marked reply that streams in is told from an old one.
const NO_TURN: FmtTurn = { n: 0, at: null }
const fmtTurn = atom({ plugin: 'orch-ui', key: 'fmtTurn' } as const, NO_TURN)
// The placeholder's animation: advanced by the one timer, read only by a row that draws the placeholder.
const START_FRAME: FmtFrame = { i: 0, now: 0 }
const fmtFrame = atom({ plugin: 'orch-ui', key: 'fmtFrame' } as const, START_FRAME)
// Conversions claimed and not yet ended, and whether the timer runs (a mirror of the handle `ticker`, below).
const fmtPendingN = atom({ plugin: 'orch-ui', key: 'fmtPendingN' } as const, 0)
const fmtTicking = atom({ plugin: 'orch-ui', key: 'fmtTicking' } as const, false)
// Counts the changes to `held` (below), so a row that read it is drawn again when a hidden reply is complete.
const fmtHeld = atom({ plugin: 'orch-ui', key: 'fmtHeld' } as const, 0)

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

// -- conversion ------------------------------------------------------------------------------------

// The key joins the list of messages that have a valid entry, as the newest of its turn (a repeat moves it up).
const enqueue = ($: EngineInterface, key: string, seq: number) =>
  update($, fmtOrder, list => [...(Array.isArray(list) ? list : []).filter(x => x.key !== key), { key, seq }].sort((a, b) => a.seq - b.seq))

// Records one outcome: the entry, this session's counts and spend, and the last reason. `ran` is what the call
// reported once it got as far as a run (its billing, and whether a gateway is set); without it the last stays.
async function record($: EngineInterface, key: string, entry: FmtEntry, seq: number, a: { r: Route; model: string; retry: boolean; billing: Billing }, reason: string, costUsd: number, ran: CallSeen | null, paidBy?: Billing) {
  const ok = entry.state === 'done'
  // The money goes to the billing that paid for this run: what the run reported (a billing-mismatch names its payer), else the configured one; a call that never got as far as a run spent none.
  const paid = paidBy ?? (ran ? ran.billing : a.billing)
  if (ok) await enqueue($, key, seq)
  await changeEntry($, key, () => entry)
  saveDone($, key, entry)
  await update($, fmtStats, s => {
    const cur = isStats(s) ? s : EMPTY_STATS
    return {
      ...cur,
      formatted: cur.formatted + (ok ? 1 : 0),
      // a second try of a reply already counted as written is not counted twice
      kept: Math.max(0, cur.kept + (ok ? 0 : 1) - (a.retry ? 1 : 0)),
      last: { reason, kind: a.r.kind, model: a.model },
      spentApiUsd: cur.spentApiUsd + (paid === 'api' ? costUsd : 0),
      spentPlanUsd: cur.spentPlanUsd + (paid === 'api' ? 0 : costUsd),
      billing: ran ? ran.billing : cur.billing,
      viaBaseUrl: ran ? ran.viaBaseUrl : cur.viaBaseUrl,
    }
  })
}

const BILLINGS = ['api', 'subscription'] as const
const KEY_SOURCES = ['env', 'file'] as const
const settingOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)

// -- the animation timer (D3) ------------------------------------------------------------------------
// One `$.clock.every` timer advances the placeholder's frame. It runs only while something needs it: a conversion is
// pending, or a turn runs in an orchestrator session with the option on (a marked reply streaming in is drawn as the
// placeholder too). Every change of either calls syncTimer, which starts or cancels it.

const TICK_MS = 100
export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
// The handle of the running timer: at most one, and the one thing that says whether it runs. A /clear cancels it.
let ticker: Timer | null = null

// Cancels the handle, if any; a handle of an engine that is gone may refuse.
function stopTicker() {
  try {
    ticker?.cancel()
  } catch {
    // Nothing runs under it any more.
  }
  ticker = null
}

async function timerNeeded($: EngineInterface): Promise<boolean> {
  if (((await read($, fmtPendingN)) ?? 0) > 0) return true
  const turn = await read($, fmtTurn)
  return turn?.at != null && (await read($, fmtOrch)) === true && (await read($, fmtOn)) === true
}

// Starts the timer when something needs it and none runs, cancels it when nothing does. Calls overlap (a conversion ends
// as a turn starts), so after acting it looks again and goes on until the timer matches the need. The handle is the
// truth: it is looked at and made or cancelled with no await between, so two calls cannot make two timers. The atom
// `fmtTicking` only mirrors it.
async function syncTimer($: EngineInterface) {
  for (let round = 0; round < 4; round++) {
    const need = await timerNeeded($)
    const now = need ? await $.clock.now() : 0
    let started = false
    if (need && !ticker) {
      ticker = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
      started = true
    } else if (!need) {
      stopTicker()
    }
    await update($, fmtTicking, () => ticker !== null)
    if (started) await update($, fmtFrame, () => ({ i: 0, now }))
    if ((await timerNeeded($)) === need) return
  }
}

// One period: the next frame and the time.
async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, fmtFrame, f => ({ i: (f?.i ?? 0) + 1, now }))
}

async function startTurn($: EngineInterface) {
  const at = await $.clock.now()
  await update($, fmtTurn, t => ({ n: (t?.n ?? 0) + 1, at }))
  await syncTimer($)
}

async function endTurn($: EngineInterface) {
  await update($, fmtTurn, t => ({ n: t?.n ?? 0, at: null }))
  await syncTimer($)
}

// Takes the claim on a text's entry: pending, with the time (`begun`, else now). True when this call took it (no entry yet,
// or a retry of one that ended as written); that call owes a pendingEnd.
async function claimEntry($: EngineInterface, key: string, retry: boolean, begun?: number): Promise<boolean> {
  // `begun`: when the work on this reply began for the person watching (its first flush, or the start of the turn), so the
  // counter does not start again at 0 when the placeholder gives way to the pending one.
  const since = begun ?? (await $.clock.now())
  let claimed = false
  await changeEntry($, key, cur => {
    // A request may take one more try at a reply whose first try ended as written.
    claimed = cur === undefined || (retry && cur.state === 'kept')
    return claimed ? { state: 'pending', since } : (cur as FmtEntry)
  })
  if (claimed) {
    await update($, fmtPendingN, n => (n ?? 0) + 1)
    await syncTimer($)
  }
  return claimed
}

async function pendingEnd($: EngineInterface, key: string, kind: RouteKind) {
  // Whatever ended the conversion, the entry is never left pending: a run that threw ends as written.
  await changeEntry($, key, cur => (cur?.state === 'pending' ? { state: 'kept', kind, reason: 'error' } : (cur as FmtEntry)))
  await update($, fmtPendingN, n => Math.max(0, (n ?? 0) - 1))
  await syncTimer($)
}

// Asks for the rewrite of one reply (one `claude -p` call) and records the outcome. Anything that is not a valid
// rewrite leaves the original on screen and records why. `claimed` comes from a caller that took the claim already (the
// turn's end does, so the placeholder never gives way to the plain text in between); without it the claim is taken here.
async function convert($: EngineInterface, text: string, seq: number, retry = false, claimed?: boolean) {
  const source = text.trim()
  const r = route(source)
  if (!r) return
  const key = keyOf(source)

  if (claimed === undefined) {
    // Raw for the session, a switched-off option or a pause may have come in since the turn ended.
    if ((await read($, fmtRaw)) || !(await read($, fmtOn)) || (await read($, fmtPause)) != null) return
    claimed = await claimEntry($, key, retry)
  }
  if (!claimed) {
    // The same text again: its entry stands, and it becomes the newest message.
    if ((await readEntry($, key))?.state === 'done') await enqueue($, key, seq)
    return
  }

  try {
    const model = settingOf(await read($, fmtModel), MODELS, DEFAULT_MODEL)
    const effort = settingOf(await read($, fmtEffort), EFFORTS, DEFAULT_EFFORT)
    const billing = settingOf(await read($, fmtBilling), BILLINGS, DEFAULT_BILLING)
    const keySource = settingOf(await read($, fmtKey), KEY_SOURCES, DEFAULT_KEY_SOURCE)
    let ran: CallSeen | null = null
    const res = await formatOnce(source, { model, effort, kind: r.kind }, req =>
      formatCall($, req, { billing, keySource }, { seen: info => { ran = info } }))
    if (!res.ok) {
      if ((PAUSE_REASONS as readonly string[]).includes(res.reason)) await update($, fmtPause, () => res.reason)
      await record($, key, { state: 'kept', kind: r.kind, reason: res.reason }, seq, { r, model, retry, billing }, res.reason, res.costUsd, ran, res.paidBy)
      return
    }
    await record($, key, { state: 'done', kind: r.kind, parts: res.parts }, seq, { r, model, retry, billing }, 'ok', res.costUsd, ran)
  } finally {
    await pendingEnd($, key, r.kind)
  }
}

// -- the saved outcomes (D6, D7) ---------------------------------------------------------------------
// A formatted page is saved in $.store when its conversion ends `done`, so a resumed session draws it again with no model
// call. One key per reply (`fmt:<text key>`) and an index (`fmt:index`) that lists the keys oldest first, with the size of
// each; the oldest go first when there are more than 200 or more than 1 MiB of JSON in all. Only `done` is saved. Every
// store error is swallowed: a save never blocks or fails a conversion, and a load that fails leaves the replies as written.

const FMT_PREFIX = 'fmt:'
const FMT_INDEX = 'fmt:index'
const FMT_VERSION = 1
export const FMT_MAX_ENTRIES = 200
export const FMT_MAX_BYTES = 1024 * 1024
const TEXT_KEY = /^p1-[0-9a-f]{14}$/

type IndexItem = { k: string; n: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const oneOf = (v: unknown, all: readonly string[]) => isStr(v) && all.includes(v)

function isRow(r: unknown): boolean {
  return isObj(r) && oneOf(r.tag, ['error', 'warn', 'note', 'good']) && isStr(r.title) && Array.isArray(r.detail) && r.detail.every(isStr)
}
// A stored part is drawn as is, so one of another shape must not get that far.
function isPart(p: unknown): p is Part {
  if (!isObj(p)) return false
  switch (p.kind) {
    case 'banner': return oneOf(p.tag, ['act', 'ok', 'info']) && isStr(p.title)
    case 'plain': return isStr(p.body)
    case 'section': return oneOf(p.tag, ['do', 'more', 'ask']) && isStr(p.title) && isStr(p.body)
    case 'card': return isStr(p.title) && Array.isArray(p.rows) && p.rows.every(isRow)
    default: return false
  }
}

// The saved value of one `done` entry, or null for anything else (another version, state or shape).
function savedEntry(v: unknown): Extract<FmtEntry, { state: 'done' }> | null {
  if (!isObj(v) || v.v !== FMT_VERSION || v.state !== 'done' || !oneOf(v.kind, ['short', 'long'])) return null
  if (!Array.isArray(v.parts) || !v.parts.every(isPart)) return null
  return { state: 'done', kind: v.kind as RouteKind, parts: v.parts }
}

// The index, oldest first; a value of another shape or version reads as empty, and an item that is not a text key is dropped.
function readIndex(v: unknown): IndexItem[] {
  if (!isObj(v) || v.v !== FMT_VERSION || !Array.isArray(v.items)) return []
  const out: IndexItem[] = []
  for (const it of v.items) {
    if (isObj(it) && isStr(it.k) && TEXT_KEY.test(it.k) && typeof it.n === 'number' && Number.isFinite(it.n) && it.n >= 0 && !out.some(x => x.k === it.k)) out.push({ k: it.k, n: it.n })
  }
  return out
}

const sizeOf = (json: string) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : json.length)

// Keys the last load found missing or of another shape: the next save drops them from the index and deletes them.
const badKeys = new Set<string>()
// Saves go one after the other, so two conversions that end together do not write over each other's index.
let saving: Promise<unknown> = Promise.resolve()

async function saveNow($: EngineInterface, key: string, entry: Extract<FmtEntry, { state: 'done' }>) {
  const value = { v: FMT_VERSION, state: 'done', kind: entry.kind, parts: entry.parts }
  const n = sizeOf(JSON.stringify(value))
  // One page larger than the whole allowance is not saved.
  if (n > FMT_MAX_BYTES) return
  const bad = new Set(badKeys)
  badKeys.clear()
  const items = readIndex(await $.store.get(FMT_INDEX)).filter(it => it.k !== key && !bad.has(it.k))
  items.push({ k: key, n })
  const drop = new Set(bad)
  let bytes = items.reduce((sum, it) => sum + it.n, 0)
  while (items.length > 1 && (items.length > FMT_MAX_ENTRIES || bytes > FMT_MAX_BYTES)) {
    const old = items.shift() as IndexItem
    bytes -= old.n
    drop.add(old.k)
  }
  await $.store.set(FMT_PREFIX + key, value)
  await $.store.set(FMT_INDEX, { v: FMT_VERSION, items })
  const keep = new Set(items.map(it => FMT_PREFIX + it.k))
  keep.add(FMT_INDEX)
  // Everything under the prefix that the index does not list goes: what was evicted, what was found bad, what a failed save left.
  const stray = new Set([...drop].map(k => FMT_PREFIX + k))
  for (const k of await $.store.keys()) if (k.startsWith(FMT_PREFIX) && !keep.has(k)) stray.add(k)
  for (const k of stray) {
    if (keep.has(k)) continue
    try {
      await $.store.delete(k)
    } catch {
      // It goes on the next save.
    }
  }
}

function saveDone($: EngineInterface, key: string, entry: FmtEntry) {
  if (entry.state !== 'done') return
  saving = saving.then(() => saveNow($, key, entry)).catch(() => undefined)
}

// Loads the saved pages into this session's entries: one read of the index and one per entry, nothing else. An entry the
// session holds already (a conversion that ended first) stays.
async function loadSaved($: EngineInterface) {
  let items: IndexItem[]
  try {
    items = readIndex(await $.store.get(FMT_INDEX))
  } catch {
    return
  }
  for (const it of items) {
    try {
      const entry = savedEntry(await $.store.get(FMT_PREFIX + it.k))
      if (!entry) {
        badKeys.add(it.k)
        continue
      }
      await changeEntry($, it.k, cur => cur ?? entry)
    } catch {
      // This one stays as written.
    }
  }
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
  await update($, fmtLoaded, () => false)
  // No turn, no pending conversion and no timer: a conversion still running ends against a count of zero.
  stopTicker()
  await update($, fmtTicking, () => false)
  await update($, fmtPendingN, () => 0)
  await update($, fmtTurn, () => NO_TURN)
  await update($, fmtFrame, () => START_FRAME)
  // Hidden replies and their originals belong to the session that is gone.
  streams.clear()
  held.clear()
  await bumpHeld($)
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

// Reads the settings from $.store into this session's atoms. Called from register.tsx's session.start (a second
// unmatched hook on that event is refused), which does not wait for it, so that call does not count as loaded.
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
  await loadSaved($)
}

// Every hook that reads or writes a setting, and comes before any use after a /clear, calls this first: the atoms
// read their defaults then while $.store holds the user's values, and a press or a conversion from the defaults would
// overwrite the store or spend against the stored choice. While `fmtLoaded` is not true the settings are read again;
// once true it cannot undo a press, because a press writes the store too. Never throws.
export async function ensureLoaded($: EngineInterface) {
  try {
    if ((await read($, fmtLoaded)) === true) return
    await loadFormat($)
    await update($, fmtLoaded, () => true)
  } catch {
    // The atoms stay as they are; the next hook tries again.
  }
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
  // Each billing is drawn with its own total. Before any spend the last run's billing shows its $0.00.
  const money: string[] = []
  if (stats.spentApiUsd > 0) money.push(`api $${stats.spentApiUsd.toFixed(2)}`)
  if (stats.spentPlanUsd > 0) money.push(`plan $${stats.spentPlanUsd.toFixed(2)}`)
  if (money.length === 0 && stats.billing) money.push(`${stats.billing === 'api' ? 'api' : 'plan'} $0.00`)
  bits.push(...money)
  if (stats.viaBaseUrl) bits.push('via ANTHROPIC_BASE_URL')
  const pause = await read($, fmtPause)
  if (pause) bits.push(`paused: ${pause}`)
  return { on, note: bits.length ? bits.join(' · ') : null }
}

// A press with any raw state set clears it and keeps the option on; otherwise it flips the option.
export async function pressFormat($: EngineInterface) {
  await ensureLoaded($)
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
// An api run that finds no key reports no key source, which verifyRun maps to billing-mismatch, so it is listed first.
const KEY_REASONS: readonly string[] = ['billing-mismatch', 'no-credential', 'auth-failed', 'base-url-set', 'key-file-missing', 'key-file-unsafe', 'key-file-invalid']

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
  await ensureLoaded($)
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

// Nerd Font round caps (U+E0B6, U+E0B4), written as escapes: as literal private-use glyphs they were
// dropped once and 0.1.0 shipped square pills.
export const PILL_LEFT = '\ue0b6'
export const PILL_RIGHT = '\ue0b4'
const HEX = '(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}'
const IS_HEX = new RegExp(`^${HEX}$`)
const TOKEN = new RegExp('(`[^`]+`|\\*\\*[^*]+\\*\\*|\\b' + HEX + '\\b)', 'g')
const NOT_INLINE = /\[[^\]]+\]\(|^\s*(#|>|\d+\.\s|```|~~~|\|)|(^|[^*])\*[^*\s][^*]*\*([^*]|$)/m

// The rounded page a formatted reply sits on, and the placeholder before it.
const PAGE = { flexDirection: 'column', borderStyle: 'round', borderColor: 'inactive', paddingX: 2, paddingY: 1 } as const

// The placeholder of a reply that is being formatted: the same page, one line with the spinner and the whole seconds
// since the work began (`since`, or the start of the turn while the reply still streams in).
export function drawPlaceholder(el: ElementTable<'terminal'>, frame: FmtFrame, since: number | undefined) {
  const { Box, Text } = el
  const secs = since === undefined || frame.now < since ? 0 : Math.floor((frame.now - since) / 1000)
  return (
    <Box {...PAGE}>
      <Text color="inactive">{`${FRAMES[(frame.i ?? 0) % FRAMES.length]} formatting reply · ${secs}s`}</Text>
    </Box>
  )
}

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

  // The whole formatted reply sits on one rounded page, so it reads as a redraw, not as the model's text.
  return (
    <Box {...PAGE}>
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

// -- hiding a marked reply while it streams (D9-D11) ------------------------------------------------------------
// The terminal draws a streaming reply without calling the render hook, so the plain text would show until the reply
// is done. `classic.MessageDisplay` fires per batch of finished lines (flush) and what it returns is what is drawn, and
// what the committed row holds: the concatenation of the returned `displayContent`. A marked reply in an orchestrator
// session with the option on is therefore answered with one placeholder line plus an invisible tag (flush 0) and
// nothing else; the original is kept here, under the tag, and the render hook finds it again. Every other flush
// passes through untouched, and so does a flush after any error. The animated spinner starts when the row commits.

const PLACEHOLDER = `${FRAMES[0]} formatting reply`
// Progress dots after the placeholder: one per flush, the first few only, so the line never wraps.
const DOTS = 5
// How long a later flush waits for flush 0 to decide before it passes through.
const DECIDE_WAIT_MS = 2000
const STREAMS_MAX = 4000
const HELD_MAX = 200

type Stream = {
  tag: string
  // the deltas by flush index; emptied once the reply is known to be unmarked
  deltas: string[]
  // undefined until flush 0 has decided
  verdict: boolean | undefined
  decided: Promise<boolean>
  settle: (v: boolean) => void
  // when flush 0 decided to hide the reply (the clock's ms), if it did and the clock answered
  since: number | undefined
  // the final flush's index, once that flush came; flushes before it may still be on the way
  last: number | undefined
  // set once the block is finished (converted, kept, or settled as written at turn end), so it is finished once
  done: boolean
}
// Open messages by message id. Module state: the hook of one flush must see what the others did, and a flush does not wait for the one before.
const streams = new Map<string, Stream>()
// A marked reply's original under its tag: null text while it streams (or when it cannot be known), the whole text once the final flush ran.
type Held = { text: string | null; final: boolean; since: number | undefined }
const held = new Map<string, Held>()

// The tag id of a message: 8 hex characters of the hash of its message id.
const tagIdOf = (messageId: string) => textKey(messageId).slice(3, 11)

function streamOf(messageId: string): Stream {
  let m = streams.get(messageId)
  if (!m) {
    let settle!: (v: boolean) => void
    const decided = new Promise<boolean>(resolve => {
      settle = resolve
    })
    m = { tag: tagIdOf(messageId), deltas: [], verdict: undefined, decided, settle, since: undefined, last: undefined, done: false }
    streams.set(messageId, m)
    if (streams.size > STREAMS_MAX) streams.delete(streams.keys().next().value as string)
  }
  return m
}

function holdText(tag: string, h: Held) {
  held.delete(tag)
  held.set(tag, h)
  if (held.size > HELD_MAX) held.delete(held.keys().next().value as string)
}

const bumpHeld = ($: EngineInterface) => update($, fmtHeld, n => (n ?? 0) + 1).catch(() => undefined)

// Whether flush 0 hides the reply: it starts with the marker (checked first, so an unmarked reply costs no state read),
// and the session is an orchestrator one with the option on, not raw, not paused.
async function hidesReply($: EngineInterface, delta: string): Promise<boolean> {
  if (!startsWithMark(delta)) return false
  if ((await read($, fmtOrch)) !== true || (await read($, fmtOn)) !== true) return false
  return (await read($, fmtRaw)) !== true && (await read($, fmtPause)) == null
}

// The verdict of flush 0 for a later flush: at once when it is known, else after it, and `false` if it does not come.
async function verdictOf($: EngineInterface, m: Stream): Promise<boolean> {
  if (m.verdict !== undefined) return m.verdict
  let timer: Timer | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = $.clock.after(DECIDE_WAIT_MS, () => resolve(false))
  })
  try {
    return await Promise.race([m.decided, timeout])
  } finally {
    try {
      timer?.cancel()
    } catch {
      // Nothing runs under it any more.
    }
  }
}

const deltaText = (m: Stream) => m.deltas.join('')
// `every` skips the holes of a sparse array, so each index up to the final one is looked at.
const isComplete = (m: Stream, last: number) => {
  if (m.deltas.length !== last + 1) return false
  for (let i = 0; i <= last; i++) if (typeof m.deltas[i] !== 'string') return false
  return true
}

// Claims and starts the conversion of a hidden block whose original is complete. The turn's end converts the answer too,
// but finds the claim taken and does nothing (one key, one conversion). Nothing here may fail a flush.
async function startBlock($: EngineInterface, original: string, begun: number | undefined) {
  const { marked, text } = stripMark(original)
  if (!marked || route(text) === null) return
  if ((await read($, fmtRaw)) === true || (await read($, fmtOn)) !== true || (await read($, fmtPause)) != null) return
  const seq = await update($, fmtSeq, n => (n ?? 0) + 1)
  const claimed = await claimEntry($, keyOf(text), false, begun)
  $.clock.after(0, () => void convert($, text, seq, false, claimed).catch(() => undefined))
}

// Finishes a hidden block once every flush up to the final one has come, whichever flush brought the last piece. The
// check and the `done` mark run with no await before them, so two flushes can never both finish one block.
async function finishIfComplete($: EngineInterface, id: string, m: Stream) {
  if (m.done || m.last === undefined || !isComplete(m, m.last)) return
  m.done = true
  streams.delete(id)
  const original = deltaText(m)
  // This block's conversion starts now, not at the end of the turn (D12). The claim is taken before the row can draw as
  // final, so it goes from the placeholder to the pending one with nothing between.
  await startBlock($, original, m.since).catch(() => undefined)
  holdText(m.tag, { text: original, final: true, since: m.since })
  await bumpHeld($)
}

type Flush = { message_id: string; index: number; final: boolean; delta: string; agent_id?: string }

// The `displayContent` of one flush, or undefined to leave it as it is. The part before the first await runs when the
// hook is called: it files the message and its delta before any later flush can look.
async function displayOf($: EngineInterface, e: Flush): Promise<string | undefined> {
  // Only the main agent's replies are marked, and only those are redrawn.
  if (e.agent_id !== undefined) return undefined
  const m = streamOf(e.message_id)
  if (m.verdict !== false) m.deltas[e.index] = e.delta
  if (e.final) m.last = e.index
  if (e.index === 0) {
    let verdict = false
    try {
      verdict = await hidesReply($, e.delta)
      if (verdict) m.since = await $.clock.now().catch(() => undefined)
    } finally {
      m.verdict = verdict
      if (verdict) holdText(m.tag, { text: null, final: false, since: m.since })
      else m.deltas = []
      m.settle(verdict)
    }
  }
  const hidden = m.verdict ?? (await verdictOf($, m))
  if (!hidden) {
    if (e.final) streams.delete(e.message_id)
    return undefined
  }
  // A final flush that came before an earlier one leaves the block open (the row stays the placeholder): the flush that
  // fills the last hole finishes it, or the turn's end settles it as written.
  await finishIfComplete($, e.message_id, m)
  if (e.index === 0) return PLACEHOLDER + tagOf(m.tag)
  return !e.final && e.index <= DOTS ? ' .' : ''
}

// A turn that ended with a hidden block still open (its last flush, or one before a final flush that came early, never
// came): what was received is the original, so the committed row shows it as written instead of waiting for a flush
// that is not coming. Runs at every turn end, the answer included.
async function closeStreams($: EngineInterface) {
  let any = false
  for (const [id, m] of streams) {
    if (m.verdict !== true || m.done) continue
    m.done = true
    holdText(m.tag, { text: deltaText(m), final: true, since: m.since })
    streams.delete(id)
    any = true
  }
  if (any) await bumpHeld($)
}

// -- hooks -------------------------------------------------------------------------------------------

// The number of the turn each message first drew in (0: drawn while no turn ran), by its id. A row that streams in is
// born in the running turn; an old one is not. Module state, not an atom: a render cannot write one.
const BORN_MAX = 4000
const born = new Map<string, number>()
function bornIn(id: string, turn: FmtTurn): number {
  let n = born.get(id)
  if (n === undefined) {
    n = turn.at != null ? turn.n : 0
    born.set(id, n)
    if (born.size > BORN_MAX) born.delete(born.keys().next().value as string)
  }
  return n
}

export function registerFormat(on: On) {
  // The orchestrator session is the one where the orchestrate skill loaded. After a restart nothing is
  // formatted until it loads again; the resume flow loads it.
  on('skill.prompt', { skill: SKILL }, async ($, e, next) => {
    const out = await next(e)
    // Every conversion and the tool wait for this hook, so the settings they use are the stored ones.
    await ensureLoaded($)
    if ((await read($, fmtOrch)) !== true) {
      await update($, fmtOrch, () => true)
      await registerTool($)
      // The turn that loaded the skill may be the one that streams a marked reply.
      await syncTimer($)
    }
    return out
  })

  // The main loop's turn runs from here to its turn.complete: a marked reply that streams in is drawn as the placeholder.
  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) await startTurn($).catch(() => undefined)
    return out
  })

  // A turn that ends without an answer (interrupted, refused, failed) only ends the turn.
  on('turn.complete', { reason: ['aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await closeStreams($).catch(() => undefined)
      await endTurn($).catch(() => undefined)
    }
    return done
  })

  // The stream of a marked reply is hidden here (see above). Any error leaves the flush as it is.
  on('classic.MessageDisplay', async ($, e, next) => {
    let out: string | undefined
    try {
      out = await displayOf($, e)
    } catch {
      out = undefined
    }
    const base = await next(e)
    return out === undefined ? base : { ...base, displayContent: out }
  })

  // A /clear ends the conversation without a new session.start: forget this session's state, keep the option.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await resetSession($)
    return next(e)
  })

  // The main loop's finished reply. The work starts on a timer so this hook returns at once.
  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    try {
      if ((await read($, fmtOrch)) !== true) return done
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
        // The claim is taken here, before the turn is marked as ended, so the row goes from the streaming placeholder to the pending one with no plain text between.
        // Its counter keeps the time since the turn began, which is what the streaming row showed.
        const claimed = await claimEntry($, keyOf(text), false, (await read($, fmtTurn))?.at ?? undefined)
        $.clock.after(0, () => void convert($, text, seq, false, claimed).catch(() => undefined))
      }
      return done
    } finally {
      // A hidden block still open (a flush before its final one never came) is drawn as written, not left spinning.
      await closeStreams($).catch(() => undefined)
      await endTurn($).catch(() => undefined)
    }
  })

  on('tool.call', { tool: FORMAT_TOOL_FULL }, async ($, e) => setFormat($, e as unknown as Record<string, unknown>))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // The marker line is never shown, in any session and on any surface; a half-written one is hidden while the reply
    // streams in an orchestrator session. A row without either is passed on untouched.
    const rowText = e.props.text
    // A row the stream hook hid carries a tag. Its original is held under it: complete once the final flush ran, else
    // the reply is still streaming. A tag whose original is gone (a reload) is drawn as its own line, tag removed.
    const tag = untag(rowText)
    let original = rowText
    let streaming = false
    // When the work on this row began (its first flush): its counter runs from here, whatever the row is waiting for.
    let begun: number | undefined
    if (tag !== null) {
      await read($, fmtHeld)
      const h = held.get(tag)
      original = h?.final && h.text !== null ? h.text : stripTag(rowText)
      streaming = h !== undefined && !h.final
      begun = h?.since
    }
    const orchestrator = (await read($, fmtOrch)) === true
    const { marked, text } = stripMark(original)
    const shown = marked ? text : orchestrator && endsWithPartialMark(original) ? hidePartialMark(original) : original
    const asIs = () => (shown === rowText ? next(e) : next({ ...e, props: { ...e.props, text: shown } }))
    if (e.surface !== 'terminal' || e.props.isSummary) return asIs()
    if ((await read($, fmtOn)) !== true || (await read($, fmtRaw)) === true) return asIs()
    const el = $.ui.resolve(e)
    // The original is not complete yet: the placeholder, counting from the start of the turn.
    if (streaming) return drawPlaceholder(el, await read($, fmtFrame), begun ?? (await read($, fmtTurn)).at ?? undefined)
    const key = keyOf(text)
    if ((await readMark($, key)) === true) return asIs()
    const entry = await readEntry($, key)
    // A finished page is drawn whether or not the orchestrate skill has loaded in this session: a resumed transcript gets
    // its pages back before the skill does. Only a conversion of a new reply needs the skill.
    if (entry?.state === 'done') return drawParts(el, entry.parts)
    if (!orchestrator) return asIs()
    // Only a marked reply (or the first characters of one) gets the placeholder and the reason line; any other is as written.
    if (!marked && !startsWithPartialMark(original)) return asIs()
    // The original text, and one dim line saying why it is not formatted.
    const asWritten = async (reason: string) => {
      const { Box, Text } = el
      return (
        <Box flexDirection="column">
          {await asIs()}
          <Text dimColor>{`orch-ui: shown as written (${reason})`}</Text>
        </Box>
      )
    }
    if (entry?.state === 'kept') return asWritten(entry.reason)
    if (entry?.state === 'pending') return drawPlaceholder(el, await read($, fmtFrame), begun ?? entry.since)
    const pause = await read($, fmtPause)
    if (pause != null) return asWritten(`paused: ${pause}`)
    // A hidden block whose text is complete but too short or long to convert gets no claim: it is as written now, not
    // when the turn ends.
    if (tag !== null && route(text) === null) return asIs()
    // No entry: still streaming when it began in the turn that runs now. A marked reply from an earlier turn, or from before
    // this session, that never got an entry is as written; it must not spin.
    const turn = await read($, fmtTurn)
    const bornAt = bornIn(e.requestId, turn)
    if (turn.at != null && bornAt === turn.n) return drawPlaceholder(el, await read($, fmtFrame), begun ?? turn.at)
    return asIs()
  })
}
