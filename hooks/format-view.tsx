// The reply formatter's hooks and drawing. The pure core (routes, prompt, validation, pill kinds) is in
// format.ts. Display only: the transcript text never changes, so raw is a redraw of the same message.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, ModelEffort, On, RenderChildren } from 'claude-code'

import type { FmtEntry, FmtOrderItem, FmtStats } from '../types'
import { FORMAT_SYSTEM, KINDS, kindOf, route, validate } from './format'
import type { Kind, Part, Route, Row, RowTag } from './format'
import { textKey } from './lib'

const SKILL = 'orchestrate'
export const FORMAT_TOOL = 'set_message_format'
export const FORMAT_TOOL_FULL = `mcp__orch-pane__${FORMAT_TOOL}`
const OPT_KEY = 'opt:format'

// -- state -----------------------------------------------------------------------------------------
// The option (also kept in $.store) and what one session knows. Nothing but the option outlives the session.

const fmtOn = atom({ plugin: 'orch-pane', key: 'fmtOn' } as const, false)
// True once the orchestrate skill has loaded in this session; /clear resets it.
const fmtOrch = atom({ plugin: 'orch-pane', key: 'fmtOrch' } as const, false)
// Raw for the whole session: every row as written, no new conversion.
const fmtRaw = atom({ plugin: 'orch-pane', key: 'fmtRaw' } as const, false)
// Counts turns that started a conversion, so the list below keeps turn.complete order, not completion order.
const fmtSeq = atom({ plugin: 'orch-pane', key: 'fmtSeq' } as const, 0)
const EMPTY_ORDER: FmtOrderItem[] = []
// The keys that received a valid entry, oldest turn first.
const fmtOrder = atom({ plugin: 'orch-pane', key: 'fmtOrder' } as const, EMPTY_ORDER)
const EMPTY_STATS: FmtStats = { formatted: 0, kept: 0, last: null }
const fmtStats = atom({ plugin: 'orch-pane', key: 'fmtStats' } as const, EMPTY_STATS)

// One entry and one raw mark per message, by the key of its text.
// The reference is written out in each call: the scan that lists what a module reads and writes needs literal
// plugin and key, and only the id may be computed.
const readEntry = ($: EngineInterface, id: string) => read($, { plugin: 'orch-pane', key: 'fmtEntries', id } as const)
const changeEntry = ($: EngineInterface, id: string, change: (cur: FmtEntry | undefined) => FmtEntry) =>
  update($, { plugin: 'orch-pane', key: 'fmtEntries', id } as const, change)
const readMark = ($: EngineInterface, id: string) => read($, { plugin: 'orch-pane', key: 'fmtMarks', id } as const)
const setMark = ($: EngineInterface, id: string, value: boolean) => update($, { plugin: 'orch-pane', key: 'fmtMarks', id } as const, () => value)

// A stored value of another shape reads as the default.
async function orderOf($: EngineInterface): Promise<FmtOrderItem[]> {
  const v = await read($, fmtOrder)
  return Array.isArray(v) ? v : EMPTY_ORDER
}
async function statsOf($: EngineInterface): Promise<FmtStats> {
  const v = await read($, fmtStats)
  return v && typeof v.formatted === 'number' && typeof v.kept === 'number' ? v : EMPTY_STATS
}

const keyOf = (text: string) => textKey(text.trim())
const PENDING: FmtEntry = { state: 'pending' }
const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 80)

// -- conversion ------------------------------------------------------------------------------------

// The key joins the list of messages that have a valid entry, as the newest of its turn (a repeat moves it up).
const enqueue = ($: EngineInterface, key: string, seq: number) =>
  update($, fmtOrder, list => [...(Array.isArray(list) ? list : []).filter(x => x.key !== key), { key, seq }].sort((a, b) => a.seq - b.seq))

// Records one outcome: the entry, this session's counts, and the last reason.
async function record($: EngineInterface, key: string, entry: FmtEntry, seq: number, r: Route, reason: string) {
  const ok = entry.state === 'done'
  if (ok) await enqueue($, key, seq)
  await changeEntry($, key, () => entry)
  await update($, fmtStats, s => {
    const cur = s && typeof s.formatted === 'number' && typeof s.kept === 'number' ? s : EMPTY_STATS
    return { formatted: cur.formatted + (ok ? 1 : 0), kept: cur.kept + (ok ? 0 : 1), last: { reason, kind: r.kind, model: r.model } }
  })
}

// Asks the route's model for the rewrite of one reply and records the outcome. Anything that is not a valid
// rewrite leaves the original on screen and records why.
async function convert($: EngineInterface, text: string, seq: number) {
  const source = text.trim()
  const r = route(source)
  if (!r) return
  const key = keyOf(source)
  const kept = (reason: string) => record($, key, { state: 'kept', kind: r.kind, reason }, seq, r, reason)

  // Raw for the session or a switched-off option may have come in since the turn ended.
  if ((await read($, fmtRaw)) || !(await read($, fmtOn))) return
  let claimed = false
  await changeEntry($, key, cur => {
    claimed = cur === undefined
    return cur ?? PENDING
  })
  if (!claimed) {
    // The same text again: its entry stands, and it becomes the newest message.
    if ((await readEntry($, key))?.state === 'done') await enqueue($, key, seq)
    return
  }

  let res
  try {
    res = await $.model.complete({
      model: r.model, effort: r.effort as ModelEffort, maxTokens: r.maxTokens, timeoutMs: r.timeoutMs,
      system: FORMAT_SYSTEM, prompt: source,
    })
  } catch (err) {
    await kept(`refused: ${firstLine(err instanceof Error ? err.message : String(err))}`)
    return
  }
  if (!res.isAnswered) {
    await kept(res.reason === 'aborted' ? 'timeout' : 'no-answer')
    return
  }
  // The API gives no stop reason: a reply that used its whole cap was cut.
  if (res.usage.output_tokens >= r.maxTokens) {
    await kept('truncated')
    return
  }
  const v = validate(source, res.text)
  if (!v.ok) {
    await kept(v.reason)
    return
  }
  await record($, key, { state: 'done', kind: r.kind, parts: v.parts }, seq, r, 'ok')
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

async function resetSession($: EngineInterface) {
  await clearRaw($)
  await update($, fmtOrch, () => false)
  await update($, fmtOrder, () => EMPTY_ORDER)
  await update($, fmtStats, () => EMPTY_STATS)
}

const OFF_TEXT = "Formatting is off in orch-pane's options (Format replies); nothing changed."

async function setFormat($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string }> {
  const format = e.format
  const scope = e.scope === undefined ? 'latest' : e.scope
  if (format !== 'raw' && format !== 'formatted') return { result: 'Refused: format must be "raw" or "formatted". Nothing changed.' }
  if (scope !== 'latest' && scope !== 'session') return { result: 'Refused: scope must be "latest" or "session". Nothing changed.' }
  if (!(await read($, fmtOrch))) return { result: 'Formatting is not active in this session (the orchestrate skill has not been loaded). Nothing changed.' }
  if (!(await read($, fmtOn))) return { result: OFF_TEXT }

  if (format === 'formatted') {
    await clearRaw($)
    return { result: 'Formatted again: the session-wide raw mode and every message shown as written are cleared (scope ignored). New and earlier formatted messages are drawn formatted.' }
  }
  if (scope === 'session') {
    await update($, fmtRaw, () => true)
    return { result: 'Scope session: every message in this session is shown as written and no new message is formatted. The stored option in orch-pane is untouched. Formatting returns on request (format "formatted"), from the Format replies row in orch-pane\'s options, or in a new session.' }
  }
  const order = await orderOf($)
  const newest = order[order.length - 1]
  if (!newest) return { result: 'No formatted message to show raw. Nothing changed.' }
  if ((await readMark($, newest.key)) === true) return { result: 'Scope latest: the newest formatted message is already shown as written. Nothing changed; the next message will be formatted again.' }
  await setMark($, newest.key, true)
  return { result: 'Scope latest: the newest formatted message is now shown as written. The next message will be formatted again. The stored option is untouched.' }
}

const FORMAT_TOOL_DESCRIPTION = 'Show orch-pane\'s formatted redraw of your replies as written, or bring the formatting back. Call it only when the user explicitly asks about the formatting '
  + '(for example "show raw", "give me unfiltered", "turn off orch-ui", "bring the formatting back"), never because something was unclear: "I don\'t get it" means explain better, not call this. '
  + 'format "raw" shows messages as written, "formatted" restores the formatting. scope "latest" (the default) affects only the newest formatted message, and the next message is formatted again; '
  + 'use it unless the user\'s words cover more than the last message. scope "session" for "turn off orch-ui", "stop formatting", "keep it raw", "for the rest of the session", "all messages". '
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
    // No tool this session; the options row still restores the formatting.
  }
}

// -- the options row ---------------------------------------------------------------------------------

// Called from register.tsx's session.start: a second unmatched hook on that event is refused.
export async function loadFormat($: EngineInterface) {
  try {
    const stored = await $.store.get(OPT_KEY)
    if (typeof stored === 'boolean') await update($, fmtOn, () => stored)
  } catch {
    // The default stays: off.
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
  if (stats.last) bits.push(`last: ${stats.last.reason} (${stats.last.kind}/${stats.last.model})`)
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
    if (e.agentId === undefined && route(e.answer) !== null) {
      if ((await read($, fmtOrch)) === true && (await read($, fmtOn)) === true && (await read($, fmtRaw)) !== true) {
        const seq = await update($, fmtSeq, n => (n ?? 0) + 1)
        const text = e.answer
        $.clock.after(0, () => void convert($, text, seq).catch(() => undefined))
      }
    }
    return done
  })

  on('tool.call', { tool: FORMAT_TOOL_FULL }, async ($, e) => setFormat($, e as unknown as Record<string, unknown>))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    if ((await read($, fmtOrch)) !== true || (await read($, fmtOn)) !== true || (await read($, fmtRaw)) === true) return next(e)
    const key = keyOf(e.props.text)
    if ((await readMark($, key)) === true) return next(e)
    const entry = await readEntry($, key)
    if (entry?.state !== 'done') return next(e)
    return drawParts($.ui.resolve(e), entry.parts)
  })
}
