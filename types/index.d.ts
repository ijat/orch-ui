
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
export type FmtStats = {
  formatted: number
  kept: number
  last: { reason: string; kind: RouteKind; model: string } | null
  // money by the billing that paid: api runs and subscription (plan) runs are kept apart
  spentApiUsd: number
  spentPlanUsd: number
  // the last run's billing; labels a $0.00 note while nothing has been spent
  billing: Billing | null
  viaBaseUrl: boolean
  // eligible replies seen, how many carried the marker, and on-request conversions (the ones the user had to ask for)
  eligible: number
  marked: number
  asked: number
}
// Which replies are converted: only the ones the orchestrator marked, or every eligible one.
export type Trigger = 'marked' | 'auto'
// The newest eligible reply of the session by turn.complete order; `retried` once a request converted it a second time.
export type FmtLatest = { key: string; text: string; seq: number; retried: boolean }

// One formatter call through a `claude -p` child (hooks/format.ts builds the argv and env and checks the stream).
// `api` is `--bare` with ANTHROPIC_API_KEY; `subscription` is the claude.ai login with the key blanked.
export type Billing = 'api' | 'subscription'
export type Effort = 'low' | 'medium' | 'high'
// Where an api run gets its key: the session's ANTHROPIC_API_KEY (inherited, never read), or the key file.
export type KeySource = 'env' | 'file'
export type CallRequest = { system: string; prompt: string; model: string; effort: string; kind: RouteKind }
// Why a call produced no text. The first group stops formatting for the session until a row is pressed.
export type CallReason =
  | 'billing-mismatch'
  | 'model-mismatch'
  | 'no-credential'
  | 'auth-failed'
  | 'cli-missing'
  | 'cloud-provider'
  | 'base-url-set'
  | 'workdir-failed'
  | 'key-file-missing'
  | 'key-file-unsafe'
  | 'key-file-invalid'
  | 'rate-limited'
  | 'overloaded'
  | 'api-error'
  | 'truncated'
  | 'cli-error'
  | 'no-answer'
  | 'cli-output'
  | 'cli-failed'
  | 'timeout'
export type CallOutcome =
  | { ok: true; text: string; costUsd: number; durationMs: number; durationApiMs: number; outputTokens: number }
  // paidBy is set where the run's own report names who paid (billing-mismatch); otherwise the configured billing paid.
  | { ok: false; reason: CallReason; costUsd: number; paidBy?: Billing }

declare module 'claude-code' {
  interface PluginState {
    'orch-ui': {
      fmtOn: boolean
      fmtOrch: boolean
      fmtRaw: boolean
      fmtSeq: number
      fmtOrder: FmtOrderItem[]
      fmtStats: FmtStats
      fmtEntries: StateFamily<FmtEntry>
      fmtMarks: StateFamily<boolean>
      fmtModel: string
      fmtEffort: string
      fmtBilling: Billing
      fmtKey: KeySource
      fmtPause: string | null
      fmtTrigger: Trigger
      fmtLatest: FmtLatest | null
      fmtLoaded: boolean
    }
  }
}
