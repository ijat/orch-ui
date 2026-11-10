# orch-ui

A Claude Code plugin that redraws the finished replies of an [orch](https://github.com/ijat/orch) orchestrator session in a fixed layout: a colored banner with the point, what you must do, what blocks you, the rest, and the replies you can type. It is a redraw only; the transcript never changes, and sessions that did not load the `orchestrate` skill are left alone.

The code started in [orch-pane](https://github.com/ijat/orch-pane) and moved here.

Terminal only. Off by default. A reply is rewritten by one `claude -p` call, so the formatting costs money or plan usage: read **Billing** below before switching it on.

## Install

Try it for one session from a local checkout:

```
claude --plugin-dir /path/to/orch-ui
```

At the prompt of a terminal session, from the marketplace:

```
/plugin install orch-ui --marketplace ijat/orch-ui
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install orch-ui --marketplace ijat/orch-ui
```

## Use

`/orch-ui` opens the settings pane. Press a row to switch it on or off, or to move it to its next value. Every choice is kept across sessions.

| Row | Values | Default |
| --- | --- | --- |
| **Format replies** | on, off | off |
| **Format trigger** | `marked`, `auto` | `marked` |
| **Format model** | `opus`, `sonnet`, `haiku` | `opus` |
| **Format effort** | `low`, `medium`, `high` | `low` |
| **Format billing** | `API key`, `subscription` | `API key` |
| **Format API key** | `ANTHROPIC_API_KEY`, `~/.claude/settings.local.json` | `ANTHROPIC_API_KEY` (shown only while billing is `API key`) |

A setting applies from the next call. Pressing any of the five setting rows also lifts a pause (see **When it stops**).

## Format replies

In a session where the `orchestrate` skill has loaded, orch-ui redraws the agent's finished replies in a fixed layout: a colored banner with the point of the message, a titled section for what you must do, at most one bordered panel for what blocks you, sections for the rest, and the replies you can type last. Identifiers (paths, branches, commits, versions, issues, ids, URLs, commands) are drawn as small colored pills. It is a redraw only: the stored transcript never changes, and any other session is left alone, with no model call and no tool (a page saved earlier is still redrawn, see **Resume**). Terminal only.

A reply that is not marked (see below) is shown as written until its rewrite arrives, then swapped. A marked reply is never shown as plain text first. While it streams, none of its text is drawn: one line, `⠋ formatting reply`, with a dot added for each of the first few batches of lines. When the reply is complete that line gives way to a rounded page with one animated line (`⠹ formatting reply · 3s`, the spinner and the seconds since the work began) until the rewrite is ready. If the rewrite fails, or formatting is paused, the page gives way to the original text (the marker removed) with one dim line under it, `orch-ui: shown as written (<reason>)`; a reply shown raw, or with the option off, is the original text with no line. A marked reply from an earlier turn that never got a rewrite (an old transcript) is drawn as written, not as the placeholder. Only the main agent's replies are rewritten, and only when they have no code fence, no table and no banner already.

| Reply length | Output cap, time limit at `low` | at `medium` | at `high` |
| --- | --- | --- | --- |
| 300 to 2000 characters (short) | 6000 tokens, 30 s | 9000 tokens, 40 s | 18000 tokens, 80 s |
| 2001 to 5000 characters (long) | 13000 tokens, 90 s | 20000 tokens, 90 s | 38000 tokens, 150 s |

Anything shorter, longer or excluded stays as written. The model and effort are the two rows; one choice serves both lengths. A rewrite is drawn only if it keeps every id, number and backticked item of the original and invents none, offers no reply the message did not offer, and is in the layout. Anything else leaves the original on screen. The **Format replies** note shows this session's counts (formatted, as written), how many replies were marked and asked for, the last outcome with its length and model (for example `last: timeout (long/opus)`), the spend by billing (`api $0.12`, `plan $0.12`, or both, for example `api $0.02 · plan $0.04` after you switched billing in a session) and `paused: <reason>` while paused.

### Resume: finished pages come back

A page that was formatted successfully is saved in orch-ui's own store (`fmt:<key>` per reply, plus an index), so a resumed session draws it again at once, with no model call. This works whether or not the `orchestrate` skill has loaded yet; converting a new reply still needs the skill. Only finished pages are saved (a failure is not), at most 200 pages and 1 MiB of JSON in all, oldest dropped first. A saved value of another shape or version is ignored and cleaned up at the next save. `/clear` does not delete saved pages, and with **Format replies** off nothing is drawn from them. The saved text is the model's rewrite of your reply, kept locally in the plugin's store file under your Claude Code configuration directory.

### How a marked reply is hidden while it streams

The terminal draws a streaming reply without asking orch-ui, so the plain text would show until the reply is done. orch-ui therefore hooks Claude Code's `MessageDisplay` event, which fires with each batch of finished lines and decides what is drawn. In an orchestrator session with **Format replies** on (and not raw, not paused), a reply whose first line is the marker is answered with the one placeholder line and nothing else; orch-ui keeps the model's text in memory. Every other reply, every other session and a subagent's reply pass through byte for byte, and so does a batch where orch-ui hits an error, so a failure never hides text. The display only changes: the stored transcript and what the model sees are the model's own text.

The row that Claude Code commits holds the placeholder line, not the reply, and that line ends in an invisible tag (32 zero-width characters between two word joiners, U+200B, U+200C and U+2060, naming the message). The render hook reads the tag to find the kept text and draws the spinner and then the page from it; it never draws or stores the tag. Things to know:

- The kept text lives for the session: `/clear` drops it, and a plugin reload loses it, after which the row stays the placeholder line (the page for that reply is still in the store and comes back on the next resume).
- A turn that is interrupted or fails shows the lines that arrived, as written.
- A marked reply that is too short or too long for the model to rewrite is hidden while it streams and then drawn as written.
- The committed row's own text is the placeholder line with the tag, so anything that reads the row itself (a copy, an export) sees that, not the reply; the transcript keeps the reply.

### Which replies: the marker and "format that"

With **Format trigger** `marked` (the default) only replies the orchestrator marks are rewritten, which is what keeps routine chatter plain and the cost down. The mark is the first line of the reply, alone, `<!-- orch-ui -->`, so orch-ui knows from the first streamed characters (a mark on the last line, where older sessions put it, still counts). orch-ui draws that line away in every session, so it never shows, and an unmarked reply is left as written. The `orchestrate` skill tells the agent to mark a reply only while orch-ui's tool (`set_message_format`) is in its tool list, so without the plugin nothing is marked. With `auto`, every eligible reply is rewritten, marked or not.

To format a reply that was left as written, tell the agent "format that" or "show that in orch-ui". It calls `set_message_format` with `format: "formatted"`, and only the latest reply is converted: an older reply cannot be asked for. A reply whose rewrite failed is tried once more this way; one already formatted stays as it is. With the option off or formatting paused, no call is made and the agent says why.

### Raw

To read a message as written, ask the agent ("show raw", "give me unfiltered"). It calls `set_message_format` with `format: "raw"`:

- `scope: "latest"` (the default): only the newest formatted message is drawn as written; the next message is formatted again.
- `scope: "session"`: every message is drawn as written and none is rewritten, until you ask for the formatting back (`format: "formatted"`), press the **Format replies** row, or start a new session. The stored option is not changed.

Raw state is not kept: `/clear` and a new session start formatted. `/clear` also ends the orchestrator marking, so formatting resumes when the `orchestrate` skill loads again. A `/clear` resets what a session holds, so orch-ui reads your stored choices again (the option, model, effort, billing, key source, trigger) when the `orchestrate` skill loads, when you run `/orch-ui`, and before a settings press. One gap: a settings pane left open across a `/clear` draws the defaults until you press a row or reopen it with `/orch-ui`. Pressing the **Format replies** row while any message is shown raw brings the formatting back and keeps the option on; otherwise it switches the option.

## Billing

Each rewrite is one `claude -p` child run, and the **Format billing** row says what pays for it.

- `API key` (the default): the run uses an Anthropic API key, and the cost is billed to that key's account, in money. Formatting never falls back to your claude.ai login: with API billing the child runs with `--bare`, so a missing key stops formatting instead of switching to the plan.
- `subscription`: the run uses your claude.ai login and counts toward your plan's usage limits. No API key is read or sent.

The default needs the key. **Format API key** says where it comes from:

- `ANTHROPIC_API_KEY`: the variable of the session that started `claude`. orch-ui never reads it; the child inherits it. Without it the run finds no key and formatting pauses with `billing-mismatch` (the **Format API key** row shows it as `last: billing-mismatch`); set the variable before starting `claude`, or switch **Format billing** to `subscription`.
- `~/.claude/settings.local.json`: a key file in your home folder, read for each call and never kept. The key is the field `orchUi.formatApiKey`:

  ```
  { "orchUi": { "formatApiKey": "<your Anthropic API key>" } }
  ```

  Run `chmod 600 ~/.claude/settings.local.json` and never commit the file. orch-ui refuses a file that is a link, over 64 KiB, readable by group or others, or carries an ACL, a value that is not 20 to 256 printable characters, or a file with more than one `formatApiKey` (all three file reasons below). It never reads a key file on Windows.

The key file is an ordinary file that any tool in a session can open. Add `Read(~/.claude/settings.local.json)` under `permissions.deny` in `~/.claude/settings.json`. Per Claude Code's permissions documentation that rule also covers Grep, Glob and the shell file commands it recognises (`cat`, `head`, `tail`, `sed`, `tee`), on a best-effort basis, but not a script that opens the file itself.

Two environment rules apply to both sources:

- The formatter ignores a host `ANTHROPIC_AUTH_TOKEN`; the child runs with it blank.
- The file key is never sent while `ANTHROPIC_BASE_URL` is set (`base-url-set`). With the environment key, or with `subscription`, the run goes wherever that variable points, as with any `claude` started in that session; the note then adds `via ANTHROPIC_BASE_URL` and never shows the value. A Bedrock, Vertex, Foundry or similar provider setting stops every run (`cloud-provider`).

The run happens in `~/.claude/orch-ui-format`, a folder orch-ui creates, so it does not start inside your project.

### Cost

From the benchmark of 2026-11-10 (11 short and 6 long messages, measured as the CLI's `total_cost_usd`):

| Model at `low` | Short reply | Long reply | Median API time, short / long |
| --- | --- | --- | --- |
| `opus` | $0.0187 | $0.0472 | 4.7 s / 8.7 s |
| `sonnet` | $0.0091 | $0.0244 | 5.0 s / 8.3 s |
| `haiku` | $0.0013 | $0.0022 | 9.3 s / 14.3 s |

`opus` at `low` was the only cell that passed the check on every message and showed no misleading rewrite on either length; `sonnet` and `haiku` at `low` were cheaper and each had rejected rewrites or a drawn fault. Ten formatted replies in a session cost roughly $0.2 to $0.5 at the default. The **Format replies** note shows the spend of the session.

## When it stops

The first group pauses formatting for the session. The reply stays as written, no further call is made, and the note says `paused: <reason>`. Pressing any of the five setting rows, or `/clear`, lifts it.

| Reason | What it means and what to do |
| --- | --- |
| `billing-mismatch` | The run did not use the credential the **Format billing** row asks for. With `API key` billing this is also what a missing key looks like: no `ANTHROPIC_API_KEY` reached the run. Set the variable before starting `claude`, or switch **Format billing** to `subscription`, then press a row. With `subscription`, the run reported an API key where the claude.ai login was asked for (the plugin blanks `ANTHROPIC_API_KEY` for these runs, so the key came from elsewhere). Press a row; if it repeats, switch **Format billing** to `API key` or turn formatting off. The run's cost goes to the credential it reported, not the one asked for: `api $` when it used a key, `plan $` when it used none. |
| `model-mismatch` | The run answered with another model than the **Format model** row. Press a row; pick another model if it repeats. |
| `no-credential` | No credential worked and nothing was spent. With `subscription`, the child is not logged in to claude.ai: log in, then press a row. With `API key`, the key was sent but the run ended with no output, cost or status: check the key, then press a row. |
| `auth-failed` | The API refused the key (401 or 403). Replace the key. |
| `cli-missing` | The `claude` command was not found. Put it on `PATH`. |
| `cloud-provider` | A Bedrock, Vertex, Foundry or similar provider variable is set. Formatting uses Anthropic's own API only; unset it for this plugin to work. |
| `base-url-set` | The file key with `ANTHROPIC_BASE_URL` set, so the key is not sent. Unset the variable, switch **Format API key** to `ANTHROPIC_API_KEY`, or switch billing to `subscription`. |
| `workdir-failed` | `~/.claude/orch-ui-format` could not be created (no home folder, or not writable). Fix the folder's permissions. |

The rest leave that reply as written and the next reply tries again:

| Reason | What it means and what to do |
| --- | --- |
| `key-file-missing` | The key file does not exist or could not be read. Create it as shown above, or change **Format API key**. |
| `key-file-unsafe` | The key file is a link, too big, readable by others, has an ACL, or the system is Windows. `chmod 600` it, or use the environment key. |
| `key-file-invalid` | The file is not a JSON object with `orchUi.formatApiKey` once, or the value does not look like a key. |
| `rate-limited`, `overloaded`, `api-error` | The API said too many requests, busy, or another error. Try again later. |
| `timeout` | The run took longer than its limit above. Try a lower effort or a faster model. |
| `truncated` | The rewrite reached the output cap and was cut. Ask again with "format that", or lower the effort. |
| `cli-error`, `no-answer`, `cli-output`, `cli-failed` | The run failed or printed nothing usable. |
| `empty`, `no-banner`, `second-banner`, `bad-section`, `empty-title`, `bad-card`, `extra-card`, `unclosed-fence`, `bad-reply`, `error` | The rewrite was not in the layout. |
| `missing-id`, `invented-id` | The rewrite dropped an id, number or backticked item of the original, or added one. |

"Format that" tries the latest reply once more after any of these.
