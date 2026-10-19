import { describe, expect, test } from "bun:test";
import type { UserMessage } from "../src/core/entries.ts";
import { buildSummary, type Catchup, pickRecent, type SummaryInput, USER_MESSAGES_BUDGET } from "../src/core/summary.ts";

const um = (index: number, text: string): UserMessage => ({ index, text, timestamp: `2026-10-19T06:${String(index).padStart(2, "0")}:30.000Z` });

const catchupOk: Catchup = { ok: true, command: "lookup --root /s catchup abc -n 30", output: "2026-10-19 06:27:50  proj  abc:6  user\n  build it\n" };

const input = (patch: Partial<SummaryInput> = {}): SummaryInput => ({
	n: 2,
	percent: 46.7,
	sessionId: "abc",
	sessionFile: "/s/2026_abc.jsonl",
	goal: undefined,
	userMessages: [um(1, "build the thing"), um(2, "also add tests")],
	note: "done: core. next: e2e. gotcha: lookup needs --root.",
	byUser: false,
	catchup: catchupOk,
	searchCommand: "lookup --root /s search '<term>' --session abc",
	...patch,
});

describe("buildSummary", () => {
	test("opens with the in-place line", () => {
		const text = buildSummary(input());
		expect(text.split("\n")[0]).toBe("context reset #2 at 46%, in place: this is still session abc; everything before is in its file (/s/2026_abc.jsonl).");
	});

	test("without a goal, the first user message is the goal and isn't repeated", () => {
		const text = buildSummary(input());
		expect(text).toContain("## goal: the first user message (#1 · 2026-10-19 06:01)\nbuild the thing");
		expect(text).toContain("[#2 · 2026-10-19 06:02]\nalso add tests");
		expect(text).not.toContain("[#1");
		expect(text).toContain("#1 is the goal above.");
	});

	test("an explicit goal leads, and every user message is listed", () => {
		const text = buildSummary(input({ goal: "ship relay-loop" }));
		expect(text).toContain("## goal\nship relay-loop");
		expect(text).toContain("[#1 · 2026-10-19 06:01]\nbuild the thing");
	});

	test("note, lookup output, and the way deeper are all there, in order", () => {
		const text = buildSummary(input());
		const order = ["## goal", "## the user's messages", "## handoff note", "## recent conversation: lookup --root /s catchup abc -n 30", "## go deeper"].map((part) =>
			text.indexOf(part),
		);
		expect(order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? 0)))).toBe(true);
		expect(text).toContain("abc:6  user");
		expect(text).toContain("gotcha: lookup needs --root.");
		expect(text.endsWith("lookup --root /s search '<term>' --session abc\nbefore you continue: git status, git log --oneline -5, mb ready")).toBe(true);
	});

	test("a failed lookup prints the command instead", () => {
		const text = buildSummary(input({ catchup: { ok: false, command: "lookup --root /s catchup abc -n 30", reason: "lookup failed: boom" } }));
		expect(text).toContain("## recent conversation\n(lookup failed: boom; run it yourself: lookup --root /s catchup abc -n 30)");
	});

	test("a human reset says so; unknown usage leaves out the percent", () => {
		const text = buildSummary(input({ byUser: true, percent: undefined, note: "" }));
		expect(text.split("\n")[0]).toBe("context reset #2, asked for by the human, in place: this is still session abc; everything before is in its file (/s/2026_abc.jsonl).");
		expect(text).toContain("## handoff note (from the human's /relay)\n(none)");
	});

	test("deterministic", () => {
		expect(buildSummary(input())).toBe(buildSummary(input()));
	});
});

describe("pickRecent", () => {
	test("newest win when over the budget, returned oldest first", () => {
		const messages = [um(1, "a".repeat(60)), um(2, "b".repeat(60)), um(3, "c".repeat(60))];
		const { kept, left } = pickRecent(messages, 130);
		expect(kept.map((message) => message.index)).toEqual([2, 3]);
		expect(left).toBe(1);
	});
	test("an oversized newest message is cut, never dropped", () => {
		const { kept, left } = pickRecent([um(1, "old"), um(2, "x".repeat(500))], 100);
		expect(kept).toHaveLength(1);
		expect(kept[0]?.index).toBe(2);
		expect(kept[0]?.text.startsWith("x".repeat(100))).toBe(true);
		expect(kept[0]?.text).toContain("[…400 more chars]");
		expect(left).toBe(1);
	});
	test("the summary tells how many were left out", () => {
		const many = Array.from({ length: 40 }, (_, index) => um(index + 1, `${index + 1} ${"z".repeat(1000)}`));
		const text = buildSummary(input({ userMessages: many, goal: "g" }));
		const listed = USER_MESSAGES_BUDGET / 1003;
		expect(text).toContain(`${40 - Math.floor(listed)} older messages are left out`);
		expect(text).toContain("[#40 ·");
	});
});
