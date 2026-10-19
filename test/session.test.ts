import { afterEach, describe, expect, test } from "bun:test";
import { stepAt } from "../src/core/steps.ts";
import { stateFrom } from "../src/core/state.ts";
import { CONTEXT_WINDOW, call, calls, contextChars, type Harness, openSession, relayEntries, say, sessionFiles, textOf, waitFor } from "./harness.ts";

const ENV_KEYS = ["PI_RELAY_NUDGE_AT", "PI_RELAY_NUDGE_EVERY", "PI_RELAY_MAX_RESETS", "PI_RELAY_GOAL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const open: Harness[] = [];

const env = (values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void => {
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, values);
};

const start = async (...args: Parameters<typeof openSession>): Promise<Harness> => {
	const harness = await openSession(...args);
	open.push(harness);
	return harness;
};

afterEach(() => {
	for (const harness of open.splice(0)) harness.dispose();
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

/** ~5% of the 20k-token window per call. */
const PAD = { chars: 4_000 };

describe("nudge", () => {
	test("appears once per step, at the turn that crosses it, and reaches the model", async () => {
		env({ PI_RELAY_NUDGE_AT: "25", PI_RELAY_NUDGE_EVERY: "10" });
		const h = await start();
		h.respond([call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), say("done")]);
		await h.session.prompt("grow the context");
		const nudges = relayEntries(h.entries(), "nudge").map((entry) => entry.details as { percent: number; step: number });
		const crossings = h.percents.flatMap((percent, turn) => {
			const step = percent === null ? undefined : stepAt(percent, 25, 10);
			const before = turn === 0 ? null : (h.percents[turn - 1] ?? null);
			const stepBefore = before === null ? undefined : stepAt(before, 25, 10);
			return step !== undefined && step !== stepBefore ? [step] : [];
		});
		expect(crossings.length).toBeGreaterThanOrEqual(2);
		expect(nudges.map((nudge) => nudge.step)).toEqual(crossings);
		for (const nudge of nudges) expect(nudge.percent).toBeGreaterThanOrEqual(nudge.step);
		const seen = h.requests.some((request) => request.messages.some((message) => textOf(message).startsWith("[relay] you're at")));
		expect(seen).toBe(true);
		expect(h.errors).toEqual([]);
	});

	test("never nudges below the first step", async () => {
		env({ PI_RELAY_NUDGE_AT: "90" });
		const h = await start();
		h.respond([call("pad", PAD), say("done")]);
		await h.session.prompt("small");
		expect(relayEntries(h.entries(), "nudge")).toEqual([]);
	});
});

describe("relay tool: reset in place", () => {
	test("same session, one retain-none compaction, the run continues on a small context", async () => {
		env({ PI_RELAY_NUDGE_AT: "95" });
		const h = await start();
		const id = h.session.sessionManager.getSessionId();
		h.respond([call("pad", { chars: 16_000 }), call("relay", { note: "NOTE-7: padded; next: say resumed" }), say("resumed")]);
		await h.session.prompt("pad, then relay");
		const entries = h.entries();
		const compactions = entries.filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		const compaction = compactions[0];
		if (compaction?.type !== "compaction") throw new Error("no compaction");
		expect(compaction.firstKeptEntryId).toBe(compaction.id);
		expect(compaction.fromHook).toBe(true);
		expect(compaction.details).toEqual({ relay: { n: 1, percent: expect.any(Number), note: "NOTE-7: padded; next: say resumed" } });
		const next = entries[entries.indexOf(compaction) + 1];
		expect(next?.type === "custom_message" && next.customType === "relay" && (next.details as { kind: string }).kind).toBe("reset");
		expect(h.session.sessionManager.getSessionId()).toBe(id);
		expect(sessionFiles(h.sessions)).toHaveLength(1);
		expect(sessionFiles(h.sessions)[0]).toContain(id);
		const [, beforeReset, afterReset] = h.requests;
		if (!beforeReset || !afterReset) throw new Error("expected three requests");
		expect(afterReset.messages.filter((message) => message.role !== "system").map((message) => textOf(message).slice(0, 40))).toEqual([
			expect.stringContaining("The conversation history before this"),
			expect.stringContaining("[relay] context reset #1"),
		]);
		expect(contextChars(afterReset)).toBeLessThan(contextChars(beforeReset) / 2);
		const summary = compaction.summary;
		expect(summary.split("\n")[0]).toContain(`context reset #1 at `);
		expect(summary).toContain(`this is still session ${id}`);
		expect(summary).toContain("## goal: the first user message (#1");
		expect(summary).toContain("pad, then relay");
		expect(summary).toContain("NOTE-7: padded; next: say resumed");
		expect(summary).toContain("## recent conversation");
		expect(summary).toContain("--session");
		expect(h.errors).toEqual([]);
	});

	test("lookup's catch-up of this session is in the summary", async () => {
		env({});
		const h = await start();
		h.respond([call("relay", { note: "n" }), say("ok")]);
		await h.session.prompt("UNIQUE-PROMPT-31337 please relay");
		const compaction = h.entries().find((entry) => entry.type === "compaction");
		if (compaction?.type !== "compaction") throw new Error("no compaction");
		const section = compaction.summary.slice(compaction.summary.indexOf("## recent conversation"));
		expect(section).toContain(`--root ${h.sessions} catchup ${h.session.sessionManager.getSessionId()} -n 30`);
		expect(section).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+\S+\s+[0-9a-f]{8}:\d+\s+user\n\s+UNIQUE-PROMPT-31337/);
	});

	test("a second relay call in the same turn is a no-op that says so", async () => {
		env({});
		const h = await start();
		h.respond([calls(["relay", { note: "FIRST" }], ["relay", { note: "SECOND" }]), say("ok")]);
		await h.session.prompt("relay twice");
		const entries = h.entries();
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const results = entries.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(results.map((result) => (result.details as { outcome: string }).outcome).sort()).toEqual(["duplicate", "queued"]);
		const compaction = entries.find((entry) => entry.type === "compaction");
		expect(compaction?.type === "compaction" && compaction.summary.includes("FIRST") && !compaction.summary.includes("SECOND")).toBe(true);
	});

	test("a fresh context that starts past a step isn't nudged straight back for it", async () => {
		env({ PI_RELAY_NUDGE_AT: "25", PI_RELAY_NUDGE_EVERY: "60" });
		const h = await start();
		const bigNote = "N".repeat(12_000);
		h.respond([call("pad", { chars: 8_000 }), call("relay", { note: bigNote }), call("pad", { chars: 40 }), call("pad", { chars: 40 }), say("ok")]);
		await h.session.prompt("go");
		const entries = h.entries();
		const resetAt = entries.findIndex((entry) => entry.type === "compaction");
		const nudgesAt = relayEntries(entries, "nudge").map((entry) => entries.indexOf(entry));
		expect(resetAt).toBeGreaterThan(0);
		expect(nudgesAt.length).toBe(1);
		expect(nudgesAt[0]).toBeLessThan(resetAt);
		const afterReset = h.percents.slice(2).filter((percent): percent is number => percent !== null);
		expect(afterReset.length).toBeGreaterThan(0);
		expect(afterReset.every((percent) => percent >= 25)).toBe(true);
	});

	test("the cap refuses a reset and ends the loop", async () => {
		env({ PI_RELAY_MAX_RESETS: "0", PI_RELAY_GOAL: "g" });
		const h = await start();
		h.respond([call("relay", { note: "n" }), say("wrapping up")]);
		await h.session.prompt("go");
		expect(h.entries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "cap" });
	});

	test("resets count up and the steps start over after each", async () => {
		env({ PI_RELAY_NUDGE_AT: "25", PI_RELAY_NUDGE_EVERY: "50" });
		const h = await start();
		h.respond([call("pad", { chars: 12_000 }), call("relay", { note: "one" }), call("pad", { chars: 12_000 }), call("relay", { note: "two" }), say("ok")]);
		await h.session.prompt("twice");
		const resets = relayEntries(h.entries(), "reset").map((entry) => (entry.details as { n: number }).n);
		expect(resets).toEqual([1, 2]);
		expect(relayEntries(h.entries(), "nudge").map((entry) => (entry.details as { step: number }).step)).toEqual([25, 25]);
		expect(stateFrom(h.entries()).resets).toBe(2);
	});
});

describe("loop", () => {
	test("continues past a settle and stops on done", async () => {
		env({ PI_RELAY_GOAL: "write three parts" });
		const h = await start();
		h.respond([say("part one written"), call("pad", { chars: 10 }), say("part two written"), call("relay", { note: "all three parts written", done: true }), say("wrap-up")]);
		await h.session.prompt("start on the parts");
		const loops = relayEntries(h.entries(), "loop");
		expect(loops).toHaveLength(2);
		expect(loops.every((entry) => textOf({ role: "user", content: entry.content } as never).includes("write three parts"))).toBe(true);
		const last = h.entries().at(-1);
		expect(last?.type === "message" && last.message.role === "assistant").toBe(true);
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "done" });
		expect(h.requests).toHaveLength(5);
		expect(h.errors).toEqual([]);
	});

	test("an agent that keeps stopping without doing anything stalls the loop", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		h.respond([say("1"), say("2"), say("3"), say("4"), say("5"), say("6")]);
		await h.session.prompt("go");
		expect(relayEntries(h.entries(), "loop").map((entry) => (entry.details as { idle?: number; stopped?: string }).stopped ?? entry.details)).toEqual([
			{ kind: "loop", goal: "g", errors: 0, idle: 0 },
			{ kind: "loop", goal: "g", errors: 0, idle: 1 },
			{ kind: "loop", goal: "g", errors: 0, idle: 2 },
			"stalled",
		]);
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "stalled" });
		expect(h.requests).toHaveLength(4);
	});

	test("an abort stops it", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		let release: () => void = () => {};
		const gate = new Promise<void>((done) => {
			release = done;
		});
		h.respond([
			say("first stop"),
			async () => {
				await gate;
				return say("too late");
			},
			say("never"),
		]);
		const running = h.session.prompt("go");
		await waitFor("the loop's second request", () => (h.requests.length >= 2 ? true : undefined));
		const aborting = h.session.abort();
		release();
		await aborting;
		await running;
		await new Promise((done) => setTimeout(done, 50));
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "aborted" });
		expect(h.requests).toHaveLength(2);
	});

	test("/relay on starts it when idle; /relay off stops it", async () => {
		env({});
		const h = await start();
		h.respond([say("hello")]);
		await h.session.prompt("hi");
		h.respond([call("relay", { note: "goal met", done: true }), say("bye")]);
		await h.session.prompt("/relay on reach the goal");
		await waitFor("the loop's run to finish", () => (stateFrom(h.entries()).loop.stopped === "done" ? true : undefined));
		const kickoff = relayEntries(h.entries(), "loop")[0];
		expect(kickoff?.details).toEqual({ kind: "loop", goal: "reach the goal" });
		await h.session.prompt("/relay on");
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: true, goal: "reach the goal" });
		await h.session.abort();
		await h.session.prompt("/relay off");
		expect(stateFrom(h.entries()).loop.on).toBe(false);
	});
});

describe("human /relay", () => {
	test("idle: asks the agent for its note, resets at the end of that turn, keeps both notes", async () => {
		env({});
		const h = await start();
		h.respond([say("did a thing")]);
		await h.session.prompt("do a thing");
		h.respond([call("relay", { note: "AGENT-NOTE" }), say("caught up")]);
		await h.session.prompt("/relay HUMAN-NOTE");
		const compaction = await waitFor("the reset", () => h.entries().find((entry) => entry.type === "compaction"));
		if (compaction.type !== "compaction") throw new Error("no compaction");
		expect(compaction.summary).toContain("AGENT-NOTE");
		expect(compaction.summary).toContain("the human's note with /relay: HUMAN-NOTE");
		expect(compaction.summary).toContain("asked for by the human");
		const ask = relayEntries(h.entries(), "nudge")[0];
		expect(ask?.details).toMatchObject({ kind: "nudge", byUser: true });
		await waitFor("the run after the reset", () => (h.requests.length >= 3 ? true : undefined));
	});

	test("idle: resets at the end of the turn even if the agent doesn't call relay", async () => {
		env({});
		const h = await start();
		h.respond([say("hello")]);
		await h.session.prompt("hi");
		h.respond([say("no tool for me"), say("after the reset")]);
		await h.session.prompt("/relay");
		await waitFor("the reset", () => h.entries().find((entry) => entry.type === "compaction"));
		await waitFor("the request after it", () => (h.requests.length >= 3 ? true : undefined));
		expect(relayEntries(h.entries(), "reset")[0]?.details).toMatchObject({ kind: "reset", n: 1, byUser: true });
	});
});

describe("state across a resume", () => {
	test("a finished loop stays finished when the session reopens with the same launch goal", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		h.respond([call("relay", { note: "done", done: true }), say("bye")]);
		await h.session.prompt("go");
		expect(stateFrom(h.entries()).loop.stopped).toBe("done");
		env({ PI_RELAY_GOAL: "g" });
		const again = await h.reopen();
		open.push(again);
		expect(stateFrom(again.entries()).loop).toMatchObject({ on: false, stopped: "done" });
		env({ PI_RELAY_GOAL: "a new goal" });
		const third = await again.reopen();
		open.push(third);
		expect(stateFrom(third.entries()).loop).toMatchObject({ on: true, goal: "a new goal" });
	});

	test("print mode consumes the launch goal so tools and nested runs don't inherit it", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start("print");
		expect(process.env.PI_RELAY_GOAL).toBeUndefined();
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: true, goal: "g" });
	});

	test("nudges already sent are not repeated after a reopen", async () => {
		env({ PI_RELAY_NUDGE_AT: "20", PI_RELAY_NUDGE_EVERY: "80" });
		const h = await start();
		h.respond([call("pad", { chars: 4 * CONTEXT_WINDOW * 0.25 }), say("ok")]);
		await h.session.prompt("grow");
		expect(relayEntries(h.entries(), "nudge")).toHaveLength(1);
		const again = await h.reopen();
		open.push(again);
		again.respond([call("pad", { chars: 10 }), say("ok")]);
		await again.session.prompt("a little more");
		expect(relayEntries(again.entries(), "nudge")).toHaveLength(1);
	});
});
