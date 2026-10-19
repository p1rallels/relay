import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/core/command.ts";
import { loopStopDrafts, nudgeDraft, resetDrafts } from "../src/core/drafts.ts";
import { catchupArgs, commandLine, findLookup, searchArgs, shellQuote } from "../src/core/lookup.ts";
import { INITIAL_STATE } from "../src/core/state.ts";
import { backoffText, formatDuration, formatPercent, loopText, statusLine, statusReport, unknownCommandText } from "../src/core/text.ts";

describe("parseCommand", () => {
	test("only a bare /relay resets", () => {
		expect(parseCommand("")).toEqual({ kind: "reset" });
		expect(parseCommand("   ")).toEqual({ kind: "reset" });
	});
	test("subcommands", () => {
		expect(parseCommand("on")).toEqual({ kind: "on", goal: undefined });
		expect(parseCommand("ON  ship the canvas view ")).toEqual({ kind: "on", goal: "ship the canvas view" });
		expect(parseCommand("off")).toEqual({ kind: "off" });
		expect(parseCommand("status")).toEqual({ kind: "status" });
	});
	test("any other text is not a reset: it's answered with a hint", () => {
		expect(parseCommand("  wrap up the parser first ")).toEqual({ kind: "unknown", text: "wrap up the parser first" });
		expect(parseCommand("online docs are stale")).toEqual({ kind: "unknown", text: "online docs are stale" });
		expect(parseCommand("reset")).toEqual({ kind: "unknown", text: "reset" });
		expect(unknownCommandText("ship the parser")).toBe("did you mean /relay on ship the parser? (/relay alone resets the context)");
	});
});

describe("lookup command", () => {
	test("catchup is rooted at the session's folder", () => {
		expect(catchupArgs("/tmp/s", "abc")).toEqual(["--root", "/tmp/s", "catchup", "abc", "-n", "30"]);
		expect(commandLine("lookup", searchArgs("/tmp/s", "abc"))).toBe("lookup --root /tmp/s search '<term>' --session abc");
		expect(commandLine("lookup", searchArgs(undefined, "abc"))).toBe("lookup search '<term>' --session abc");
	});
	test("shell quoting", () => {
		expect(shellQuote("/Users/me/.pi/agent/sessions/--x--")).toBe("/Users/me/.pi/agent/sessions/--x--");
		expect(shellQuote("/tmp/my dir")).toBe("'/tmp/my dir'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});
	test("PATH first, then ~/.cargo/bin, else none", () => {
		const has = (paths: string[]) => (path: string) => paths.includes(path);
		expect(findLookup("/usr/bin:/opt/bin", "/h", has(["/opt/bin/lookup", "/h/.cargo/bin/lookup"]))).toEqual({ path: "/opt/bin/lookup", display: "lookup" });
		expect(findLookup("/usr/bin", "/h", has(["/h/.cargo/bin/lookup"]))).toEqual({ path: "/h/.cargo/bin/lookup", display: "/h/.cargo/bin/lookup" });
		expect(findLookup(undefined, "/h", has([]))).toBeUndefined();
		expect(findLookup("relative:/usr/bin", "/h", has(["relative/lookup"]))).toBeUndefined();
	});
});

describe("drafts", () => {
	test("a reset is a retain-none compaction, then the reset message", () => {
		const [compaction, message] = resetDrafts({ n: 1, percent: 45.678, note: " next: tests ", goal: undefined, byUser: false, summary: "S" });
		expect(compaction).toEqual({ type: "compaction", summary: "S", firstKeptEntryId: null, details: { relay: { n: 1, percent: 45.6, note: "next: tests" } } });
		expect(message.type).toBe("custom_message");
		expect(message.customType).toBe("relay");
		expect(message.display).toBe(true);
		expect(message.details).toEqual({ kind: "reset", n: 1, percent: 45.6, note: "next: tests" });
		expect(message.content).toContain("context reset #1 (was at 45%)");
	});
	test("a nudge carries its percent and step", () => {
		expect(nudgeDraft(44.96, 40, false).details).toEqual({ kind: "nudge", percent: 44.9, step: 40 });
		const draft = nudgeDraft(45.23, 45, false);
		expect(draft.details).toEqual({ kind: "nudge", percent: 45.2, step: 45 });
		expect(draft.content).toContain("you're at 45% of your context window");
	});
	test("stopping the loop writes the switch and tells why", () => {
		const [sw, message] = loopStopDrafts("errors", "g");
		expect(sw).toEqual({ type: "custom", customType: "relay", data: { loop: "off", reason: "errors" } });
		expect(message.details).toEqual({ kind: "loop", goal: "g", stopped: "errors" });
		expect(message.content).toBe("[relay loop] stopped: 4 errors in a row.");
	});
});

describe("text", () => {
	test("formatPercent floors", () => {
		expect(formatPercent(45.9)).toBe("45%");
		expect(formatPercent(9.96)).toBe("9.9%");
		expect(formatPercent(0.04)).toBe("0%");
	});
	test("status line", () => {
		expect(statusLine(43.2, false)).toBe("relay · 43%");
		expect(statusLine(43.2, true)).toBe("relay · 43% · loop");
		expect(statusLine(null, true)).toBe("relay · loop");
		expect(statusLine(undefined, false)).toBe("relay");
	});
	test("durations", () => {
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(900_000)).toBe("15m");
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(90_000)).toBe("90s");
	});
	test("the human hears when the loop backs off, and that esc stops it", () => {
		expect(backoffText(2, 300_000)).toBe("relay loop: the run failed (2 in a row; the loop stops at 4). trying again in 5m; esc stops the loop.");
	});
	test("loop prompt: long goals are clipped, trouble is counted", () => {
		const text = loopText("x".repeat(1000), 2, 0);
		expect(text).toContain("the last request failed (2 in a row; the loop stops at 4)");
		expect(text).toContain("[…600 more chars]");
		expect(loopText(undefined, 0, 1)).toContain("you stopped without calling a tool (1 in a row");
		expect(loopText(undefined, 0, 0)).toContain("the task in this session's first user message");
	});
	test("status report", () => {
		const report = statusReport({
			sessionId: "abc",
			percent: 43,
			contextWindow: 200_000,
			baselinePercent: undefined,
			state: { ...INITIAL_STATE, resets: 1, lastNudgeStep: 40 },
			config: { nudgeAt: 40, nudgeEvery: 5, maxResets: undefined, goal: undefined },
		});
		expect(report).toBe(
			[
				"relay: 43% of the context window (200k tokens); next nudge at 45% (first at 40%, then every 5%)",
				"resets: 1 (no cap)",
				"loop: off",
				"session: abc",
			].join("\n"),
		);
	});
	test("status report: a /relay on its way", () => {
		const report = statusReport({
			sessionId: "abc",
			percent: 43,
			contextWindow: 200_000,
			baselinePercent: undefined,
			state: INITIAL_STATE,
			config: { nudgeAt: 40, nudgeEvery: 5, maxResets: 2, goal: undefined },
			request: "after-run",
		});
		expect(report.split("\n")[1]).toBe("resets: 0 (cap 2); a /relay waits for the agent's run to end");
	});
});
