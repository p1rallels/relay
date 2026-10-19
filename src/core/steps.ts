/** Rounds away float noise, so 0.1 + 0.2 lands on the 0.3 step. */
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6;

/** The highest step at or below `percent` (nudgeAt, nudgeAt + every, …); undefined below the first. */
export const stepAt = (percent: number, nudgeAt: number, every: number): number | undefined => {
	if (!Number.isFinite(percent) || !(every > 0) || percent < nudgeAt) return undefined;
	const crossed = Math.floor(tidy((percent - nudgeAt) / every));
	return tidy(nudgeAt + crossed * every);
};

/**
 * The step to nudge at now: the highest step reached, when it is above the last step nudged since
 * the context last shrank. Jumping several steps at once gives one nudge, at the highest.
 */
export const dueStep = (percent: number | null | undefined, lastStep: number | undefined, nudgeAt: number, every: number): number | undefined => {
	if (percent === null || percent === undefined) return undefined;
	const step = stepAt(percent, nudgeAt, every);
	if (step === undefined) return undefined;
	if (lastStep !== undefined && step <= lastStep) return undefined;
	return step;
};

/** Where the next nudge comes, for status reports. */
export const nextStep = (percent: number | null | undefined, lastStep: number | undefined, nudgeAt: number, every: number): number => {
	const reached = percent === null || percent === undefined ? undefined : stepAt(percent, nudgeAt, every);
	const floor = Math.max(lastStep ?? -Infinity, reached ?? -Infinity);
	return floor === -Infinity ? nudgeAt : tidy(floor + every);
};
