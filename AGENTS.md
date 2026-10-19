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
  `summary` (the reset's catch-up text), `loop` (settle and tool decisions), `drafts` (boundary entries), `text`, `config`, `lookup`, `command`.
- `src/catchup.ts` — the one impure helper: finds and runs `lookup` with a timeout.
- `src/extension.ts` — pi adapter only: events, the `relay` tool, `/relay`, status line.

## Rules

- No module-level mutable state: pi-web runs many sessions in one Bun process with one module instance.
  Persistent state lives on the session branch and is folded from it (`stateFrom`) on every event; the only
  closure state is the reset queued between a relay call and its turn's end.
- Every `continue: true` needs a guard. turn_end continues only right after a reset it just wrote; agent_before_settle
  continues only while the loop is on, the run wasn't aborted, and the error/idle counters are under 3.
- Never special-case a mode or pi-web. The same code must work in tui, rpc, print/json and SDK sessions.
- Don't touch pi's own auto-compaction; it stays the safety net.
- Entry shapes are a contract with pi-web and lookup (see README "What relay writes"). Add fields, never rename.
- Functional style: small pure functions, early returns, no classes. Don't add comments that restate code.
