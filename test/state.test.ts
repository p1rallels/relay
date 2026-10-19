import { describe, expect, test } from "bun:test";
import { type Entry, unansweredUser, userMessages } from "../src/core/entries.ts";
import { INITIAL_STATE, stateFrom } from "../src/core/state.ts";
import { assistant, compaction, relayMsg, relayResult, relaySwitch, user } from "./helpers.ts";

describe("stateFrom", () => {
	test("an empty branch is the initial state", () => {
		expect(stateFrom([])).toEqual(INITIAL_STATE);
	});

	test("nudges remember their step; any compaction starts the steps over", () => {
		const nudged = [user("go"), assistant({ tools: 1 }), relayMsg({ kind: "nudge", percent: 41.2, step: 40 }), relayMsg({ kind: "nudge", percent: 46, step: 45 })];
		expect(stateFrom(nudged).lastNudgeStep).toBe(45);
		expect(stateFrom([...nudged, compaction()]).lastNudgeStep).toBeUndefined();
		expect(stateFrom([...nudged, compaction()]).resets).toBe(0);
	});

	test("a human's ask-for-handoff nudge doesn't move the steps", () => {
		expect(stateFrom([relayMsg({ kind: "nudge", percent: 47, byUser: true })]).lastNudgeStep).toBeUndefined();
	});

	test("the baseline is the first good response since the context last shrank", () => {
		expect(stateFrom([user("go"), assistant({ tokens: 900, stopReason: "error" }), assistant({ tokens: 1000 }), assistant({ tokens: 5000 })]).baselineTokens).toBe(1000);
		expect(stateFrom([assistant({ tokens: 1000 }), compaction({ n: 1 })]).baselineTokens).toBeUndefined();
		expect(stateFrom([assistant({ tokens: 1000 }), compaction({ n: 1 }), assistant({ tokens: 3000 }), assistant({ tokens: 4000 })]).baselineTokens).toBe(3000);
	});

	test("relay compactions count resets", () => {
		const branch = [compaction({ n: 1, percent: 45 }), relayMsg({ kind: "reset", n: 1 }), compaction(), compaction({ n: 2 })];
		expect(stateFrom(branch).resets).toBe(2);
	});

	test("the loop switches on and off, keeping its goal", () => {
		const on = stateFrom([relaySwitch({ loop: "on", goal: "ship it", by: "user" })]);
		expect(on.loop).toMatchObject({ on: true, goal: "ship it", stopped: undefined });
		expect(on.loopRecorded).toBe(true);
		const off = stateFrom([relaySwitch({ loop: "on", goal: "ship it", by: "user" }), relaySwitch({ loop: "off", reason: "aborted" })]);
		expect(off.loop).toMatchObject({ on: false, goal: "ship it", stopped: "aborted" });
		const again = stateFrom([relaySwitch({ loop: "on", goal: "ship it" }), relaySwitch({ loop: "off", reason: "user" }), relaySwitch({ loop: "on" })]);
		expect(again.loop).toMatchObject({ on: true, goal: "ship it" });
	});

	test("relay done ends the loop; a capped call does too", () => {
		const on = relaySwitch({ loop: "on", goal: "g" });
		expect(stateFrom([on, relayResult({ outcome: "done", note: "all done" })]).loop).toMatchObject({ on: false, stopped: "done" });
		expect(stateFrom([on, relayResult({ outcome: "capped" })]).loop).toMatchObject({ on: false, stopped: "cap" });
		expect(stateFrom([on, relayResult({ outcome: "queued", n: 1 })]).loop.on).toBe(true);
	});

	test("loop prompts carry the counters; tool calls and good answers clear them", () => {
		const on = relaySwitch({ loop: "on", goal: "g" });
		const prompted = stateFrom([on, relayMsg({ kind: "loop", errors: 0, idle: 2 })]);
		expect(prompted.loop).toMatchObject({ idle: 2, errors: 0, progressed: false });
		expect(stateFrom([on, relayMsg({ kind: "loop", idle: 2 }), assistant()]).loop).toMatchObject({ idle: 2, progressed: false });
		expect(stateFrom([on, relayMsg({ kind: "loop", idle: 2 }), assistant({ tools: 1 })]).loop).toMatchObject({ idle: 0, progressed: true });
		expect(stateFrom([on, relayMsg({ kind: "loop", errors: 2 }), assistant({ stopReason: "error" })]).loop.errors).toBe(2);
		expect(stateFrom([on, relayMsg({ kind: "loop", errors: 2 }), assistant()]).loop.errors).toBe(0);
	});

	test("a loop-stopped message is informational; the switch entry decides", () => {
		const branch = [relaySwitch({ loop: "on", goal: "g" }), relaySwitch({ loop: "off", reason: "errors" }), relayMsg({ kind: "loop", stopped: "errors" })];
		expect(stateFrom(branch).loop).toMatchObject({ on: false, stopped: "errors" });
	});

	test("malformed and foreign entries are ignored", () => {
		const branch = [
			{ type: "custom_message", customType: "msg", details: { kind: "nudge", step: 99 } },
			{ type: "custom_message", customType: "relay", details: { kind: "bogus" } },
			{ type: "custom", customType: "relay", data: { loop: "maybe" } },
			{ type: "compaction", details: { relay: { n: "two" } } },
			{ type: "message", message: null },
		];
		expect(stateFrom(branch)).toEqual(INITIAL_STATE);
	});
});

describe("userMessages", () => {
	test("only role user, numbered, text parts joined, images marked", () => {
		const branch = [
			user("first", 1),
			assistant(),
			relayMsg({ kind: "nudge", step: 40 }),
			{ type: "message", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "…" }] } },
			{ type: "message", message: { role: "user", content: "plain" } },
		];
		expect(userMessages(branch)).toEqual([
			{ index: 1, text: "first", timestamp: "2026-10-19T06:01:00.000Z" },
			{ index: 2, text: "look\n[image]", timestamp: "t" },
			{ index: 3, text: "plain", timestamp: undefined },
		]);
	});
});

describe("unansweredUser", () => {
	const quiet = (content: unknown[]): Entry => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content } });
	const relayCall = { type: "toolCall", id: "t", name: "relay", arguments: { note: "answered it" } };
	const toolsOnly = quiet([{ type: "toolCall", id: "b", name: "bash", arguments: {} }]);
	const thinksOnly = quiet([{ type: "thinking", thinking: "the answer is 4" }, { type: "text", text: "  \n" }, relayCall]);

	test("the last user message, by number, when nothing the agent wrote after it has text", () => {
		expect(unansweredUser([user("q1"), assistant(), user("q2"), toolsOnly, relayResult({ outcome: "queued" }), thinksOnly])).toBe(2);
		expect(unansweredUser([user("q1"), relayMsg({ kind: "nudge", step: 40 }), quiet([relayCall])])).toBe(1);
	});

	test("any text after it is a reply: in the message that calls relay, or earlier", () => {
		expect(unansweredUser([user("q1"), assistant({ tools: 1 })])).toBeUndefined();
		expect(unansweredUser([user("q1"), assistant(), toolsOnly, quiet([relayCall])])).toBeUndefined();
	});

	test("no user message, nothing to answer", () => {
		expect(unansweredUser([])).toBeUndefined();
		expect(unansweredUser([relayMsg({ kind: "loop" }), toolsOnly])).toBeUndefined();
	});
});
