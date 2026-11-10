# orch-ui

A Claude Code plugin that redraws the finished replies of an [orch](https://github.com/ijat/orch) orchestrator session in a fixed layout: a colored banner with the point, what you must do, what blocks you, the rest, and the replies you can type. It is a redraw only; the transcript never changes, and sessions that did not load the `orchestrate` skill are left alone.

The code started in [orch-pane](https://github.com/ijat/orch-pane) (commit b0c0f2e of its formatter branch) and moved here.

Terminal only. Off by default.

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

`/orch-ui` opens the settings pane. It holds one row, **Format replies**; press it to switch the formatting on or off. The choice is kept across sessions.

## Format replies

Off by default; switch it on with **Format replies** in the `/orch-ui` pane (kept across sessions). In a session where the `orchestrate` skill has loaded, orch-ui redraws the agent's finished replies in a fixed layout: a colored banner with the point of the message, a titled section for what you must do, at most one bordered panel for what blocks you, sections for the rest, and the replies you can type last. Identifiers (paths, branches, commits, versions, issues, ids, URLs, commands) are drawn as small colored pills. It is a redraw only: the stored transcript never changes, and any other session is left alone. Terminal only.

A reply is rewritten by one model call, and shown as written until the rewrite arrives. Only the main agent's replies are rewritten, and only when they have no code fence, no table and no banner already:

| Reply length | Model | Effort | Output cap | Time limit |
| --- | --- | --- | --- | --- |
| 300 to 2000 characters (short) | `opus` | low | 4000 tokens | 30 s |
| 2001 to 5000 characters (long) | `opus` | low | 8000 tokens | 90 s |

Anything shorter, longer or excluded stays as written. A rewrite is drawn only if it keeps every id, number and backticked item of the original and invents none, offers no reply the message did not offer, and is in the layout; a refused or failed call, a timeout, a reply cut by its cap or a rewrite that fails the check leaves the original on screen. The row's note shows this session's counts (formatted, as written) and the last outcome with its route, for example `last: timeout (long/opus)`.

To read a message as written, ask the agent ("show raw", "give me unfiltered"). It calls `set_message_format` with `format: "raw"`:

- `scope: "latest"` (the default): only the newest formatted message is drawn as written; the next message is formatted again.
- `scope: "session"`: every message is drawn as written and none is rewritten, until you ask for the formatting back (`format: "formatted"`), press the **Format replies** row in `/orch-ui`, or start a new session. The stored option is not changed.

Raw state is not kept: `/clear` and a new session start formatted. `/clear` also ends the orchestrator marking, so formatting resumes when the `orchestrate` skill loads again. Pressing the row while any message is shown raw brings the formatting back and keeps the option on; otherwise it switches the option.
