import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requestText, unknownCommandText } from "../src/core/text.ts";
import {
	assistantText,
	type Check,
	check,
	clip,
	detailsOf,
	HOLD_EXTENSION,
	isAssistant,
	type Json,
	messageOf,
	notices,
	piArgs,
	relayMessages,
	relayResults,
	relaySwitches,
	report,
	requestTokens,
	responseTo,
	send,
	sessionFiles,
	sessionLines,
	sleep,
	spawnPi,
	textOf,
	toolCalls,
	waitUntil,
	within,
	world,
} from "./lib.ts";

const RUN_TIMEOUT_MS = 6 * 60_000;
const LOOKUP_USER_LINE = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+\S+\s+[0-9a-f]{8}:\d+\s+user/;

const failure = (error: unknown): Check => check("scenario ran", false, error instanceof Error ? error.message : String(error));

/**
 * claude-haiku-5-5 has a 1M window and pi's system prompt alone is ~0.9% of it, so the steps start
 * above that and are tenths of a percent. The relay tool is excluded: a model that obeys the nudge
 * would reset, and the steps would start over.
 */
export const nudge = async (): Promise<boolean> => {
	const at = 1.1;
	const every = 0.3;
	const w = world("nudge", { PI_RELAY_NUDGE_AT: String(at), PI_RELAY_NUDGE_EVERY: String(every) });
	const checks: Check[] = [];
	try {
		const prompt = [
			"Run these bash commands, exactly one per turn, in this order: `seq 1 2500`, then `seq 2501 5000`, then `seq 5001 7500`, then `seq 7501 10000`.",
			"After the fourth, reply with just DONE.",
		].join(" ");
		const run = spawnPi(w, piArgs(w, ["--exclude-tools", "relay", "-p", prompt]));
		const result = await within("pi -p", run.done, RUN_TIMEOUT_MS);
		const lines = sessionLines(w);
		const nudges = relayMessages(lines, "nudge").map((line) => ({ line, details: detailsOf(line), at: lines.indexOf(line) }));
		const steps = nudges.map((item) => Number(item.details.step));
		const turnEnds = lines.flatMap((line, index) => {
			const next = lines[index + 1];
			const role = messageOf(line)?.role;
			const nextRole = next ? messageOf(next)?.role : undefined;
			return (role === "assistant" || role === "toolResult") && nextRole !== "toolResult" ? [index] : [];
		});
		const highestStep = (percent: number) => at + Math.floor((percent - at) / every + 1e-6) * every;
		checks.push(
			check("pi -p exits 0", result.code === 0, clip(result.stderr)),
			check("at least two nudges, steps rising: one nudge per step", nudges.length >= 2 && steps.every((step, index) => index === 0 || step > (steps[index - 1] ?? Infinity)), JSON.stringify(nudges.map((item) => item.details))),
			check("the first nudge is at the first step or above", (steps[0] ?? 0) >= at - 1e-6),
			check(
				"each nudge is at its step: the highest step its percent reached",
				nudges.every(({ details }) => Math.abs(Number(details.step) - highestStep(Number(details.percent))) < 1e-6),
				JSON.stringify(nudges.map((item) => item.details)),
			),
			check("each nudge lands at the end of a turn", nudges.every((item) => turnEnds.includes(item.at - 1))),
			check("nudges are visible relay messages", nudges.every(({ line }) => line.display === true && String(line.content).startsWith("[relay] you're at"))),
			check("no reset without a relay call", lines.every((line) => line.type !== "compaction")),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("nudge: relay messages at 1.1%, then every 0.3%", checks);
};

export const reset = async (): Promise<boolean> => {
	const w = world("reset", { PI_RELAY_NUDGE_AT: "1", PI_RELAY_NUDGE_EVERY: "50" });
	const checks: Check[] = [];
	try {
		const prompt = [
			"This is a test of the relay tool.",
			"1) Run `seq 1 9000` with bash, once.",
			"2) When a [relay] message says how full your context is, call the relay tool with the note exactly: RELAY-E2E-NOTE seq ran; next: reply RESUMED",
			"3) After your context is reset, reply with exactly RESUMED and nothing else.",
		].join("\n");
		const run = spawnPi(w, piArgs(w, ["-p", prompt]));
		const result = await within("pi -p", run.done, RUN_TIMEOUT_MS);
		const files = sessionFiles(w);
		const lines = sessionLines(w);
		const header = lines[0] ?? {};
		const id = String(header.id ?? "");
		const compactions = lines.filter((line) => line.type === "compaction");
		const compaction: Json = compactions[0] ?? {};
		const at = lines.indexOf(compaction);
		const after = lines.slice(at + 1);
		const before = lines.slice(0, Math.max(at, 0));
		const lastBefore = before.filter(isAssistant).at(-1);
		const firstAfter = after.find(isAssistant);
		const summary = String(compaction.summary ?? "");
		checks.push(
			check("pi -p exits 0", result.code === 0, clip(result.stderr)),
			check("one session file, same id throughout", files.length === 1 && id !== "" && (files[0] ?? "").includes(id), files.join(", ")),
			check("exactly one compaction", compactions.length === 1, `${compactions.length}`),
			check("retain-none: firstKeptEntryId is its own id, from a hook", compaction.firstKeptEntryId === compaction.id && compaction.fromHook === true, clip(JSON.stringify({ ...compaction, summary: "…" }))),
			check("details.relay carries n and the note", detailsOf(compaction).relay !== undefined && JSON.stringify(detailsOf(compaction).relay).includes("RELAY-E2E-NOTE")),
			check("the reset message follows the compaction", relayMessages([after[0] ?? {}], "reset").length === 1, clip(JSON.stringify(after[0]))),
			check("the run continued after the reset", firstAfter !== undefined),
			check(
				"the next request is small",
				lastBefore !== undefined && firstAfter !== undefined && requestTokens(firstAfter) < requestTokens(lastBefore) * 0.7,
				`before ${lastBefore ? requestTokens(lastBefore) : "?"} tokens, after ${firstAfter ? requestTokens(firstAfter) : "?"}`,
			),
			check("the summary says it's the same session", summary.includes(`this is still session ${id}`), clip(summary, 300)),
			check("the summary has the note", summary.includes("RELAY-E2E-NOTE")),
			check("the summary has lookup's catch-up of this session", LOOKUP_USER_LINE.test(summary) && summary.includes(`catchup ${id} -n 30`), clip(summary.slice(summary.indexOf("## recent conversation")), 500)),
			check("the agent picked up after the reset", after.filter(isAssistant).some((line) => assistantText(line).includes("RESUMED")), clip(after.filter(isAssistant).map(assistantText).join(" | "))),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("reset: the relay tool resets the context in place", checks);
};

export const loop = async (): Promise<boolean> => {
	const goal = "create the files a.txt, b.txt and c.txt in the current directory, each containing its own letter";
	const w = world("loop", { PI_RELAY_GOAL: goal });
	const checks: Check[] = [];
	try {
		const prompt = "Create a.txt containing the letter a, using bash. Then end your turn right away: don't create any other file in this turn.";
		const run = spawnPi(w, piArgs(w, ["-p", prompt]));
		const result = await within("pi -p", run.done, RUN_TIMEOUT_MS);
		const lines = sessionLines(w);
		const prompts = relayMessages(lines, "loop").filter((line) => detailsOf(line).stopped === undefined);
		const done = relayResults(lines).find((line) => detailsOf(line).outcome === "done");
		const doneAt = done ? lines.indexOf(done) : -1;
		const launched = relaySwitches(lines).find((line) => JSON.stringify(line.data).includes('"by":"launch"'));
		checks.push(
			check("pi -p exits 0 once the loop ends", result.code === 0, clip(result.stderr)),
			check("the launch goal switched the loop on", launched !== undefined),
			check("the loop continued past a settle", prompts.length >= 1, `${prompts.length} loop prompt(s)`),
			check("the agent ended it with relay done: true", done !== undefined),
			check("no loop prompt after done", doneAt >= 0 && prompts.every((line) => lines.indexOf(line) < doneAt)),
			check("the goal got done", ["a", "b", "c"].every((letter) => existsSync(join(w.cwd, `${letter}.txt`)))),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("loop: PI_RELAY_GOAL keeps a pi -p run going until relay done", checks);
};

export const abort = async (): Promise<boolean> => {
	const goal = "count upward forever: each turn, run `echo N` with bash for the next N, starting at 1. never call relay with done";
	const w = world("abort", { PI_RELAY_GOAL: goal });
	const checks: Check[] = [];
	try {
		const run = spawnPi(w, piArgs(w, ["--mode", "rpc"]), true);
		run.proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Run `echo 1` with bash, then end your turn." })}\n`);
		await waitUntil("a loop prompt (the loop continued once)", () => (relayMessages(sessionLines(w), "loop").length > 0 ? true : undefined), 3 * 60_000);
		await sleep(1_500);
		run.proc.stdin.write(`${JSON.stringify({ id: "a1", type: "abort" })}\n`);
		const off = await waitUntil(
			"the loop switched off by the abort",
			() => relaySwitches(sessionLines(w)).find((line) => JSON.stringify(line.data).includes('"reason":"aborted"')),
			60_000,
		).catch(() => undefined);
		await sleep(10_000);
		const lines = sessionLines(w);
		const offAt = off ? lines.findIndex((line) => line.id === off.id) : -1;
		run.proc.stdin.end();
		checks.push(
			check("the abort switched the loop off", off !== undefined, clip(JSON.stringify(relaySwitches(lines)))),
			check("nothing ran after it", offAt >= 0 && !lines.slice(offAt + 1).some(isAssistant), `${lines.slice(offAt + 1).length} entries after`),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("abort: esc/abort stops the loop (rpc mode)", checks);
};

const isAsk = (line: Json): boolean => relayMessages([line], "nudge").length === 1 && detailsOf(line).byUser === true;

const dataOf = (line: Json | undefined): Json => {
	const data = line?.data;
	return typeof data === "object" && data !== null ? (data as Json) : {};
};

/** The session's lines after its one compaction, once an assistant has answered there. */
const answeredAfterReset = (lines: readonly Json[]): true | undefined => {
	const at = lines.findIndex((line) => line.type === "compaction");
	return at >= 0 && lines.slice(at).some(isAssistant) ? true : undefined;
};

/**
 * A /relay sent while the agent works waits for its run: the agent finishes all three steps, then it's
 * asked for its note, and the context resets at the end of that turn. Two /relay's are one request, and
 * /relay with text resets nothing.
 */
export const midrun = async (): Promise<boolean> => {
	const w = world("midrun", { PI_RELAY_NUDGE_AT: "90" });
	const checks: Check[] = [];
	try {
		const prompt = [
			"This is a test of a context reset the human asks for.",
			"1) Run these three bash commands, exactly one per turn, in this order: `sleep 3; echo STEP-ONE`, then `sleep 3; echo STEP-TWO`, then `sleep 3; echo STEP-THREE`.",
			"2) After the third, reply with exactly ALL-DONE and end your turn.",
			"3) If a [relay] message then asks you for a handoff note, call the relay tool with the note exactly: MIDRUN-NOTE three steps done; next: reply RESUMED",
			"4) After your context is reset, reply with exactly RESUMED and nothing else.",
		].join("\n");
		const run = spawnPi(w, piArgs(w, ["--mode", "rpc"]), true);
		send(run, { id: "p1", type: "prompt", message: prompt });
		await waitUntil("the first bash call", () => (sessionLines(w).some((line) => toolCalls(line).includes("bash")) ? true : undefined), 3 * 60_000);
		const busy = sessionLines(w);
		send(run, { id: "r1", type: "prompt", message: "/relay" });
		send(run, { id: "r2", type: "prompt", message: "/relay" });
		send(run, { id: "r3", type: "prompt", message: "/relay make it quick" });
		await waitUntil("an answer after the reset", () => answeredAfterReset(sessionLines(w)), 4 * 60_000);
		await sleep(3_000);
		run.proc.stdin.end();
		const result = await within("pi rpc to exit", run.done, 60_000);
		const lines = sessionLines(w);
		const told = notices(result.stdout);
		const compactions = lines.filter((line) => line.type === "compaction");
		const at = (find: (line: Json) => boolean) => lines.findIndex(find);
		const stepThree = at((line) => messageOf(line)?.role === "toolResult" && textOf(line).includes("STEP-THREE"));
		const allDone = at((line) => isAssistant(line) && assistantText(line).includes("ALL-DONE"));
		const asks = lines.filter(isAsk);
		const ask = at(isAsk);
		const reset = at((line) => line.type === "compaction");
		const resetMessage = relayMessages(lines, "reset")[0];
		const after = lines.slice(reset + 1).filter(isAssistant).map(assistantText);
		checks.push(
			check("the /relay's came in while the agent worked", busy.filter((line) => messageOf(line)?.role === "toolResult").length < 3 && !busy.some((line) => line.type === "compaction")),
			check("exactly one ask for a handoff note, and one reset: two /relay's are one request", asks.length === 1 && compactions.length === 1, `${asks.length} ask(s), ${compactions.length} compaction(s)`),
			check("the run wasn't cut off: all three steps ran, and it ended, before the ask", stepThree >= 0 && allDone > stepThree && ask > allDone, `step three at ${stepThree}, ALL-DONE at ${allDone}, ask at ${ask}`),
			check("nothing reset before the ask", reset > ask, `ask at ${ask}, compaction at ${reset}`),
			check("the reset carries the agent's own note", JSON.stringify(detailsOf(compactions[0]).relay ?? {}).includes("MIDRUN-NOTE"), clip(JSON.stringify(detailsOf(compactions[0])))),
			check("the reset is marked as the human's", detailsOf(resetMessage).byUser === true, clip(JSON.stringify(detailsOf(resetMessage)))),
			check("the agent picked up after the reset", after.some((text) => text.includes("RESUMED")), clip(after.join(" | "))),
			check("the human heard it waits for the run, once, then that it was already asked", told.filter((text) => text === requestText.waiting()).length === 1 && told.includes(requestText.duplicate("after-run")), clip(told.join(" | "))),
			check("/relay with text resets nothing and asks if it was a goal", told.includes(unknownCommandText("make it quick"))),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("midrun: a /relay sent while the agent works waits for its run (rpc mode)", checks);
};

/**
 * A msg-style custom message (deliverAs steer), a steer and a follow-up, all queued in the turn whose
 * relay call resets the context, land after the reset, in the fresh context, in order, and get done.
 * e2e/hold.ts holds the relay call long enough to queue them inside that turn.
 */
export const queue = async (): Promise<boolean> => {
	const w = world("queue", { PI_RELAY_NUDGE_AT: "90", PI_RELAY_MAX_RESETS: "1", RELAY_E2E_HOLD_MS: "8000" });
	const marker = join(w.sessions, "..", "held");
	w.env.RELAY_E2E_HOLD_MARKER = marker;
	const checks: Check[] = [];
	try {
		const prompt = [
			"This is a test of messages queued while your context resets.",
			"1) Call the relay tool now, before anything else, with the note exactly: QUEUE-NOTE nothing done yet; next: do what each message after the reset says",
			"2) After your context is reset, messages arrive one at a time. Do exactly what each one says, with bash, then end your turn. Don't call relay again.",
		].join("\n");
		const run = spawnPi(w, piArgs(w, ["-e", HOLD_EXTENSION, "--mode", "rpc"]), true);
		send(run, { id: "p1", type: "prompt", message: prompt });
		await waitUntil("the relay call, held", () => (existsSync(marker) ? true : undefined), 3 * 60_000, 100);
		const queuedAt = Date.now();
		send(run, { id: "s1", type: "prompt", message: "QUEUED-STEER: run `echo s > steer.txt` with bash.", streamingBehavior: "steer" });
		send(run, { id: "f1", type: "prompt", message: "QUEUED-FOLLOWUP: run `echo f > follow.txt` with bash.", streamingBehavior: "followUp" });
		await waitUntil("follow.txt", () => (existsSync(join(w.cwd, "follow.txt")) ? true : undefined), 4 * 60_000);
		await sleep(5_000);
		run.proc.stdin.end();
		const result = await within("pi rpc to exit", run.done, 60_000);
		const lines = sessionLines(w);
		const compactions = lines.filter((line) => line.type === "compaction");
		const reset = lines.findIndex((line) => line.type === "compaction");
		const landed = (tag: string) => lines.findIndex((line) => (line.type === "custom_message" || messageOf(line)?.role === "user") && textOf(line).startsWith(tag));
		const order = ["QUEUED-MSG", "QUEUED-STEER", "QUEUED-FOLLOWUP"].map(landed);
		const [msgAt = -1, steerAt = -1, followUpAt = -1] = order;
		const file = (name: string) => (existsSync(join(w.cwd, name)) ? readFileSync(join(w.cwd, name), "utf8").trim() : "(missing)");
		const queued = ["s1", "f1"].map((id) => dataOf(responseTo(result.stdout, id)).disposition);
		const resetAt = Date.parse(String(compactions[0]?.timestamp ?? ""));
		checks.push(
			check("exactly one reset", compactions.length === 1, `${compactions.length}`),
			check("the steer and the follow-up were queued while the agent worked", queued.every((disposition) => disposition === "queued"), JSON.stringify(queued)),
			check("they were queued before the reset was written", resetAt > queuedAt, `queued at ${new Date(queuedAt).toISOString()}, reset at ${compactions[0]?.timestamp}`),
			check("all three land after the reset, in the fresh context", order.every((index) => index > reset) && reset >= 0, `compaction at ${reset}, queued at ${order.join(", ")}`),
			check("in order: the msg-style steer, the steer, then the follow-up", msgAt < steerAt && steerAt < followUpAt, order.join(" < ")),
			check("the reset message opens the fresh context, before them", relayMessages([lines[reset + 1] ?? {}], "reset").length === 1),
			check("each got done", file("msg.txt") === "m" && file("steer.txt") === "s" && file("follow.txt") === "f", `msg.txt ${file("msg.txt")}, steer.txt ${file("steer.txt")}, follow.txt ${file("follow.txt")}`),
		);
	} catch (error) {
		checks.push(failure(error));
	} finally {
		w.dispose();
	}
	return report("queue: a steer, a follow-up and a msg-style message queued in the reset's turn land after it (rpc mode)", checks);
};

export const SCENARIOS = { nudge, reset, loop, abort, midrun, queue } as const;
