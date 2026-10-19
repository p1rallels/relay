# relay-loop

A pi extension for deterministic continuity: nudges as a session's context fills, resets the context
in place when asked (same session id, same file, fresh context that opens with a catch-up), and an
optional keep-going loop. No model call anywhere in relay; resets are instant.

## Commands

- `bun install` — dev deps (pi + typebox are peers supplied by pi at runtime; dev copies are for types and tests)
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — unit tests plus real `AgentSession`s on pi-ai's faux provider (`test/session.test.ts`); no network, temp dirs only
- `bun run check` — both, run before every commit
- `bun run e2e [nudge|reset|loop|abort]` — real `pi` on `anthropic/claude-haiku-5-5` (override with `E2E_MODEL`), sessions in temp dirs; `E2E_KEEP=1` keeps them
- `pi -e ./src/extension.ts` — load the extension for one pi run without installing it

## Layout

- `src/core/` — pure functions, no pi imports: `steps` (nudge crossings), `state` (state folded from branch entries),
  `summary` (the reset's catch-up text), `loop` (settle and tool decisions), `request` (the human's /relay, command to reset),
  `subs` (msg's presence records: what a live sub is), `drafts` (boundary entries), `text`, `config`, `lookup`, `command`.
- `src/catchup.ts` and `src/subs.ts` — the impure helpers: find and run `lookup` with a timeout; read msg's store (read-only) for a live sub.
- `src/extension.ts` — pi adapter only: events, the `relay` tool, `/relay`, status line.

## Rules

- No module-level mutable state: pi-web runs many sessions in one Bun process with one module instance.
  Persistent state lives on the session branch and is folded from it (`stateFrom`) on every event; closure state
  is only what lives within one run: the relay call queued for its turn's end, the human's /relay from the command
  to its reset, and a loop backoff from agent_before_settle to the next agent_start.
- Every `continue: true` needs a guard. turn_end continues only right after a reset it just wrote; agent_before_settle
  continues once for a /relay that waited for the run (the request moves on, so it can't repeat), and otherwise only
  while the loop is on, no sub of the session is live, the run wasn't aborted, and the counters are under their caps (4 errors, 3 idle).
- Never special-case a mode or pi-web. The same code must work in tui, rpc, print/json and SDK sessions.
- Don't touch pi's own auto-compaction; it stays the safety net.
- Entry shapes are a contract with pi-web and lookup (see README "What relay writes"). Add fields, never rename.
- Functional style: small pure functions, early returns, no classes. Don't add comments that restate code.

## working in a pfs fork

- write only inside your fork. reads are open: other forks and the main folder are someone else's work in progress, so read them, never write there. `pfs ls` says which fork you're in (the `*`)
- commit on your branch (`pfs/<n>-…`) when `bun run check` is clean, and `bun run e2e` too when you touched resets, nudges, `/relay` or the loop. don't switch branches
- finish clean: everything worth keeping is committed before your final message. `pfs rm` lands commits and nothing else
- never delete a fork's folder by hand, yours or anyone's: `pfs rm` from the main folder is the only way out
- don't push: a fork has your credentials and the network, but the main folder reviews, merges and pushes
- forks are flat: `pfs new` fails in here. if the task needs more hands, say so in your final message
- you may have a parent: the session that started you. blocked on a decision → `msg_send` to `"parent"` with `wait_seconds`. never message other forks' agents, never acknowledge. your final message is your report: your parent gets it when you end
- `bun run check` and `bun run e2e` work in here: tests use temp dirs, and e2e runs pi with `--no-extensions -e ./src/extension.ts` in temp session dirs, so neither touches real sessions or the installed relay
- install nothing: every pi session on this machine, yours included, loads relay from the main folder. no `pi install` / `pi remove`, no edits to `~/.pi/agent/settings.json`. the main folder installs at fan-in
- don't touch `.marbles/`, and edit README.md only where the task says: the main folder does marbles at fan-in. say in your final message what else to add to the docs
