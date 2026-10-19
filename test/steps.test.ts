import { describe, expect, test } from "bun:test";
import { baselinePercent, dueStep, nextStep, stepAt } from "../src/core/steps.ts";

describe("stepAt", () => {
	test("below the first step there is none", () => {
		expect(stepAt(39.9, 40, 5)).toBeUndefined();
	});
	test("40, then every 5", () => {
		expect(stepAt(40, 40, 5)).toBe(40);
		expect(stepAt(44.99, 40, 5)).toBe(40);
		expect(stepAt(45, 40, 5)).toBe(45);
		expect(stepAt(57.2, 40, 5)).toBe(55);
		expect(stepAt(100, 40, 5)).toBe(100);
	});
	test("fractional steps don't drift", () => {
		expect(stepAt(0.3, 0.1, 0.1)).toBe(0.3);
		expect(stepAt(1.7, 1, 0.1)).toBe(1.7);
	});
	test("nonsense in, nothing out", () => {
		expect(stepAt(Number.NaN, 40, 5)).toBeUndefined();
		expect(stepAt(50, 40, 0)).toBeUndefined();
	});
});

describe("dueStep", () => {
	test("first crossing nudges", () => {
		expect(dueStep(41, undefined, 40, 5)).toBe(40);
	});
	test("one nudge per step", () => {
		expect(dueStep(43, 40, 40, 5)).toBeUndefined();
		expect(dueStep(45.1, 40, 40, 5)).toBe(45);
	});
	test("a jump over several steps nudges once, at the highest", () => {
		expect(dueStep(58, 40, 40, 5)).toBe(55);
	});
	test("unknown usage (right after a compaction) never nudges", () => {
		expect(dueStep(null, undefined, 40, 5)).toBeUndefined();
		expect(dueStep(undefined, undefined, 40, 5)).toBeUndefined();
	});
	test("steps the context already started past count as nudged", () => {
		expect(dueStep(53, undefined, 40, 5, 52)).toBeUndefined();
		expect(dueStep(55.5, undefined, 40, 5, 52)).toBe(55);
		expect(dueStep(41, undefined, 40, 5, 12)).toBe(40);
		expect(dueStep(57, 50, 40, 5, 41)).toBe(55);
	});
	test("after a reset the steps start over", () => {
		expect(dueStep(12, undefined, 40, 5)).toBeUndefined();
		expect(dueStep(40.5, undefined, 40, 5)).toBe(40);
	});
});

describe("baselinePercent", () => {
	test("tokens over the window; unknown when either is", () => {
		expect(baselinePercent(50_000, 200_000)).toBe(25);
		expect(baselinePercent(undefined, 200_000)).toBeUndefined();
		expect(baselinePercent(50_000, undefined)).toBeUndefined();
		expect(baselinePercent(50_000, 0)).toBeUndefined();
	});
});

describe("nextStep", () => {
	test("the first step when nothing was nudged", () => {
		expect(nextStep(12, undefined, 40, 5)).toBe(40);
		expect(nextStep(undefined, undefined, 40, 5)).toBe(40);
	});
	test("the step after the last nudge or the reached one", () => {
		expect(nextStep(43, 40, 40, 5)).toBe(45);
		expect(nextStep(51, 45, 40, 5)).toBe(55);
		expect(nextStep(52, undefined, 40, 5, 51)).toBe(55);
	});
});
