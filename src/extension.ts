import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { locateLookup, runCatchup, searchCommand } from "./catchup.ts";
import { parseCommand, SUBCOMMANDS } from "./core/command.ts";
import { readConfig, type RelayConfig, SETTINGS } from "./core/config.ts";
import { humanAskDraft, loopDraft, loopOnDraft, loopStopDrafts, nudgeDraft, resetDrafts } from "./core/drafts.ts";
import { CUSTOM_TYPE, type LoopSwitch, TOOL_NAME, type ToolDetails, userMessages } from "./core/entries.ts";
import { launchGoalApplies, settleDecision, toolDecision } from "./core/loop.ts";
import { type RelayState, stateFrom } from "./core/state.ts";
import { dueStep } from "./core/steps.ts";
import { buildSummary } from "./core/summary.ts";
import { statusLine, statusReport, stopReasonText, toolResultText } from "./core/text.ts";

const STATUS_KEY = "relay";

/** A reset asked for in this turn (relay tool or /relay); it happens at the turn's end. */
interface PendingReset {
	readonly note: string;
	readonly byUser: boolean;
	/** The agent called relay this turn: a further call is a no-op. */
	readonly agentCalled: boolean;
}

const FLAG_HELP: Readonly<Record<keyof typeof SETTINGS, string>> = {
	nudgeAt: "relay: first nudge at this % of the context window (default 40)",
	nudgeEvery: "relay: nudge again every this many % (default 5)",
	maxResets: "relay: cap on resets the agent may do in a session (default none)",
	goal: "relay: keep-going loop toward this goal until the agent calls relay with done: true",
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const percentOf = (ctx: ExtensionContext): number | undefined => ctx.getContextUsage()?.percent ?? undefined;

const stateOf = (ctx: ExtensionContext): RelayState => stateFrom(ctx.sessionManager.getBranch());

const toolText = (text: string) => [{ type: "text" as const, text }];

const mergeNotes = (agentNote: string, earlier: PendingReset | undefined): string => {
	const human = earlier?.byUser ? earlier.note.trim() : "";
	return human === "" ? agentNote : `${agentNote}\n\nthe human's note with /relay: ${human}`;
};

export default function relayLoop(pi: ExtensionAPI): void {
	for (const [key, setting] of Object.entries(SETTINGS) as [keyof typeof SETTINGS, (typeof SETTINGS)[keyof typeof SETTINGS]][]) {
		pi.registerFlag(setting.flag, { type: "string", description: FLAG_HELP[key] });
	}

	/** Per session (this closure), transient: lives from a relay call or /relay to the next turn_end. */
	let pending: PendingReset | undefined;

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
		pending = undefined;
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
		pending = undefined;
	});

	pi.on("turn_end", async (event, ctx) => {
		const request = pending;
		pending = undefined;
		const percent = percentOf(ctx);
		const aborted = event.outcome === "aborted" || ctx.signal?.aborted === true;
		const branch = ctx.sessionManager.getBranch();
		const state = stateFrom(branch);
		if (request && !aborted) {
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const lookup = locateLookup({ sessionId, sessionFile });
			const catchup = await runCatchup(lookup, sessionId);
			const n = state.resets + 1;
			const goal = state.loop.goal;
			const summary = buildSummary({
				n,
				percent,
				sessionId,
				sessionFile,
				goal,
				userMessages: userMessages(branch),
				note: request.note,
				byUser: request.byUser,
				catchup,
				searchCommand: searchCommand(lookup, sessionId),
			});
			showStatus(ctx, undefined, state.loop.on);
			return { entries: [...event.entries, ...resetDrafts({ n, percent, note: request.note, goal, byUser: request.byUser, summary })], continue: true };
		}
		showStatus(ctx, percent, state.loop.on);
		const current = config();
		const window = ctx.getContextUsage()?.contextWindow;
		const baseline = state.baselineTokens !== undefined && window ? (state.baselineTokens / window) * 100 : undefined;
		const step = aborted ? undefined : dueStep(percent, state.lastNudgeStep, current.nudgeAt, current.nudgeEvery, baseline);
		if (step === undefined || percent === undefined) return undefined;
		return { entries: [...event.entries, nudgeDraft(percent, step, state.lastNudgeStep === undefined)] };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.continue || event.context.pendingMessages.length > 0 || ctx.signal?.aborted === true) return undefined;
		const state = stateOf(ctx);
		const decision = settleDecision(state.loop, event.outcome);
		switch (decision.action) {
			case "none":
				return undefined;
			case "stop":
				showStatus(ctx, percentOf(ctx), false);
				tell(ctx, `relay loop stopped: ${stopReasonText(decision.reason)}`, "warning");
				return { entries: [...event.entries, ...loopStopDrafts(decision.reason, state.loop.goal)] };
			case "continue":
				if (decision.backoffMs > 0) await sleep(decision.backoffMs);
				return { entries: [...event.entries, loopDraft(state.loop.goal, decision.errors, decision.idle)], continue: true };
		}
	});

	const askForHandoff = (percent: number | undefined): void => {
		const ask = humanAskDraft(percent);
		pi.sendMessage({ customType: ask.customType, content: ask.content, display: ask.display, details: ask.details }, { triggerTurn: true });
	};

	pi.on("agent_settled", (event, ctx) => {
		const leftover = pending;
		pending = undefined;
		const state = stateOf(ctx);
		const percent = percentOf(ctx);
		if (event.aborted && state.loop.on) {
			switchLoop({ loop: "off", reason: "aborted" });
			tell(ctx, "relay loop off: the run was aborted. /relay on resumes it.", "warning");
		}
		showStatus(ctx, percent, state.loop.on && !event.aborted);
		// a /relay that came after the run's last turn ended: start a turn for it (pi defers this until settled)
		if (leftover?.byUser && !event.aborted) {
			pending = leftover;
			askForHandoff(percent);
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
			const decision = toolDecision(params.done === true, pending?.agentCalled === true, state, config());
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
					pending = { note: mergeNotes(note, pending), byUser: pending?.byUser === true, agentCalled: true };
					return result(toolResultText.queued(decision.n), { outcome: "queued", note, n: decision.n });
			}
		},
	});

	pi.registerCommand("relay", {
		description: "relay: /relay [note] resets the context now · /relay on [goal] · /relay off · /relay status",
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
					const report = statusReport({ sessionId: ctx.sessionManager.getSessionId(), percent, contextWindow: usage?.contextWindow, state, config: config() });
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
				case "reset": {
					pending = { note: command.note, byUser: true, agentCalled: false };
					if (!ctx.isIdle()) return tell(ctx, "relay: the context resets when the agent's current turn ends");
					askForHandoff(percent);
					return tell(ctx, "relay: the agent writes a handoff note, then the context resets at the end of its turn");
				}
			}
		},
	});
}
