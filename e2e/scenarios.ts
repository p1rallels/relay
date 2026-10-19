import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	assistantText,
	type Check,
	check,
	clip,
	detailsOf,
	isAssistant,
	type Json,
	messageOf,
	piArgs,
	relayMessages,
	relayResults,
	relaySwitches,
	report,
	requestTokens,
	sessionFiles,
	sessionLines,
	sleep,
	spawnPi,
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
	const w = world("reset", { PI_RELAY_NUDGE_AT: "0.5", PI_RELAY_NUDGE_EVERY: "50" });
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

export const SCENARIOS = { nudge, reset, loop, abort } as const;
