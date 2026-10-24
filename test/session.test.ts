import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stepAt } from "../src/core/steps.ts";
import { stateFrom } from "../src/core/state.ts";
import { requestText, unknownCommandText } from "../src/core/text.ts";
import {
	CONTEXT_WINDOW,
	call,
	calls,
	captureTold,
	contextChars,
	gate,
	type Harness,
	openSession,
	relayEntries,
	say,
	sessionFiles,
	textOf,
	waitFor,
	writePresence,
} from "./harness.ts";

const ENV_KEYS = ["PI_RELAY_NUDGE_AT", "PI_RELAY_NUDGE_EVERY", "PI_RELAY_MAX_RESETS", "PI_RELAY_GOAL", "PI_RELAY_CONFIG", "PI_MSG_DIR"] as const;
/** Never the machine's config file: a path nothing writes, unless a test brings its own. */
const NO_CONFIG = join(tmpdir(), `relay-test-no-config-${process.pid}`, "config.json");
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const open: Harness[] = [];

const env = (values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void => {
	for (const key of ENV_KEYS) delete process.env[key];
	Object.assign(process.env, { PI_RELAY_CONFIG: NO_CONFIG }, values);
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const contentText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("");
};

/** One line per entry, to read a branch's order at a glance: `user:hi`, `assistant:calling pad`, `relay:reset`, `compaction`. */
const describeEntry = (entry: SessionEntry): string => {
	switch (entry.type) {
		case "compaction":
			return "compaction";
		case "custom_message":
			return entry.customType === "relay" ? `relay:${(entry.details as { kind?: string }).kind}` : `${entry.customType}:${contentText(entry.content)}`;
		case "message":
			return `${entry.message.role}:${"content" in entry.message ? contentText(entry.message.content) : ""}`;
		default:
			return entry.type;
	}
};

const branchLines = (h: Harness): string[] => h.session.sessionManager.getBranch().map(describeEntry);

const isAsk = (entry: SessionEntry): boolean =>
	entry.type === "custom_message" && entry.customType === "relay" && (entry.details as { kind?: string; byUser?: boolean }).kind === "nudge" && (entry.details as { byUser?: boolean }).byUser === true;

const compactionOf = (entries: readonly SessionEntry[]) => {
	const found = entries.filter((entry) => entry.type === "compaction");
	const [first] = found;
	if (found.length !== 1 || first?.type !== "compaction") throw new Error(`expected one compaction, found ${found.length}`);
	return first;
};

/** The model-facing messages of a request, system prompt left out, as their text. */
const requestTexts = (h: Harness, index: number): string[] => (h.requests[index]?.messages ?? []).filter((message) => message.role !== "system").map(textOf);

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

	test("the config file's rule for the model sets the steps; edits apply live and /relay status names the rule", async () => {
		const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
		const path = join(dir, "config.json");
		const write = (rule: Record<string, unknown>) =>
			writeFileSync(path, JSON.stringify({ nudgeAt: 90, rules: [{ model: "other/*", nudgeAt: 5 }, { model: "faux/tiny", window: "20k", ...rule }] }));
		write({ nudgeAt: 25, nudgeEvery: 10 });
		env({ PI_RELAY_CONFIG: path });
		const told = captureTold();
		try {
			const h = await start();
			h.respond([call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), call("pad", PAD), say("done")]);
			await h.session.prompt("grow the context");
			const steps = relayEntries(h.entries(), "nudge").map((entry) => (entry.details as { step: number }).step);
			expect(steps.length).toBeGreaterThanOrEqual(2);
			for (const step of steps) expect((step - 25) % 10).toBe(0);
			write({ nudgeAt: 95 });
			await h.session.prompt("/relay status");
			const status = told.lines().join("\n");
			expect(status).toContain("(first at 95%, then every 5%)");
			expect(status).toContain(`config: ${path} (rule 2: model faux/tiny, window 20k)`);
			expect(h.errors).toEqual([]);
		} finally {
			told.restore();
			rmSync(dir, { recursive: true, force: true });
		}
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

	test("a relay call with no text after the user's message: the reset message says they haven't seen a reply", async () => {
		env({});
		const h = await start();
		h.respond([calls(["relay", { note: "answered: 4" }]), say("4")]);
		await h.session.prompt("what's 2+2? then relay");
		const reset = relayEntries(h.entries(), "reset")[0];
		expect(contentText(reset?.content)).toContain("the user hasn't seen a reply to their last message (#1): you wrote them nothing after it before the reset.");
		expect(requestTexts(h, 1).at(-1)).toContain("hasn't seen a reply to their last message (#1)");
	});

	test("text in the message that calls relay is a reply", async () => {
		env({});
		const h = await start();
		h.respond([fauxAssistantMessage([fauxText("it's 4"), fauxToolCall("relay", { note: "answered: 4" })], { stopReason: "toolUse" }), say("ok")]);
		await h.session.prompt("what's 2+2? then relay");
		const reset = relayEntries(h.entries(), "reset")[0];
		expect(contentText(reset?.content)).toContain("context reset #1");
		expect(contentText(reset?.content)).not.toContain("hasn't seen a reply");
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

	test("a live sub holds it: no prompt and no stall counted while the parent waits; once the sub ended it goes on", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		const id = h.session.sessionManager.getSessionId();
		writePresence(h.msgDir, "sub-1", { parent: id });
		for (const wake of ["started a sub", "the sub asked something", "the sub asked again", "and again"]) {
			h.respond([say(`waiting for my sub (${wake})`)]);
			await h.session.prompt(wake);
		}
		expect(relayEntries(h.entries(), "loop")).toEqual([]);
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: true, idle: 0, errors: 0 });
		expect(h.requests).toHaveLength(4);
		writePresence(h.msgDir, "sub-1", { parent: id, endedAt: Date.now() });
		h.respond([say("the sub is done"), call("relay", { note: "merged the sub's work", done: true }), say("bye")]);
		await h.session.prompt("the sub ended");
		expect(relayEntries(h.entries(), "loop").map((entry) => entry.details)).toEqual([{ kind: "loop", goal: "g", errors: 0, idle: 0 }]);
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "done" });
	});

	test("someone else's sub, or a sub gone quiet, doesn't hold it", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		writePresence(h.msgDir, "not-mine", { parent: "another-session" });
		writePresence(h.msgDir, "quiet", { parent: h.session.sessionManager.getSessionId(), heartbeatAt: Date.now() - 60_000 });
		h.respond([say("stopping"), call("relay", { note: "done", done: true }), say("bye")]);
		await h.session.prompt("go");
		expect(relayEntries(h.entries(), "loop")).toHaveLength(1);
	});

	test("an error run backs off before the next request, and esc during the wait stops the loop at once", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		h.respond([fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux outage" }), say("never answered")]);
		const told = captureTold();
		try {
			const running = h.session.prompt("go");
			const prompt = await waitFor("the loop's prompt after the error", () => relayEntries(h.entries(), "loop")[0]);
			expect(prompt.details).toEqual({ kind: "loop", goal: "g", errors: 1, idle: 0 });
			await sleep(300);
			expect(h.requests).toHaveLength(1);
			expect(h.session.isStreaming).toBe(true);
			const escAt = Date.now();
			await h.session.abort();
			await running;
			expect(Date.now() - escAt).toBeLessThan(2_000);
			expect(told.lines()).toContain("relay loop: the run failed (1 in a row; the loop stops at 4). trying again in 1m; esc stops the loop.");
		} finally {
			told.restore();
		}
		expect(stateFrom(h.entries()).loop).toMatchObject({ on: false, stopped: "aborted" });
		expect(relayEntries(h.entries(), "loop")).toHaveLength(1);
		expect(h.requests).toHaveLength(1);
		expect(branchLines(h).filter((line) => line.startsWith("assistant:"))).toEqual(["assistant:", "assistant:"]);
		expect(h.session.isIdle).toBe(true);
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
	test("idle: asks the agent for its note and resets at the end of that turn, with the agent's note", async () => {
		env({});
		const h = await start();
		h.respond([say("did a thing")]);
		await h.session.prompt("do a thing");
		h.respond([call("relay", { note: "AGENT-NOTE" }), say("caught up")]);
		await h.session.prompt("/relay");
		const compaction = await waitFor("the reset", () => h.entries().find((entry) => entry.type === "compaction"));
		if (compaction.type !== "compaction") throw new Error("no compaction");
		expect(compaction.summary).toContain("## handoff note\nAGENT-NOTE");
		expect(compaction.summary).not.toContain("the human's note");
		expect(compaction.summary).toContain("asked for by the human");
		expect(compaction.details).toEqual({ relay: { n: 1, percent: expect.any(Number), note: "AGENT-NOTE" } });
		const ask = relayEntries(h.entries(), "nudge")[0];
		expect(ask?.details).toMatchObject({ kind: "nudge", byUser: true });
		expect(relayEntries(h.entries(), "reset")[0]?.details).toMatchObject({ kind: "reset", n: 1, byUser: true });
		await waitFor("the run after the reset", () => (h.requests.length >= 3 ? true : undefined));
	});

	test("/relay <text> resets nothing: it asks whether the text was a goal", async () => {
		env({});
		const h = await start();
		h.respond([say("hello")]);
		await h.session.prompt("hi");
		const before = h.entries().length;
		const told = captureTold();
		try {
			await h.session.prompt("/relay ship the parser");
			h.respond([say("busy")]);
			const running = h.session.prompt("work");
			await h.session.prompt("/relay wrap up first");
			await running;
			expect(told.lines()).toContain(unknownCommandText("ship the parser"));
			expect(told.lines()).toContain(unknownCommandText("wrap up first"));
		} finally {
			told.restore();
		}
		const added = h.entries().slice(before);
		expect(added.some((entry) => entry.type === "compaction" || (entry.type === "custom_message" && entry.customType === "relay"))).toBe(false);
		expect(h.requests).toHaveLength(2);
	});

	test("busy: waits for the run, then asks for the note; the run isn't cut off, and two /relay's are one", async () => {
		env({});
		const h = await start();
		const first = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
			call("pad", { chars: 10 }),
			say("RUN-DONE"),
			call("relay", { note: "AGENT-NOTE: the run is done" }),
			say("AFTER-RESET"),
		]);
		const told = captureTold();
		try {
			const running = h.session.prompt("work in three steps");
			await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
			await h.session.prompt("/relay");
			await h.session.prompt("/relay");
			first.open();
			await running;
			expect(told.lines().filter((line) => line === requestText.waiting())).toHaveLength(1);
			expect(told.lines().filter((line) => line === requestText.duplicate("after-run"))).toHaveLength(1);
		} finally {
			told.restore();
		}
		const lines = branchLines(h);
		const done = lines.indexOf("assistant:RUN-DONE");
		const asked = lines.indexOf("relay:nudge");
		const reset = lines.indexOf("compaction");
		expect(lines.filter((line) => line === "relay:nudge")).toHaveLength(1);
		expect(done).toBeGreaterThan(0);
		expect(lines.slice(0, done).filter((line) => line.startsWith("toolResult:"))).toHaveLength(2);
		expect(asked).toBe(done + 1);
		expect(reset).toBeGreaterThan(asked);
		const compaction = compactionOf(h.entries());
		expect(compaction.details).toMatchObject({ relay: { n: 1, note: "AGENT-NOTE: the run is done" } });
		expect(relayEntries(h.entries(), "reset")[0]?.details).toMatchObject({ kind: "reset", byUser: true });
		expect(h.entries().filter(isAsk)).toHaveLength(1);
		expect(requestTexts(h, 3).at(-1)).toStartWith("[relay] the human asked for a context reset");
		expect(requestTexts(h, 4)).toEqual([expect.stringContaining("The conversation history before this"), expect.stringContaining("[relay] context reset #1")]);
		expect(lines.at(-1)).toBe("assistant:AFTER-RESET");
		expect(h.requests).toHaveLength(5);
		expect(h.errors).toEqual([]);
	});

	test("busy: a follow-up typed while the /relay waits is part of the run, answered before the ask", async () => {
		env({});
		const h = await start();
		const first = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
			say("RUN-DONE"),
			say("DID-FOLLOW-UP"),
			call("relay", { note: "N" }),
			say("AFTER-RESET"),
		]);
		const running = h.session.prompt("work");
		await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
		await h.session.prompt("/relay");
		await h.session.prompt("FOLLOW-UP: one more thing", { streamingBehavior: "followUp" });
		first.open();
		await running;
		const lines = branchLines(h);
		const followUp = lines.indexOf("user:FOLLOW-UP: one more thing");
		expect(followUp).toBeGreaterThan(lines.indexOf("assistant:RUN-DONE"));
		expect(lines.indexOf("assistant:DID-FOLLOW-UP")).toBe(followUp + 1);
		expect(lines.indexOf("relay:nudge")).toBe(followUp + 2);
		expect(lines.indexOf("compaction")).toBeGreaterThan(followUp + 2);
		expect(compactionOf(h.entries()).details).toMatchObject({ relay: { note: "N" } });
	});

	test("busy: the agent resetting on its own first is the human's reset too, and nothing more happens after the run", async () => {
		env({});
		const h = await start();
		const first = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
			call("relay", { note: "OWN-NOTE: nudged, so I handed off" }),
			say("AFTER-RESET"),
		]);
		const told = captureTold();
		try {
			const running = h.session.prompt("work");
			await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
			await h.session.prompt("/relay");
			first.open();
			await running;
			expect(told.lines()).toContain(requestText.covered());
		} finally {
			told.restore();
		}
		await sleep(50);
		expect(compactionOf(h.entries()).details).toMatchObject({ relay: { n: 1, note: "OWN-NOTE: nudged, so I handed off" } });
		expect(relayEntries(h.entries(), "reset")[0]?.details).toMatchObject({ kind: "reset", byUser: true });
		expect(h.entries().filter(isAsk)).toEqual([]);
		expect(branchLines(h).at(-1)).toBe("assistant:AFTER-RESET");
		expect(h.requests).toHaveLength(3);
		h.respond([say("next")]);
		await h.session.prompt("and now?");
		expect(h.entries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	test("busy: an aborted run drops the request and says so; nothing resets later", async () => {
		env({});
		const h = await start();
		const first = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
		]);
		const told = captureTold();
		try {
			const running = h.session.prompt("work");
			await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
			await h.session.prompt("/relay");
			const aborting = h.session.abort();
			first.open();
			await aborting;
			await running;
			expect(told.lines()).toContain(requestText.aborted());
		} finally {
			told.restore();
		}
		h.respond([call("pad", { chars: 10 }), say("fine")]);
		await h.session.prompt("go on");
		await sleep(50);
		expect(h.entries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(h.entries().filter(isAsk)).toEqual([]);
		expect(branchLines(h).at(-1)).toBe("assistant:fine");
	});

	test("busy, loop on: an ask whose turn fails is dropped and said so before the loop goes on, so the loop's turns can't reset", async () => {
		env({ PI_RELAY_GOAL: "g" });
		const h = await start();
		const first = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
			say("RUN-DONE"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux outage" }),
			say("never answered"),
		]);
		const told = captureTold();
		try {
			const running = h.session.prompt("work");
			await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
			await h.session.prompt("/relay");
			first.open();
			const prompt = await waitFor("the loop's prompt after the failed ask", () => relayEntries(h.entries(), "loop")[0]);
			expect(prompt.details).toEqual({ kind: "loop", goal: "g", errors: 1, idle: 0 });
			expect(told.lines()).toContain(requestText.failed());
			await h.session.abort();
			await running;
			expect(told.lines()).not.toContain(requestText.aborted());
		} finally {
			told.restore();
		}
		expect(h.entries().filter(isAsk)).toHaveLength(1);
		expect(h.entries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(h.requests).toHaveLength(3);
		expect(requestTexts(h, 2).at(-1)).toStartWith("[relay] the human asked for a context reset");
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

describe("queued messages survive a reset", () => {
	/** How msg delivers into a working session: a custom message, deliverAs steer. */
	const msgMessage = (text: string) => ({ customType: "msg", content: text, display: true, details: { kind: "message", text } });

	test("a msg message, a steer and a follow-up queued in the relay tool's turn land in the fresh context, in order, each answered", async () => {
		env({});
		const h = await start();
		const held = gate();
		h.respond([
			call("pad", { chars: 8_000 }),
			async () => {
				await held.opened;
				return call("relay", { note: "Q-NOTE: padded; next: what the queue says" });
			},
			say("DID-MSG"),
			say("DID-STEER"),
			say("DID-FOLLOW-UP"),
		]);
		const running = h.session.prompt("pad, then relay");
		await waitFor("the relay turn's request", () => (h.requests.length >= 2 ? true : undefined));
		await h.session.sendCustomMessage(msgMessage("MSG-1: the sub reports"), { triggerTurn: true, deliverAs: "steer" });
		await h.session.prompt("STEER-1: also check the logs", { streamingBehavior: "steer" });
		await h.session.prompt("FOLLOW-UP-1: then summarize", { streamingBehavior: "followUp" });
		expect(h.session.pendingMessageCount).toBe(2);
		held.open();
		await running;
		const lines = branchLines(h);
		const reset = lines.indexOf("compaction");
		expect(reset).toBeGreaterThan(0);
		expect(lines.slice(0, reset).some((line) => /MSG-1|STEER-1|FOLLOW-UP-1/.test(line))).toBe(false);
		expect(lines.slice(reset)).toEqual([
			"compaction",
			"relay:reset",
			"msg:MSG-1: the sub reports",
			"assistant:DID-MSG",
			"user:STEER-1: also check the logs",
			"assistant:DID-STEER",
			"user:FOLLOW-UP-1: then summarize",
			"assistant:DID-FOLLOW-UP",
		]);
		const fresh = [expect.stringContaining("The conversation history before this"), expect.stringContaining("[relay] context reset #1")];
		expect(requestTexts(h, 2)).toEqual([...fresh, "MSG-1: the sub reports"]);
		expect(requestTexts(h, 3)).toEqual([...fresh, "MSG-1: the sub reports", "DID-MSG", "STEER-1: also check the logs"]);
		expect(requestTexts(h, 4).at(-1)).toBe("FOLLOW-UP-1: then summarize");
		expect(contextChars(h.requests[2]!)).toBeLessThan(contextChars(h.requests[1]!) / 2);
		expect(h.session.pendingMessageCount).toBe(0);
		expect(h.errors).toEqual([]);
	});

	test("what's typed while the agent writes its note for a /relay lands after that reset", async () => {
		env({});
		const h = await start();
		const first = gate();
		const note = gate();
		h.respond([
			async () => {
				await first.opened;
				return call("pad", { chars: 10 });
			},
			say("RUN-DONE"),
			async () => {
				await note.opened;
				return call("relay", { note: "N" });
			},
			say("DID-STEER"),
			say("DID-FOLLOW-UP"),
		]);
		const running = h.session.prompt("work");
		await waitFor("the run's first request", () => (h.requests.length >= 1 ? true : undefined));
		await h.session.prompt("/relay");
		first.open();
		await waitFor("the ask's turn", () => (h.requests.length >= 3 ? true : undefined));
		await h.session.prompt("STEER-2", { streamingBehavior: "steer" });
		await h.session.prompt("FOLLOW-UP-2", { streamingBehavior: "followUp" });
		note.open();
		await running;
		const lines = branchLines(h);
		expect(lines.slice(lines.indexOf("relay:nudge"))).toEqual([
			"relay:nudge",
			"assistant:calling relay",
			expect.stringMatching(/^toolResult:reset #1 queued/),
			"compaction",
			"relay:reset",
			"user:STEER-2",
			"assistant:DID-STEER",
			"user:FOLLOW-UP-2",
			"assistant:DID-FOLLOW-UP",
		]);
		expect(requestTexts(h, 3)).toEqual([
			expect.stringContaining("The conversation history before this"),
			expect.stringContaining("[relay] context reset #1"),
			"STEER-2",
		]);
		expect(relayEntries(h.entries(), "reset")[0]?.details).toMatchObject({ byUser: true, note: "N" });
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
