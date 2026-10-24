import { describe, expect, test } from "bun:test";
import {
	configPath,
	DEFAULT_NUDGE_AT,
	DEFAULT_NUDGE_EVERY,
	EMPTY_FILE,
	fileConfigFrom,
	formatWindow,
	type ModelRef,
	modelMatches,
	parseWindow,
	readConfig,
	ruleFor,
	windowMatches,
} from "../src/core/config.ts";

const noFlags = () => undefined;

describe("readConfig", () => {
	test("defaults: 40, every 5, no cap, no goal", () => {
		const { config, warnings } = readConfig({}, noFlags);
		expect(config).toEqual({ nudgeAt: DEFAULT_NUDGE_AT, nudgeEvery: DEFAULT_NUDGE_EVERY, maxResets: undefined, goal: undefined });
		expect(warnings).toEqual([]);
	});
	test("env", () => {
		const { config } = readConfig({ PI_RELAY_NUDGE_AT: "1.5", PI_RELAY_NUDGE_EVERY: "0.5", PI_RELAY_MAX_RESETS: "3", PI_RELAY_GOAL: "  ship it  " }, noFlags);
		expect(config).toEqual({ nudgeAt: 1.5, nudgeEvery: 0.5, maxResets: 3, goal: "ship it" });
	});
	test("a flag wins over the env; a bare boolean flag counts as unset", () => {
		const flags: Record<string, string | boolean> = { "relay-nudge-at": "60", "relay-goal": true };
		const { config } = readConfig({ PI_RELAY_NUDGE_AT: "10", PI_RELAY_GOAL: "from env" }, (name) => flags[name]);
		expect(config.nudgeAt).toBe(60);
		expect(config.goal).toBe("from env");
	});
	test("a cap of 0 is allowed (no resets)", () => {
		expect(readConfig({ PI_RELAY_MAX_RESETS: "0" }, noFlags).config.maxResets).toBe(0);
	});
	test("bad values fall back with a warning", () => {
		const { config, warnings } = readConfig({ PI_RELAY_NUDGE_AT: "-3", PI_RELAY_NUDGE_EVERY: "lots", PI_RELAY_MAX_RESETS: "2.5" }, noFlags);
		expect(config.nudgeAt).toBe(DEFAULT_NUDGE_AT);
		expect(config.nudgeEvery).toBe(DEFAULT_NUDGE_EVERY);
		expect(config.maxResets).toBeUndefined();
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain("PI_RELAY_NUDGE_AT=-3");
	});
	test("empty values count as unset", () => {
		expect(readConfig({ PI_RELAY_NUDGE_AT: " ", PI_RELAY_GOAL: "" }, noFlags)).toEqual({
			config: { nudgeAt: DEFAULT_NUDGE_AT, nudgeEvery: DEFAULT_NUDGE_EVERY, maxResets: undefined, goal: undefined },
			warnings: [],
		});
	});
});

const file = (value: unknown) => fileConfigFrom({ kind: "json", path: "/c.json", value });
const model = (provider: string, id: string, contextWindow?: number): ModelRef => ({ provider, id, contextWindow });

describe("configPath", () => {
	test("PI_RELAY_CONFIG, else the agent dir's extensions/relay-loop/config.json", () => {
		expect(configPath({ PI_RELAY_CONFIG: "~/relay.json" }, "/home/u")).toBe("/home/u/relay.json");
		expect(configPath({ PI_CODING_AGENT_DIR: "/agent" }, "/home/u")).toBe("/agent/extensions/relay-loop/config.json");
		expect(configPath({ PI_RELAY_CONFIG: " " }, "/home/u")).toBe("/home/u/.pi/agent/extensions/relay-loop/config.json");
	});
});

describe("parseWindow", () => {
	test("tokens, k and m, case-insensitive", () => {
		expect(parseWindow(272000)).toBe(272_000);
		expect(parseWindow("272k")).toBe(272_000);
		expect(parseWindow("1M")).toBe(1_000_000);
		expect(parseWindow("1.05m")).toBe(1_050_000);
		expect(parseWindow(" 400K ")).toBe(400_000);
	});
	test("anything else is not a window", () => {
		for (const bad of ["", "0", "1g", "-5k", "k", 0, -1, null, true]) expect(parseWindow(bad)).toBeUndefined();
	});
	test("formats back", () => {
		expect([272_000, 1_000_000, 1_048_576, 262_144].map(formatWindow)).toEqual(["272k", "1m", "1.05m", "262.1k"]);
	});
});

describe("rules", () => {
	test("model globs match provider/id or id, case-insensitive", () => {
		const opus = model("openrouter", "anthropic/claude-opus-5", 1_000_000);
		expect(modelMatches("*opus*", opus)).toBe(true);
		expect(modelMatches("anthropic/claude-opus-5", opus)).toBe(true);
		expect(modelMatches("openrouter/*", opus)).toBe(true);
		expect(modelMatches("OPENROUTER/ANTHROPIC/*", opus)).toBe(true);
		expect(modelMatches("anthropic/*", model("anthropic", "claude-opus-5"))).toBe(true);
		expect(modelMatches("claude-opus-5", model("anthropic", "claude-opus-5.5"))).toBe(false);
		expect(modelMatches("gpt-5.5", model("openai", "gpt-5x5"))).toBe(false);
	});
	test("windows match within 10%", () => {
		expect(windowMatches(1_000_000, 1_048_576)).toBe(true);
		expect(windowMatches(1_000_000, 1_050_000)).toBe(true);
		expect(windowMatches(272_000, 262_144)).toBe(true);
		expect(windowMatches(272_000, 400_000)).toBe(false);
		expect(windowMatches(1_000_000, 800_000)).toBe(false);
		expect(windowMatches(272_000, undefined)).toBe(false);
	});
	test("the first rule whose matchers all hold applies", () => {
		const { file: parsed } = file({
			rules: [
				{ model: "openrouter/*", window: "1m", nudgeAt: 50 },
				{ window: "1m", nudgeAt: 40 },
				{ model: "*gpt-5.5*", window: "272k", nudgeAt: 95 },
			],
		});
		expect(ruleFor(parsed.rules, model("openrouter", "openai/gpt-5.5", 1_050_000))).toBe(0);
		expect(ruleFor(parsed.rules, model("anthropic", "claude-opus-5", 1_000_000))).toBe(1);
		expect(ruleFor(parsed.rules, model("openai-codex", "gpt-5.5", 272_000))).toBe(2);
		expect(ruleFor(parsed.rules, model("openai", "gpt-5.4-mini", 400_000))).toBeUndefined();
		expect(ruleFor(parsed.rules, model("anthropic", "claude-opus-5", undefined))).toBeUndefined();
		expect(ruleFor(parsed.rules, undefined)).toBeUndefined();
	});
});

describe("fileConfigFrom", () => {
	test("absent: nothing, no warnings", () => {
		expect(fileConfigFrom({ kind: "absent", path: "/c.json" })).toEqual({ file: EMPTY_FILE, warnings: [] });
	});
	test("broken or not an object: nothing, one warning", () => {
		expect(fileConfigFrom({ kind: "broken", path: "/c.json", error: "not valid JSON" }).warnings).toEqual(["/c.json: not valid JSON; ignoring the file"]);
		expect(file([1, 2]).warnings).toEqual(["/c.json: not a JSON object; ignoring the file"]);
	});
	test("a valid file", () => {
		const { file: parsed, warnings } = file({ nudgeAt: 30, nudgeEvery: 2, maxResets: 0, rules: [{ model: "*opus*", window: "1m", nudgeAt: 40, nudgeEvery: 10 }] });
		expect(warnings).toEqual([]);
		expect(parsed).toEqual({ nudgeAt: 30, nudgeEvery: 2, maxResets: 0, rules: [{ model: "*opus*", window: 1_000_000, nudgeAt: 40, nudgeEvery: 10 }] });
	});
	test("bad fields are left out with a warning; a rule with a bad matcher or no setting is skipped", () => {
		const { file: parsed, warnings } = file({
			nudge_at: 10,
			nudgeAt: -1,
			maxResets: 1.5,
			rules: [{ model: "", nudgeAt: 5 }, { window: "huge", nudgeAt: 5 }, { model: "*opus*" }, "nope", { model: "*haiku*", nudgeAt: "abc", nudgeEvery: 3, extra: 1 }],
		});
		expect(parsed).toEqual({ nudgeAt: undefined, nudgeEvery: undefined, maxResets: undefined, rules: [{ model: "*haiku*", window: undefined, nudgeAt: undefined, nudgeEvery: 3 }] });
		expect(warnings).toEqual([
			'/c.json: unknown key "nudge_at", ignored',
			"/c.json: nudgeAt -1 is not a positive number, ignored",
			"/c.json: maxResets 1.5 is not a whole number ≥ 0, ignored",
			'/c.json: rule 1: model "" is not a non-empty glob, skipped',
			'/c.json: rule 2: window "huge" is not a token count like 272k or 1m, skipped',
			"/c.json: rule 3: sets neither nudgeAt nor nudgeEvery, skipped",
			"/c.json: rule 4: not an object, skipped",
			'/c.json: rule 5: unknown key "extra", ignored',
			'/c.json: rule 5: nudgeAt "abc" is not a positive number, ignored',
		]);
	});
	test("rules that aren't a list are ignored", () => {
		expect(file({ rules: { model: "*" } }).warnings).toEqual(["/c.json: rules is not an array, ignored"]);
	});
});

describe("readConfig with a file", () => {
	const { file: parsed } = file({ nudgeAt: 30, nudgeEvery: 2, maxResets: 4, rules: [{ model: "*gpt-5.5*", window: "272k", nudgeAt: 95 }] });
	const codex = model("openai-codex", "gpt-5.5", 272_000);
	test("defaults < file < the matching rule; a rule's missing field falls back to the file's", () => {
		expect(readConfig({}, noFlags, parsed, model("anthropic", "claude-opus-5", 1_000_000))).toEqual({
			config: { nudgeAt: 30, nudgeEvery: 2, maxResets: 4, goal: undefined },
			warnings: [],
			rule: undefined,
		});
		expect(readConfig({}, noFlags, parsed, codex)).toEqual({ config: { nudgeAt: 95, nudgeEvery: 2, maxResets: 4, goal: undefined }, warnings: [], rule: 0 });
	});
	test("env and flags win over the file and its rules", () => {
		const flags: Record<string, string> = { "relay-nudge-every": "7" };
		const { config } = readConfig({ PI_RELAY_NUDGE_AT: "20", PI_RELAY_MAX_RESETS: "1" }, (name) => flags[name], parsed, codex);
		expect(config).toEqual({ nudgeAt: 20, nudgeEvery: 7, maxResets: 1, goal: undefined });
	});
	test("a bad env value falls back to the file's", () => {
		const { config, warnings } = readConfig({ PI_RELAY_NUDGE_AT: "x" }, noFlags, parsed, codex);
		expect(config.nudgeAt).toBe(95);
		expect(warnings).toEqual(["PI_RELAY_NUDGE_AT=x is not a positive number; using 95"]);
	});
});
