# relay-loop

Deterministic continuity for [pi](https://github.com/earendil-works/pi) sessions.

When a session's context gets big, the agent gets nudged. When it asks (or you do), the session resets
**in place**: same session id, same file, same pi-web tab, and a fresh context that opens with a catch-up.
No LLM summarization, no waiting. Optionally, it keeps the agent going until a goal is done.

```
pi install /path/to/relay
```

## How it works

**Nudges.** At the end of each turn relay reads `ctx.getContextUsage()`. When usage crosses 40% of the
model's context window, and then every further 5% (45, 50, 55, …), it appends a visible `[relay]` message:
you're at N%; finish the step you're on, commit, and call `relay` with a note. One nudge per step; the steps
start over after any compaction, and steps the context had already passed right after it (its first response)
count as nudged, so a fresh context that starts big (small window, long summary) isn't sent straight back.
Relay never resets on its own, and pi's own auto-compaction near the window limit stays the last-resort safety net.

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

**Reply first.** Nothing comes after a `relay` call in the old context, so the tool's description tells the agent
to put anything you should read (an answer, a report) in its text before the call; the note is a handoff, not a reply.
If the agent wrote no text at all after your last message (it only ran tools, or called `relay` right away), the
reset message ends with `the user hasn't seen a reply to their last message (#n): you wrote them nothing after it
before the reset.`, so the fresh context knows it still owes you one.

**Queued messages survive a reset.** What arrives while the agent is in the turn that resets (your steers
and follow-ups, msg's messages, which it delivers as steers) stays queued past the reset and lands in the
fresh context right after the reset message, in pi's usual order: steers first, one per turn, in the order
they came, then follow-ups once the agent would stop. The agent answers each there. What arrived earlier in
the run was answered before the reset, and the summary carries it (your messages verbatim, msg's in lookup's catch-up).

**`/relay`, for you.**

| command | does |
|---|---|
| `/relay` | reset the context: the agent is asked to call `relay` with its handoff note, and the context resets at the end of that turn either way. It never cuts a run off: sent while the agent works, it waits for the run to end (with the loop on: for the point where the loop would prompt), then asks. If the agent resets on its own meanwhile (a nudge), that reset is yours too and nothing more happens. Esc drops it and says so; a second `/relay` is the same request. |
| `/relay <text>` | resets nothing: answers `did you mean /relay on <text>? (/relay alone resets the context)`. |
| `/relay on [goal]` | turn the loop on (no goal: the previous one, else the session's first message). Idle: starts working right away. |
| `/relay off` | turn the loop off; the agent stops when it next would. |
| `/relay status` | usage, next nudge, resets, a `/relay` on its way, loop state, session id. |

**The loop (opt-in).** While it's on, each time the agent is about to settle (`agent_before_settle`), relay
appends a `[relay loop]` message (keep going toward the goal; when it's completely done, call relay with
`done: true`) and continues. It stops on:

- `relay({ done: true })`
- esc / abort (and stays off until `/relay on`)
- `/relay off`
- 4 error runs in a row. Each already includes pi's own retries of the provider call (3 tries from a 2 s
  delay); after the 1st, 2nd and 3rd, the loop waits 1 min, 5 min, then 15 min before its next request, about
  20 minutes of patience on top of pi's. The wait is at the start of that request, where esc stops the loop at once.
- 3 loop prompts in a row answered without a single tool call (a stalled agent)
- the reset cap, when one is set and the agent asks for one more reset

**The loop waits for live subs.** A parent ends its turn while its subs (pi runs started from its bash,
pfs forks) work, and msg wakes it when one asks, reports or dies. So while the session has a live sub, the
loop doesn't prompt and counts nothing, neither a stall nor an error. A live sub is a msg presence record
naming this session as its parent, with no `endedAt`, a heartbeat under 45 s old and a running pid. Relay reads
msg's store read-only (`$PI_MSG_DIR`, else `$PI_CODING_AGENT_DIR/msg`, else `~/.pi/agent/msg`): one readdir of
`sessions/`, and only the records rewritten in the last 45 s, and only when the loop is on and would act.

In `pi -p`, the loop keeps the run alive; the process exits normally once the loop ends.

**Status line** (when there's a UI): `relay · 43%`, plus `· loop` when the loop is on.

## Config

The one place to set things is `~/.pi/agent/extensions/relay-loop/config.json` (under `$PI_CODING_AGENT_DIR`
when that's set; `PI_RELAY_CONFIG` points elsewhere). pi doesn't load it as an extension, since the folder
has no `index.ts`. Relay reads it at every check, so edits apply from the next turn without a restart, and a
`/model` switch picks up that model's rule.

```json
{
  "nudgeAt": 40,
  "nudgeEvery": 5,
  "maxResets": 10,
  "rules": [
    { "model": "openrouter/*", "window": "1m", "nudgeAt": 50 },
    { "window": "1m", "nudgeAt": 40 },
    { "window": "272k", "nudgeAt": 95, "nudgeEvery": 2 }
  ]
}
```

Every field is optional. Rules are checked top-down and the first match wins. A rule matches when all of
its matchers hold: `model` is a glob (`*`, case-insensitive) on `provider/id` or `id`, and `window` is the
model's context window in tokens (`272000`, `"272k"`, `"1m"`), within ±10% so `"1m"` also covers
1,048,576 and 1,050,000. The same id can have different windows on different providers (`gpt-5.5` is 272k
on `openai-codex`, 1.05M on openrouter), which `window` tells apart. A matched rule sets `nudgeAt` and/or
`nudgeEvery`; the ones it leaves out come from the top level, then the defaults. Bad JSON, unknown keys
and bad values are ignored with a warning at session start and in `/relay status`, which also names the
rule that applied.

The environment and flags override the file for one process (tests, headless runs):

| env | flag | default |
|---|---|---|
| `PI_RELAY_NUDGE_AT` | `--relay-nudge-at` | `40` (% of the context window; decimals ok) |
| `PI_RELAY_NUDGE_EVERY` | `--relay-nudge-every` | `5` |
| `PI_RELAY_MAX_RESETS` | `--relay-max-resets` | no cap (`0` allows none) |
| `PI_RELAY_GOAL` | `--relay-goal` | loop off |

Flags win over the environment, which wins over the file and its rules. The launch goal turns the loop on at session start for headless runs
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
  `byUser: true` (a reset you asked for with `/relay`, the agent's own included when it came while your `/relay`
  waited, or the nudge asking the agent for its note). `percent` is floored to a tenth. A reset's `note` is
  always the agent's handoff note; it's absent when the turn that reset for a `/relay` didn't call `relay`.
- **a compaction** on each reset: retain-none (`firstKeptEntryId` is its own id), `fromHook: true`,
  `details: { relay: { n, percent?, note?, goal? } }`.
- **custom entries** `customType: "relay"` (invisible to the model), the loop switch:
  `{ loop: "on", goal?, by: "user" | "launch" }` or `{ loop: "off", reason: "user" | "aborted" | "errors" | "stalled" }`.
  `done` and the cap are read from the relay tool result's `details.outcome` (`queued | duplicate | done | capped`).

## Caveats

- `/relay` costs one request on the full context (the agent writes its note), after the run when the agent is working.
- `/relay off` during an error backoff lets the waiting request go out first; esc stops it at once.
- A `/relay` that waits for a run, and a backoff's wait, live in the session's process: pi-web disposing the
  session, or a restart, drops them (the run ends with it).
- Without a session file (`--no-session`) the summary can't include lookup's catch-up and says so.
- The steps also start over after pi's own compactions, since the context shrank.

## Development

See [AGENTS.md](AGENTS.md). `bun run check` before every commit; `bun run e2e` for the real-model scenarios.

MIT
