import type { RelayConfig } from "./config.ts";
import type { StopReason } from "./entries.ts";
import { MAX_ERRORS, MAX_IDLE } from "./loop.ts";
import type { RelayState } from "./state.ts";
import { nextStep } from "./steps.ts";

const GOAL_IN_LOOP_PROMPT = 400;

/** Floors, so a nudge never claims a step the context hasn't reached: 9.96 → "9.9%", 45.7 → "45%". */
export const formatPercent = (percent: number): string => {
	if (percent >= 10) return `${Math.floor(percent)}%`;
	return `${Math.floor(percent * 10) / 10}%`;
};

export const clipHead = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()} […${text.length - max} more chars]`;
};

export const clipTail = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return `[…${text.length - max} earlier chars] ${text.slice(text.length - max).trimStart()}`;
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const goalLine = (goal: string | undefined): string =>
	goal === undefined ? "the task in this session's first user message" : clipHead(oneLine(goal), GOAL_IN_LOOP_PROMPT);

export const nudgeText = (percent: number, first: boolean): string =>
	[
		`[relay] you're at ${formatPercent(percent)} of your context window.`,
		"get to a clean checkpoint: finish the step you're on and commit.",
		"then call relay with a note for whoever picks this up: what's done, what's next, gotchas, where things are.",
		"your context then resets in place (same session, a fresh context that opens with your note and a catch-up) and you carry on.",
		first ? "if the whole task is about to be finished, finish it first." : "don't start anything big before you hand off.",
	].join(" ");

export const humanResetAskText = (percent: number | undefined): string =>
	[
		`[relay] the human asked for a context reset${percent === undefined ? "" : ` (you're at ${formatPercent(percent)})`}.`,
		"call relay now, before anything else, with a note for whoever picks this up: what's done, what's next, gotchas, where things are.",
		"the reset happens at the end of this turn either way.",
	].join(" ");

export const resetText = (n: number, percent: number | undefined, byUser: boolean): string =>
	[
		`[relay] context reset #${n}${percent === undefined ? "" : ` (was at ${formatPercent(percent)})`}${byUser ? ", asked for by the human" : ""}, in place: same session, same file, fresh context.`,
		"the summary above has the goal, the user's messages, the handoff note and the recent conversation.",
		"check git status, git log --oneline -5 and mb ready, then carry on from the note.",
	].join(" ");

export const loopText = (goal: string | undefined, errors: number, idle: number): string => {
	const trouble =
		errors > 0
			? `the last request failed (${errors} in a row; the loop stops at ${MAX_ERRORS}). `
			: idle > 0
				? `you stopped without calling a tool (${idle} in a row; the loop stops at ${MAX_IDLE}). `
				: "";
	return [
		`[relay loop] ${trouble}keep going toward the goal: ${goalLine(goal)}.`,
		"do the next step.",
		"when the goal is completely done (built, verified, committed), call relay with done: true and a short final note.",
		"if you can't go on without a human, call relay with done: true and say what's blocking.",
	].join(" ");
};

export const loopOnText = (goal: string | undefined): string =>
	[
		`[relay loop] the loop is on. goal: ${goalLine(goal)}.`,
		"work toward it; whenever you stop, you'll be asked to keep going.",
		"when it's completely done (built, verified, committed), call relay with done: true and a short final note.",
	].join(" ");

const STOP_TEXT: Readonly<Record<StopReason, string>> = {
	user: "the human turned it off",
	aborted: "the run was aborted",
	done: "the agent called relay with done: true",
	errors: `${MAX_ERRORS} errors in a row`,
	stalled: `${MAX_IDLE} loop prompts in a row answered without a tool call`,
	cap: "the session hit its reset cap",
};

export const stopReasonText = (reason: StopReason): string => STOP_TEXT[reason];

export const loopStoppedText = (reason: StopReason): string => `[relay loop] stopped: ${stopReasonText(reason)}.`;

export const toolResultText = {
	queued: (n: number): string =>
		`reset #${n} queued: it happens as soon as this turn's tool calls finish, then you continue with a fresh context that opens with your note. don't start anything else in this turn.`,
	duplicate: (): string => "a reset is already queued for this turn by an earlier relay call; this call did nothing and its note was not used.",
	done: (loopWasOn: boolean): string =>
		loopWasOn
			? "loop finished, no reset. end your turn with a short wrap-up for the human."
			: "noted, no reset. the relay loop wasn't on, so there was nothing to stop.",
	capped: (max: number): string =>
		`no reset: this session already did ${max} reset${max === 1 ? "" : "s"}, its cap (PI_RELAY_MAX_RESETS), and the loop is now off. commit, then end your turn with a summary of where things are.`,
} as const;

export const statusLine = (percent: number | null | undefined, loopOn: boolean): string =>
	["relay", ...(percent === null || percent === undefined ? [] : [formatPercent(percent)]), ...(loopOn ? ["loop"] : [])].join(" · ");

export interface StatusInput {
	readonly sessionId: string;
	readonly percent: number | null | undefined;
	readonly contextWindow: number | undefined;
	readonly baselinePercent: number | undefined;
	readonly state: RelayState;
	readonly config: RelayConfig;
}

export const statusReport = ({ sessionId, percent, contextWindow, baselinePercent, state, config }: StatusInput): string => {
	const usage = percent === null || percent === undefined ? "context usage unknown until the next response" : `${formatPercent(percent)} of the context window`;
	const window = contextWindow ? ` (${Math.round(contextWindow / 1000)}k tokens)` : "";
	const next = formatPercent(nextStep(percent, state.lastNudgeStep, config.nudgeAt, config.nudgeEvery, baselinePercent));
	const cap = config.maxResets === undefined ? "no cap" : `cap ${config.maxResets}`;
	const loop = state.loop.on
		? `on · goal: ${goalLine(state.loop.goal)} · errors ${state.loop.errors}/${MAX_ERRORS} · idle ${state.loop.idle}/${MAX_IDLE}`
		: `off${state.loop.stopped ? ` (${stopReasonText(state.loop.stopped)})` : ""}`;
	return [
		`relay: ${usage}${window}; next nudge at ${next} (first at ${formatPercent(config.nudgeAt)}, then every ${formatPercent(config.nudgeEvery)})`,
		`resets: ${state.resets} (${cap})`,
		`loop: ${loop}`,
		`session: ${sessionId}`,
	].join("\n");
};
