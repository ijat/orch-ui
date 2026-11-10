
// The reply formatter's rewrite as parts (hooks/format.ts parses it), which route took the reply, and the
// per-message entry (by the key of the reply's text), the keys that received a valid
// entry in turn order, and this session's counts with the last outcome.
export type RouteKind = 'short' | 'long'
export type BannerTag = 'act' | 'ok' | 'info'
export type RowTag = 'error' | 'warn' | 'note' | 'good'
export type SectionTag = 'do' | 'more' | 'ask'
export type Row = { tag: RowTag; title: string; detail: string[] }
export type Part =
  | { kind: 'banner'; tag: BannerTag; title: string }
  | { kind: 'plain'; body: string }
  | { kind: 'section'; tag: SectionTag; title: string; body: string }
  | { kind: 'card'; title: string; rows: Row[] }
export type FmtEntry =
  | { state: 'pending' }
  | { state: 'done'; kind: RouteKind; parts: Part[] }
  | { state: 'kept'; kind: RouteKind; reason: string }
export type FmtOrderItem = { key: string; seq: number }
export type FmtStats = { formatted: number; kept: number; last: { reason: string; kind: RouteKind; model: string } | null }

declare module 'claude-code' {
  interface PluginState {
    'orch-pane': {
      fmtOn: boolean
      fmtOrch: boolean
      fmtRaw: boolean
      fmtSeq: number
      fmtOrder: FmtOrderItem[]
      fmtStats: FmtStats
      fmtEntries: StateFamily<FmtEntry>
      fmtMarks: StateFamily<boolean>
    }
  }
}
