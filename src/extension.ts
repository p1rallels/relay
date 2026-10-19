import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { locateLookup, runCatchup, searchCommand } from "./catchup.ts";
import { parseCommand, SUBCOMMANDS } from "./core/command.ts";
import { readConfig, type RelayConfig, SETTINGS } from "./core/config.ts";
import { humanAskDraft, loopDraft, loopOnDraft, loopStopDrafts, nudgeDraft, resetDrafts } from "./core/drafts.ts";
import { CUSTOM_TYPE, type Entry, isHandoffAsk, type LoopSwitch, TOOL_NAME, type ToolDetails, userMessages } from "./core/entries.ts";
import { launchGoalApplies, loopDecides, settleDecision, toolDecision } from "./core/loop.ts";
import { askDelivered, beforeSettleStep, commandStep, type HumanRequest, settledStep, turnStep } from "./core/request.ts";
import { type RelayState, stateFrom } from "./core/state.ts";
import { baselinePercent, dueStep } from "./core/steps.ts";
import { buildSummary } from "./core/summary.ts";
import { backoffText, requestText, statusLine, statusReport, stopReasonText, toolResultText, unknownCommandText } from "./core/text.ts";
import { hasLiveSub } from "./subs.ts";

const STATUS_KEY = "relay";

/** What a reset writes into its summary besides the session's own facts. */
interface ResetRequest {
	/** The agent's handoff note; empty when the turn that reset didn't call relay. */
	readonly note: string;
	readonly byUser: boolean;
}

const FLAG_HELP: Readonly<Record<keyof typeof SETTINGS, string>> = {
	nudgeAt: "relay: first nudge at this % of the context window (default 40)",
	nudgeEvery: "relay: nudge again every this many % (default 5)",
	maxResets: "relay: cap on resets the agent may do in a session (default none)",
	goal: "relay: keep-going loop toward this goal until the agent calls relay with done: true",
};

/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((done) => {
		if (signal?.aborted) return done();
		const finish = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});

const percentOf = (ctx: ExtensionContext): number | undefined => ctx.getContextUsage()?.percent ?? undefined;

const stateOf = (ctx: ExtensionContext): RelayState => stateFrom(ctx.sessionManager.getBranch());

const toolText = (text: string) => [{ type: "text" as const, text }];

export default function relayLoop(pi: ExtensionAPI): void {
	for (const [key, setting] of Object.entries(SETTINGS) as [keyof typeof SETTINGS, (typeof SETTINGS)[keyof typeof SETTINGS]][]) {
		pi.registerFlag(setting.flag, { type: "string", description: FLAG_HELP[key] });
	}

	// Per session (this closure) and transient: none of it outlives the run it belongs to.
	/** The relay tool's call in the current turn: the reset happens at the turn's end. */
	let queued: { readonly note: string } | undefined;
	/** The human's /relay, from the command to its reset (core/request.ts). */
	let request: HumanRequest | undefined;
	/** The loop continued after an error run: its next request waits this long, where esc can cut the wait short. */
	let backoff: number | undefined;

	const forget = (): void => {
		queued = undefined;
		request = undefined;
		backoff = undefined;
	};

	const config = (): RelayConfig => readConfig(process.env, (name) => pi.getFlag(name)).config;

	const tell = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void => {
		try {
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else process.stderr.write(`${text}\n`);
		} catch {
			// the session is going away; nothing to tell
		}
	};

	const showStatus = (ctx: ExtensionContext, percent: number | undefined, loopOn: boolean): void => {
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusLine(percent, loopOn));
		} catch {
			// pi-web disposes sessions without session_shutdown; the ctx may be stale
		}
	};

	const switchLoop = (data: LoopSwitch): void => pi.appendEntry(CUSTOM_TYPE, data);

	pi.on("session_start", (_event, ctx) => {
		forget();
		const { config: current, warnings } = readConfig(process.env, (name) => pi.getFlag(name));
		for (const warning of warnings) tell(ctx, `relay: ${warning}`, "warning");
		const state = stateOf(ctx);
		const launched = launchGoalApplies(current.goal, state);
		if (launched) switchLoop({ loop: "on", goal: current.goal, by: "launch" });
		// One process, one session: don't let tools and nested pi runs inherit the goal. pi-web (rpc) shares the env.
		if (ctx.mode !== "rpc") delete process.env[SETTINGS.goal.env];
		showStatus(ctx, percentOf(ctx), launched || state.loop.on);
	});

	pi.on("session_shutdown", () => {
		forget();
	});

	const resetDraftsFor = async (ctx: ExtensionContext, reset: ResetRequest, branch: readonly Entry[], state: RelayState, percent: number | undefined) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const lookup = locateLookup({ sessionId, sessionFile });
		const n = state.resets + 1;
		const goal = state.loop.goal;
		const summary = buildSummary({
			n,
			percent,
			sessionId,
			sessionFile,
			goal,
			userMessages: userMessages(branch),
			note: reset.note,
			byUser: reset.byUser,
			catchup: await runCatchup(lookup, sessionId),
			searchCommand: searchCommand(lookup, sessionId),
		});
		return resetDrafts({ n, percent, note: reset.note, goal, byUser: reset.byUser, summary });
	};

	const nudgeDraftFor = (ctx: ExtensionContext, state: RelayState, percent: number | undefined) => {
		const { nudgeAt, nudgeEvery } = config();
		const baseline = baselinePercent(state.baselineTokens, ctx.getContextUsage()?.contextWindow);
		const step = dueStep(percent, state.lastNudgeStep, nudgeAt, nudgeEvery, baseline);
		if (step === undefined || percent === undefined) return undefined;
		return nudgeDraft(percent, step, state.lastNudgeStep === undefined);
	};

	pi.on("turn_end", async (event, ctx) => {
		const aborted = event.outcome === "aborted" || ctx.signal?.aborted === true;
		const step = turnStep(request, queued?.note, aborted ? "aborted" : event.outcome);
		queued = undefined;
		const percent = percentOf(ctx);
		const branch = ctx.sessionManager.getBranch();
		const state = stateFrom(branch);
		if (step.reset) {
			const before = request;
			const drafts = await resetDraftsFor(ctx, step, branch, state, percent);
			// a /relay that came in while this reset was being written is this reset's too
			if (step.covered || request !== before) tell(ctx, requestText.covered());
			request = undefined;
			showStatus(ctx, undefined, state.loop.on);
			return { entries: [...event.entries, ...drafts], continue: true };
		}
		request = step.request;
		showStatus(ctx, percent, state.loop.on);
		const nudge = aborted ? undefined : nudgeDraftFor(ctx, state, percent);
		return nudge ? { entries: [...event.entries, nudge] } : undefined;
	});

	pi.on("message_end", (event) => {
		if (isHandoffAsk(event.message)) request = askDelivered(request);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.continue || event.context.pendingMessages.length > 0 || ctx.signal?.aborted === true) return undefined;
		const asked = beforeSettleStep(request);
		request = asked.request;
		if (asked.ask) return { entries: [...event.entries, humanAskDraft(percentOf(ctx))], continue: true };
		const state = stateOf(ctx);
		const liveSubs = loopDecides(state.loop, event.outcome) && (await hasLiveSub(ctx.sessionManager.getSessionId()));
		const decision = settleDecision(state.loop, event.outcome, liveSubs);
		switch (decision.action) {
			case "none":
			case "wait":
				return undefined;
			case "stop":
				showStatus(ctx, percentOf(ctx), false);
				tell(ctx, `relay loop stopped: ${stopReasonText(decision.reason)}`, "warning");
				return { entries: [...event.entries, ...loopStopDrafts(decision.reason, state.loop.goal)] };
			case "continue":
				backoff = decision.backoffMs > 0 ? decision.backoffMs : undefined;
				if (backoff !== undefined) tell(ctx, backoffText(decision.errors, backoff), "warning");
				return { entries: [...event.entries, loopDraft(state.loop.goal, decision.errors, decision.idle)], continue: true };
		}
	});

	// The backoff waits here, at the start of the continued run, not in agent_before_settle: only a running
	// agent has an abort signal, so esc ends the wait at once and the loop stops.
	pi.on("agent_start", async (_event, ctx) => {
		const wait = backoff;
		backoff = undefined;
		if (wait !== undefined) await sleep(wait, ctx.signal);
	});

	const askForHandoff = (percent: number | undefined): void => {
		const ask = humanAskDraft(percent);
		pi.sendMessage({ customType: ask.customType, content: ask.content, display: ask.display, details: ask.details }, { triggerTurn: true });
	};

	pi.on("agent_settled", (event, ctx) => {
		queued = undefined;
		backoff = undefined;
		const state = stateOf(ctx);
		const percent = percentOf(ctx);
		if (event.aborted && state.loop.on) {
			switchLoop({ loop: "off", reason: "aborted" });
			tell(ctx, "relay loop off: the run was aborted. /relay on resumes it.", "warning");
		}
		showStatus(ctx, percent, state.loop.on && !event.aborted);
		const step = settledStep(request, event.aborted);
		request = step.request;
		switch (step.action) {
			case "none":
				return;
			case "ask":
				// the run's last boundary didn't ask (pi skipped it): start a turn for it, which pi defers until settled
				return askForHandoff(percent);
			case "aborted":
				return tell(ctx, requestText.aborted(), "warning");
			case "failed":
				return tell(ctx, requestText.failed(), "warning");
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Relay",
		description: [
			"Hand off and reset your context in place: same session, same file, a fresh context.",
			"Call it when a [relay] message nudges you, or when the user asks, at a clean checkpoint (the step you were on is finished and committed).",
			"note: the handoff for whoever picks this up after the reset (that's you, without your current context): what's done, what's next, gotchas, where things are (files, branches, commands).",
			"The reset happens as soon as this turn's tool calls finish; you then continue with a fresh context that opens with the goal, the user's messages, your note and the recent conversation.",
			"done: true instead ends a [relay loop] when its goal is completely done (or you can't go on without a human): no reset, the note is your final word.",
		].join("\n"),
		promptSnippet: "relay: hand off at a clean checkpoint and reset your context in place when relay nudges you (same session, fresh context)",
		promptGuidelines: [
			"[relay] and [relay loop] messages come from the relay extension, not the user. When one says you're at N% of your context, finish the step you're on, commit, and call relay with a handoff note.",
			"When a [relay loop] message asks you to keep going, do the next step toward its goal; call relay with done: true only when the goal is completely done or blocked on a human.",
		],
		parameters: Type.Object({
			note: Type.String({ description: "Handoff for whoever continues after the reset: what's done, what's next, gotchas, where things are" }),
			done: Type.Optional(Type.Boolean({ description: "The relay loop's goal is completely done (or blocked on a human): end the loop instead of resetting" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const note = params.note.trim();
			const state = stateOf(ctx);
			const decision = toolDecision(params.done === true, queued !== undefined, state, config());
			const result = (text: string, details: ToolDetails) => ({ content: toolText(text), details });
			switch (decision.outcome) {
				case "duplicate":
					return result(toolResultText.duplicate(), { outcome: "duplicate" });
				case "done":
					showStatus(ctx, percentOf(ctx), false);
					return result(toolResultText.done(decision.loopWasOn), { outcome: "done", ...(note ? { note } : {}) });
				case "capped":
					showStatus(ctx, percentOf(ctx), false);
					return result(toolResultText.capped(decision.max), { outcome: "capped", ...(note ? { note } : {}) });
				case "queued":
					if (note === "") throw new Error("note is empty: write what's done, what's next, gotchas and where things are, then call relay again");
					queued = { note };
					return result(toolResultText.queued(decision.n), { outcome: "queued", note, n: decision.n });
			}
		},
	});

	pi.registerCommand("relay", {
		description: "relay: /relay resets the context (after the agent's run, if it's working) · /relay on [goal] · /relay off · /relay status",
		getArgumentCompletions: (prefix) => {
			const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const command = parseCommand(args);
			const state = stateOf(ctx);
			const percent = percentOf(ctx);
			switch (command.kind) {
				case "status": {
					const usage = ctx.getContextUsage();
					const report = statusReport({
						sessionId: ctx.sessionManager.getSessionId(),
						percent,
						contextWindow: usage?.contextWindow,
						baselinePercent: baselinePercent(state.baselineTokens, usage?.contextWindow),
						state,
						config: config(),
						request,
					});
					tell(ctx, report);
					return;
				}
				case "off": {
					if (!state.loop.on) return tell(ctx, "relay loop is already off");
					switchLoop({ loop: "off", reason: "user" });
					showStatus(ctx, percent, false);
					return tell(ctx, "relay loop off: the agent stops when it next would");
				}
				case "on": {
					const goal = command.goal ?? state.loop.goal;
					switchLoop({ loop: "on", ...(goal === undefined ? {} : { goal }), by: "user" });
					showStatus(ctx, percent, true);
					if (!ctx.isIdle()) return tell(ctx, "relay loop on: when the agent would stop, it's asked to keep going toward the goal");
					const kickoff = loopOnDraft(goal);
					pi.sendMessage({ customType: kickoff.customType, content: kickoff.content, display: kickoff.display, details: kickoff.details }, { triggerTurn: true });
					return;
				}
				case "unknown":
					return tell(ctx, unknownCommandText(command.text), "warning");
				case "reset": {
					const step = commandStep(request, !ctx.isIdle());
					request = step.request;
					switch (step.action) {
						case "duplicate":
							return tell(ctx, requestText.duplicate(step.request));
						case "wait":
							return tell(ctx, requestText.waiting());
						case "ask":
							askForHandoff(percent);
							return tell(ctx, requestText.asked());
					}
				}
			}
		},
	});
}
