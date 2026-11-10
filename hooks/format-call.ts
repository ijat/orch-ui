// One formatter call as a `claude -p` child (D26). The only module that reads the API key file and the only
// one that decides, with format.ts's cliArgs/cliEnv/verifyRun, which credential pays. The key is a local
// variable for the length of one call: never logged, stored, put in argv or stdin, or echoed in a reason.
import type { EngineInterface } from 'claude-code'

import type { Billing, CallOutcome, CallReason, CallRequest, KeySource } from '../types'
import { cliArgs, cliEnv, keyFileAclFree, keyFileModeOk, keyFileNeedsAclCheck, limits, parseKeyFile, verifyRun } from './format'

// The settings one call needs, read by the caller from its atoms.
export type CallSettings = { billing: Billing; keySource: KeySource }
// What the caller learns about the call beyond its outcome. Called once, after the checks that need no run.
export type CallSeen = { billing: Billing; viaBaseUrl: boolean }
export type CallOptions = { seen?: (info: CallSeen) => void }

const fail = (reason: CallReason): CallOutcome => ({ ok: false, reason, costUsd: 0 })

const KEY_FILE_MAX_BYTES = 65536
const LS_TIMEOUT_MS = 5000
// A call that was killed at its limit rejects a little before the clock shows the full limit.
const TIMEOUT_SLACK_MS = 250

// The neutral working directory (D38): under the user's own home, never TMPDIR, TEMP or /tmp.
async function workDir($: EngineInterface): Promise<string | null> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const home = windows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  if (!home) return null
  const dir = `${home.replace(/\\/g, '/')}/.claude/orch-ui-format`
  try {
    await $.fs.write(`${dir}/.keep`, '')
  } catch {
    return null
  }
  return dir
}

// Reads the key of `~/.claude/settings.local.json` (D28) after the file checks of D29 K4. Nothing is kept.
async function readKeyFile($: EngineInterface): Promise<{ ok: true; key: string } | { ok: false; reason: CallReason }> {
  // The mode check below reads `ls -ln`; Windows has no such mode to check, so it never reads a key file.
  if ((await $.env.get('OS')) === 'Windows_NT') return { ok: false, reason: 'key-file-unsafe' }
  const home = await $.env.get('HOME')
  if (!home) return { ok: false, reason: 'key-file-missing' }
  const path = `${home}/.claude/settings.local.json`
  let st
  try {
    st = await $.fs.stat(path)
  } catch {
    return { ok: false, reason: 'key-file-missing' }
  }
  if (st.kind !== 'file' || st.isLink || st.size > KEY_FILE_MAX_BYTES) return { ok: false, reason: 'key-file-unsafe' }
  try {
    const ls = await $.process.run(['ls', '-ln', '--', path], { timeoutMs: LS_TIMEOUT_MS })
    if (!keyFileModeOk(ls.stdout, ls.exitCode)) return { ok: false, reason: 'key-file-unsafe' }
    // macOS prints `@` instead of `+` when the file has extended attributes, which hides an ACL: look again.
    if (keyFileNeedsAclCheck(ls.stdout)) {
      const acl = await $.process.run(['ls', '-led', '--', path], { timeoutMs: LS_TIMEOUT_MS })
      if (!keyFileAclFree(acl.stdout, acl.exitCode)) return { ok: false, reason: 'key-file-unsafe' }
    }
  } catch {
    return { ok: false, reason: 'key-file-unsafe' }
  }
  let text: unknown
  try {
    text = await $.fs.read(path)
  } catch {
    return { ok: false, reason: 'key-file-missing' }
  }
  if (typeof text !== 'string') return { ok: false, reason: 'key-file-invalid' }
  return parseKeyFile(text)
}

// Runs one call and returns its checked outcome. Never throws.
export async function formatCall($: EngineInterface, req: CallRequest, settings: CallSettings, opts: CallOptions = {}): Promise<CallOutcome> {
  try {
    // 1. Cloud providers: "api" and "subscription" both mean Anthropic's own API (D27). The names are literals: the six third-party provider flags the CLI itself tests.
    if (await $.env.get('CLAUDE_CODE_USE_BEDROCK')) return fail('cloud-provider')
    if (await $.env.get('CLAUDE_CODE_USE_VERTEX')) return fail('cloud-provider')
    if (await $.env.get('CLAUDE_CODE_USE_FOUNDRY')) return fail('cloud-provider')
    if (await $.env.get('CLAUDE_CODE_USE_ANTHROPIC_AWS')) return fail('cloud-provider')
    if (await $.env.get('CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD')) return fail('cloud-provider')
    if (await $.env.get('CLAUDE_CODE_USE_MANTLE')) return fail('cloud-provider')

    // 2. A gateway under the file key would receive the key, so that run does not start; the value is only
    // ever tested for non-empty (a URL can carry credentials).
    const viaBaseUrl = !!(await $.env.get('ANTHROPIC_BASE_URL'))
    const fromFile = settings.billing === 'api' && settings.keySource === 'file'
    if (fromFile && viaBaseUrl) return fail('base-url-set')
    opts.seen?.({ billing: settings.billing, viaBaseUrl })

    // 3. The env. api + file: the file's key. api + env: none, the child inherits the session's.
    // subscription: the key is blanked. cliEnv adds ANTHROPIC_AUTH_TOKEN '' in every mode.
    const lim = limits(req.kind, req.effort)
    let key: string | undefined
    if (fromFile) {
      const k = await readKeyFile($)
      if (!k.ok) return fail(k.reason)
      key = k.key
    }
    let argv: string[]
    let env: Record<string, string>
    try {
      argv = cliArgs({ model: req.model, effort: req.effort, system: req.system, billing: settings.billing })
      env = cliEnv({ billing: settings.billing, maxTokens: lim.maxTokens, key })
    } catch {
      return fail('cli-failed')
    }
    key = undefined

    // 4. The working directory.
    const cwd = await workDir($)
    if (cwd === null) return fail('workdir-failed')

    // 5. The run. A rejection is told apart by the elapsed time; its message is matched for ENOENT only.
    const t0 = await $.clock.now()
    let ran
    try {
      ran = await $.process.run(['claude', ...argv], { cwd, env, stdin: req.prompt, timeoutMs: lim.timeoutMs })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/ENOENT|not found|no such file/i.test(message)) return fail('cli-missing')
      return fail((await $.clock.now()) - t0 >= lim.timeoutMs - TIMEOUT_SLACK_MS ? 'timeout' : 'cli-failed')
    }

    // 6. stderr is never read.
    if (ran.isStdoutTruncated) return fail('cli-output')
    return verifyRun(ran.stdout, { billing: settings.billing, model: req.model, maxTokens: lim.maxTokens })
  } catch {
    return fail('cli-failed')
  }
}
