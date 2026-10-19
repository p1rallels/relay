import type { UserMessage } from "./entries.ts";
import { clipHead, clipTail, formatPercent } from "./text.ts";

export const GOAL_BUDGET = 16_000;
export const USER_MESSAGES_BUDGET = 16_000;
export const NOTE_BUDGET = 16_000;
export const CATCHUP_BUDGET = 36_000;

export type Catchup =
	| { readonly ok: true; readonly command: string; readonly output: string }
	| { readonly ok: false; readonly command: string; readonly reason: string };

export interface SummaryInput {
	readonly n: number;
	readonly percent: number | undefined;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	/** The goal from /relay on or the launch; undefined means the first user message is the goal. */
	readonly goal: string | undefined;
	readonly userMessages: readonly UserMessage[];
	/** The agent's handoff note; empty when it didn't write one (a /relay whose turn didn't call relay). */
	readonly note: string;
	/** The human asked for this reset with /relay. */
	readonly byUser: boolean;
	readonly catchup: Catchup;
	/** How to search the session, e.g. `lookup --root <dir> search '<term>' --session <id>`. */
	readonly searchCommand: string;
}

export interface Picked {
	readonly kept: readonly UserMessage[];
	readonly left: number;
}

/**
 * The newest messages that fit the budget, returned oldest first. The newest one is always kept,
 * cut to the budget if it alone is over it.
 */
export const pickRecent = (messages: readonly UserMessage[], budget: number): Picked => {
	const newestFirst = [...messages].reverse();
	const kept: UserMessage[] = [];
	let used = 0;
	for (const message of newestFirst) {
		if (kept.length === 0 && message.text.length > budget) {
			kept.push({ ...message, text: clipHead(message.text, budget) });
			break;
		}
		if (used + message.text.length > budget) break;
		kept.push(message);
		used += message.text.length;
	}
	return { kept: kept.reverse(), left: messages.length - kept.length };
};

const stamp = (timestamp: string | undefined): string => (timestamp ? ` · ${timestamp.slice(0, 16).replace("T", " ")}` : "");

const header = (input: SummaryInput): string => {
	const at = input.percent === undefined ? "" : ` at ${formatPercent(input.percent)}`;
	const by = input.byUser ? ", asked for by the human" : "";
	const file = input.sessionFile ? ` (${input.sessionFile})` : "";
	return `context reset #${input.n}${at}${by}, in place: this is still session ${input.sessionId}; everything before is in its file${file}.`;
};

const goalSection = (input: SummaryInput, first: UserMessage | undefined): string => {
	if (input.goal !== undefined) return `## goal\n${clipHead(input.goal.trim(), GOAL_BUDGET)}`;
	if (!first) return "## goal\n(none given: no /relay on goal and no user message yet)";
	return `## goal: the first user message (#1${stamp(first.timestamp)})\n${clipHead(first.text.trim(), GOAL_BUDGET)}`;
};

const userSection = (input: SummaryInput): string => {
	const listed = input.goal === undefined ? input.userMessages.slice(1) : input.userMessages;
	const skipped = input.userMessages.length - listed.length;
	const title = "## the user's messages, verbatim, oldest first";
	if (listed.length === 0) return `${title}\n(${skipped > 0 ? "none besides #1, the goal above" : "none"})`;
	const { kept, left } = pickRecent(listed, USER_MESSAGES_BUDGET);
	const lines = kept.map((message) => `[#${message.index}${stamp(message.timestamp)}]\n${message.text.trim()}`);
	const notes = [
		...(skipped > 0 ? ["#1 is the goal above."] : []),
		...(left > 0 ? [`${left} older message${left === 1 ? " is" : "s are"} left out to keep this short; search the session for them.`] : []),
	];
	return [title, ...lines, ...(notes.length > 0 ? [`(${notes.join(" ")})`] : [])].join("\n");
};

const noteSection = (input: SummaryInput): string => {
	const note = input.note.trim();
	if (note !== "") return `## handoff note\n${clipHead(note, NOTE_BUDGET)}`;
	return `## handoff note\n(none${input.byUser ? ": the human asked for this reset with /relay and the agent didn't write one" : ""})`;
};

const catchupSection = (catchup: Catchup): string => {
	if (!catchup.ok) return `## recent conversation\n(${catchup.reason}; run it yourself: ${catchup.command})`;
	const output = catchup.output.trim();
	return `## recent conversation: ${catchup.command}\n${output === "" ? "(empty)" : clipTail(output, CATCHUP_BUDGET)}`;
};

const deeperSection = (input: SummaryInput): string =>
	["## go deeper", `${input.searchCommand}`, "before you continue: git status, git log --oneline -5, mb ready"].join("\n");

/** The compaction summary of a reset: deterministic text, no model call. */
export const buildSummary = (input: SummaryInput): string =>
	[header(input), goalSection(input, input.userMessages[0]), userSection(input), noteSection(input), catchupSection(input.catchup), deeperSection(input)].join(
		"\n\n",
	);
