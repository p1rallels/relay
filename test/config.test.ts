import { describe, expect, test } from "bun:test";
import { DEFAULT_NUDGE_AT, DEFAULT_NUDGE_EVERY, readConfig } from "../src/core/config.ts";

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
