# relay-loop

Deterministic continuity for [pi](https://github.com/earendil-works/pi) sessions.

When a session's context gets big, the agent gets nudged. When it asks (or you do), the session resets
**in place**: same session id, same file, same pi-web tab, and a fresh context that opens with a catch-up.
No LLM summarization, no waiting. Optionally, it keeps the agent going until a goal is done.

```
pi install ~/Desktop/cc/relay-loop
```

## How it works

**Nudges.** At the end of each turn relay reads `ctx.getContextUsage()`. When usage crosses 40% of the
model's context window, and then every further 5% (45, 50, 55, …), it appends a visible `[relay]` message:
you're at N%; finish the step you're on, commit, and call `relay` with a note. One nudge per step; the steps
start over after any compaction. Relay never resets on its own, and pi's own auto-compaction near the window
limit stays the last-resort safety net.

**The `relay` tool.** `relay({ note })` queues a reset for the end of the current turn. Then, at that
`turn_end` boundary, relay appends a retain-none compaction (pi records its own id as `firstKeptEntryId`) and
a `[relay]` reset message, and continues the run. The next request carries only the system prompt, the
compaction summary and that message. The summary is plain text built by a pure function:

- `context reset #n at N%, in place: this is still session <id>; everything before is in its file (<path>)`
- the goal (from `/relay on`, else the session's first user message)
- the user's messages, verbatim, oldest first (newest win past 16k chars)
- the handoff note
- `lookup --root <session folder> catchup <id> -n 30` (lookup on PATH, else `~/.cargo/bin/lookup`; 10 s timeout; if it fails, the command to run instead)
- `go deeper: lookup --root <folder> search '<term>' --session <id>` and `before you continue: git status, git log --oneline -5, mb ready`

One reset per turn: a second `relay` call in the same turn does nothing and says so.
`relay({ note, done: true })` ends a loop instead (see below): no reset, and the note is the agent's final word.

**`/relay`, for you.**

| command | does |
|---|---|
| `/relay [note]` | reset now. Busy: at the end of the current turn, with your note. Idle: starts a turn asking the agent to call `relay` with its note (yours is appended), and resets at the end of that turn either way. |
| `/relay on [goal]` | turn the loop on (no goal: the previous one, else the session's first message). Idle: starts working right away. |
| `/relay off` | turn the loop off; the agent stops when it next would. |
| `/relay status` | usage, next nudge, resets, loop state, session id. |

**The loop (opt-in).** While it's on, each time the agent is about to settle (`agent_before_settle`), relay
appends a `[relay loop]` message (keep going toward the goal; when it's completely done, call relay with
`done: true`) and continues. It stops on:

- `relay({ done: true })`
- esc / abort (and stays off until `/relay on`)
- `/relay off`
- 3 error outcomes in a row (it waits 5 s, then 15 s, between them)
- 3 loop prompts in a row answered without a single tool call (a stalled agent)
- the reset cap, when one is set and the agent asks for one more reset

In `pi -p`, the loop keeps the run alive; the process exits normally once the loop ends.

**Status line** (when there's a UI): `relay · 43%`, plus `· loop` when the loop is on.

## Config

| env | flag | default |
|---|---|---|
| `PI_RELAY_NUDGE_AT` | `--relay-nudge-at` | `40` (% of the context window; decimals ok) |
| `PI_RELAY_NUDGE_EVERY` | `--relay-nudge-every` | `5` |
| `PI_RELAY_MAX_RESETS` | `--relay-max-resets` | no cap (`0` allows none) |
| `PI_RELAY_GOAL` | `--relay-goal` | loop off |

Flags win over the environment. The launch goal turns the loop on at session start for headless runs
(`PI_RELAY_GOAL="…" pi -p "…"`, pfs subs). Relay removes `PI_RELAY_GOAL` from the environment once it has
read it (except in rpc mode, where pi-web shares one process), so tools and nested `pi` runs don't inherit
the parent's goal. Resuming a session with the same launch goal keeps what the branch says: a loop that
finished stays finished; a different goal starts a new loop.

## What relay writes

Everything is on the session branch, and relay's state (reset count, last nudge step, loop on/off, goal,
error and idle counters) is folded back from it on every event, so a resume or a pi-web re-attach picks up
where it was.

- **custom messages** `customType: "relay"`, `display: true`, the model-facing text in `content`, and
  `details: { kind: "nudge" | "reset" | "loop", percent?, n?, note?, goal? }` plus these extras:
  `step` (nudge), `errors` and `idle` (loop prompt), `stopped: "errors" | "stalled"` (the loop ended here),
  `byUser: true` (a `/relay` reset, or the nudge asking the agent for its note). `percent` is floored to a tenth.
- **a compaction** on each reset: retain-none (`firstKeptEntryId` is its own id), `fromHook: true`,
  `details: { relay: { n, percent?, note?, goal? } }`.
- **custom entries** `customType: "relay"` (invisible to the model), the loop switch:
  `{ loop: "on", goal?, by: "user" | "launch" }` or `{ loop: "off", reason: "user" | "aborted" | "errors" | "stalled" }`.
  `done` and the cap are read from the relay tool result's `details.outcome` (`queued | duplicate | done | capped`).

## Caveats

- An esc during the loop's error backoff takes effect when the backoff ends (at most 15 s): pi gives a
  settling run no abort signal to listen to. The continuation is dropped either way.
- `/relay` while idle costs one request on the full context (the agent writes its note); while busy it costs nothing.
- Without a session file (`--no-session`) the summary can't include lookup's catch-up and says so.
- The steps also start over after pi's own compactions, since the context shrank.

## Development

See [AGENTS.md](AGENTS.md). `bun run check` before every commit; `bun run e2e` for the real-model scenarios.

MIT
