import { type CompactionRelay, CUSTOM_TYPE, type LoopSwitch, type RelayDetails, type StopReason } from "./entries.ts";
import { humanResetAskText, loopOnText, loopStoppedText, loopText, nudgeText, resetText } from "./text.ts";

/** Structural twins of pi's boundary drafts (custom_message, compaction, custom). */
export interface MessageDraft {
	readonly type: "custom_message";
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: RelayDetails;
}

export interface CompactionDraft {
	readonly type: "compaction";
	readonly summary: string;
	/** null: retain none. pi records the compaction's own id as firstKeptEntryId. */
	readonly firstKeptEntryId: null;
	readonly details: { readonly relay: CompactionRelay };
}

export interface SwitchDraft {
	readonly type: "custom";
	readonly customType: string;
	readonly data: LoopSwitch;
}

export type Draft = MessageDraft | CompactionDraft | SwitchDraft;

export const roundPercent = (percent: number): number => Math.round(percent * 10) / 10;

const message = (content: string, details: RelayDetails): MessageDraft => ({ type: "custom_message", customType: CUSTOM_TYPE, content, display: true, details });

export const switchDraft = (data: LoopSwitch): SwitchDraft => ({ type: "custom", customType: CUSTOM_TYPE, data });

export const nudgeDraft = (percent: number, step: number, first: boolean): MessageDraft =>
	message(nudgeText(percent, first), { kind: "nudge", percent: roundPercent(percent), step });

export const humanAskDraft = (percent: number | undefined): MessageDraft =>
	message(humanResetAskText(percent), { kind: "nudge", ...(percent === undefined ? {} : { percent: roundPercent(percent) }), byUser: true });

export interface ResetInput {
	readonly n: number;
	readonly percent: number | undefined;
	readonly note: string;
	readonly goal: string | undefined;
	readonly byUser: boolean;
	readonly summary: string;
}

/** A reset: a retain-none compaction carrying the catch-up, then the visible message the fresh context opens with. */
export const resetDrafts = ({ n, percent, note, goal, byUser, summary }: ResetInput): readonly [CompactionDraft, MessageDraft] => {
	const relay: CompactionRelay = {
		n,
		...(percent === undefined ? {} : { percent: roundPercent(percent) }),
		...(note.trim() === "" ? {} : { note: note.trim() }),
		...(goal === undefined ? {} : { goal }),
	};
	return [
		{ type: "compaction", summary, firstKeptEntryId: null, details: { relay } },
		message(resetText(n, percent, byUser), { kind: "reset", ...relay, ...(byUser ? { byUser: true as const } : {}) }),
	];
};

export const loopDraft = (goal: string | undefined, errors: number, idle: number): MessageDraft =>
	message(loopText(goal, errors, idle), { kind: "loop", ...(goal === undefined ? {} : { goal }), errors, idle });

export const loopOnDraft = (goal: string | undefined): MessageDraft => message(loopOnText(goal), { kind: "loop", ...(goal === undefined ? {} : { goal }) });

export const loopStopDrafts = (reason: StopReason, goal: string | undefined): readonly [SwitchDraft, MessageDraft] => [
	switchDraft({ loop: "off", reason }),
	message(loopStoppedText(reason), { kind: "loop", ...(goal === undefined ? {} : { goal }), stopped: reason }),
];
