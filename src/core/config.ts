import { join } from "node:path";
import { agentDir, type Env, expandHome, nonEmpty } from "./paths.ts";

export type { Env } from "./paths.ts";

export const DEFAULT_NUDGE_AT = 40;
export const DEFAULT_NUDGE_EVERY = 5;
/** A rule's window matches a model's within this fraction, so "1m" covers 1,048,576 and 1,050,000. */
export const WINDOW_TOLERANCE = 0.1;
export const CONFIG_ENV = "PI_RELAY_CONFIG";

export interface RelayConfig {
	/** First nudge, in percent of the model's context window. */
	readonly nudgeAt: number;
	/** Nudge again each time usage crosses another step of this many percent. */
	readonly nudgeEvery: number;
	/** How many resets the relay tool may do in one session; undefined means no cap. */
	readonly maxResets: number | undefined;
	/** Keep-going goal given at launch, for headless runs. */
	readonly goal: string | undefined;
}

export const SETTINGS = {
	nudgeAt: { env: "PI_RELAY_NUDGE_AT", flag: "relay-nudge-at" },
	nudgeEvery: { env: "PI_RELAY_NUDGE_EVERY", flag: "relay-nudge-every" },
	maxResets: { env: "PI_RELAY_MAX_RESETS", flag: "relay-max-resets" },
	goal: { env: "PI_RELAY_GOAL", flag: "relay-goal" },
} as const;

type Setting = (typeof SETTINGS)[keyof typeof SETTINGS];

export type FlagReader = (name: string) => string | boolean | undefined;

/** The session's model, as rules match it. */
export interface ModelRef {
	readonly provider: string;
	readonly id: string;
	readonly contextWindow: number | undefined;
}

/** A config file rule: the first one whose matchers all hold for the model applies. */
export interface ConfigRule {
	/** Glob (`*` is any run of characters, case-insensitive) on `provider/id` or `id`. */
	readonly model: string | undefined;
	/** Context window in tokens, matched within WINDOW_TOLERANCE. */
	readonly window: number | undefined;
	readonly nudgeAt: number | undefined;
	readonly nudgeEvery: number | undefined;
}

export interface FileConfig {
	readonly nudgeAt: number | undefined;
	readonly nudgeEvery: number | undefined;
	readonly maxResets: number | undefined;
	readonly rules: readonly ConfigRule[];
}

export const EMPTY_FILE: FileConfig = { nudgeAt: undefined, nudgeEvery: undefined, maxResets: undefined, rules: [] };

/** What reading the config file found; the reading itself is the adapter's. */
export type ConfigFileRead =
	| { readonly kind: "absent"; readonly path: string }
	| { readonly kind: "json"; readonly path: string; readonly value: unknown }
	| { readonly kind: "broken"; readonly path: string; readonly error: string };

export interface ConfigResult {
	readonly config: RelayConfig;
	readonly warnings: readonly string[];
	/** Index of the file's rule that applies to the model, if one does. */
	readonly rule?: number | undefined;
}

/** $PI_RELAY_CONFIG, else <agent dir>/extensions/relay-loop/config.json; pi loads no extension from a folder without an index. */
export const configPath = (env: Env, home: string): string => {
	const configured = nonEmpty(env[CONFIG_ENV]);
	if (configured) return expandHome(configured, home);
	return join(agentDir(env, home), "extensions", "relay-loop", "config.json");
};

const textOf = (value: string | boolean | undefined): string | undefined => {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text === "" ? undefined : text;
};

/** A flag wins over the environment; empty values count as unset. */
const raw = (setting: Setting, env: Env, flag: FlagReader): { readonly text: string; readonly from: string } | undefined => {
	const fromFlag = textOf(flag(setting.flag));
	if (fromFlag !== undefined) return { text: fromFlag, from: `--${setting.flag}` };
	const fromEnv = textOf(env[setting.env]);
	if (fromEnv !== undefined) return { text: fromEnv, from: setting.env };
	return undefined;
};

export const parsePositive = (text: string): number | undefined => {
	const value = Number(text);
	return Number.isFinite(value) && value > 0 ? value : undefined;
};

export const parseCount = (text: string): number | undefined => {
	const value = Number(text);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const WINDOW_TEXT = /^(\d+(?:\.\d+)?)\s*([km]?)$/i;
const WINDOW_SCALE: Readonly<Record<string, number>> = { "": 1, k: 1_000, m: 1_000_000 };

/** Tokens from `272000`, `"272k"` or `"1m"`. */
export const parseWindow = (value: unknown): number | undefined => {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	if (typeof value !== "string") return undefined;
	const match = WINDOW_TEXT.exec(value.trim());
	const scale = WINDOW_SCALE[(match?.[2] ?? "").toLowerCase()];
	if (match?.[1] === undefined || scale === undefined) return undefined;
	const tokens = Number(match[1]) * scale;
	return tokens > 0 ? tokens : undefined;
};

export const formatWindow = (tokens: number): string =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}m` : `${Number((tokens / 1_000).toFixed(1))}k`;

const globPattern = (glob: string): RegExp =>
	new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

export const modelMatches = (glob: string, model: ModelRef): boolean => {
	const pattern = globPattern(glob);
	return pattern.test(`${model.provider}/${model.id}`) || pattern.test(model.id);
};

export const windowMatches = (window: number, actual: number | undefined): boolean =>
	actual !== undefined && Math.abs(actual - window) <= window * WINDOW_TOLERANCE;

export const ruleMatches = (rule: ConfigRule, model: ModelRef): boolean =>
	(rule.model === undefined || modelMatches(rule.model, model)) && (rule.window === undefined || windowMatches(rule.window, model.contextWindow));

export const ruleFor = (rules: readonly ConfigRule[], model: ModelRef | undefined): number | undefined => {
	if (model === undefined) return undefined;
	const index = rules.findIndex((rule) => ruleMatches(rule, model));
	return index < 0 ? undefined : index;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const TOP_KEYS = ["nudgeAt", "nudgeEvery", "maxResets", "rules"];
const RULE_KEYS = ["model", "window", "nudgeAt", "nudgeEvery"];

const unknownKeys = (record: Readonly<Record<string, unknown>>, known: readonly string[], where: string): string[] =>
	Object.keys(record)
		.filter((key) => !known.includes(key))
		.map((key) => `${where}: unknown key "${key}", ignored`);

/** A number field: absent is undefined, a bad value is undefined with a warning. */
const numberField = (
	record: Readonly<Record<string, unknown>>,
	key: string,
	parse: (text: string) => number | undefined,
	expected: string,
	where: string,
	warnings: string[],
): number | undefined => {
	const value = record[key];
	if (value === undefined) return undefined;
	const parsed = typeof value === "number" || typeof value === "string" ? parse(String(value)) : undefined;
	if (parsed === undefined) warnings.push(`${where}: ${key} ${JSON.stringify(value)} is not ${expected}, ignored`);
	return parsed;
};

const ruleFrom = (value: unknown, label: string, warnings: string[]): ConfigRule | undefined => {
	if (!isRecord(value)) {
		warnings.push(`${label}: not an object, skipped`);
		return undefined;
	}
	warnings.push(...unknownKeys(value, RULE_KEYS, label));
	const model = value.model === undefined ? undefined : typeof value.model === "string" ? nonEmpty(value.model) : undefined;
	if (value.model !== undefined && model === undefined) {
		warnings.push(`${label}: model ${JSON.stringify(value.model)} is not a non-empty glob, skipped`);
		return undefined;
	}
	const window = value.window === undefined ? undefined : parseWindow(value.window);
	if (value.window !== undefined && window === undefined) {
		warnings.push(`${label}: window ${JSON.stringify(value.window)} is not a token count like 272k or 1m, skipped`);
		return undefined;
	}
	const nudgeAt = numberField(value, "nudgeAt", parsePositive, "a positive number", label, warnings);
	const nudgeEvery = numberField(value, "nudgeEvery", parsePositive, "a positive number", label, warnings);
	if (nudgeAt === undefined && nudgeEvery === undefined) {
		warnings.push(`${label}: sets neither nudgeAt nor nudgeEvery, skipped`);
		return undefined;
	}
	return { model, window, nudgeAt, nudgeEvery };
};

/** The file's settings and rules, validated: anything bad is left out with a warning. */
export const fileConfigFrom = (read: ConfigFileRead): { readonly file: FileConfig; readonly warnings: readonly string[] } => {
	switch (read.kind) {
		case "absent":
			return { file: EMPTY_FILE, warnings: [] };
		case "broken":
			return { file: EMPTY_FILE, warnings: [`${read.path}: ${read.error}; ignoring the file`] };
		case "json": {
			if (!isRecord(read.value)) return { file: EMPTY_FILE, warnings: [`${read.path}: not a JSON object; ignoring the file`] };
			const top = read.value;
			const warnings: string[] = unknownKeys(top, TOP_KEYS, read.path);
			const nudgeAt = numberField(top, "nudgeAt", parsePositive, "a positive number", read.path, warnings);
			const nudgeEvery = numberField(top, "nudgeEvery", parsePositive, "a positive number", read.path, warnings);
			const maxResets = numberField(top, "maxResets", parseCount, "a whole number ≥ 0", read.path, warnings);
			if (top.rules !== undefined && !Array.isArray(top.rules)) warnings.push(`${read.path}: rules is not an array, ignored`);
			const listed: readonly unknown[] = Array.isArray(top.rules) ? top.rules : [];
			const rules = listed.flatMap((rule, index) => ruleFrom(rule, `${read.path}: rule ${index + 1}`, warnings) ?? []);
			return { file: { nudgeAt, nudgeEvery, maxResets, rules }, warnings };
		}
	}
};

/**
 * Settings for a model, lowest first: defaults, the file's top level, the file's first matching rule,
 * the environment, flags.
 */
export const readConfig = (env: Env, flag: FlagReader, file: FileConfig = EMPTY_FILE, model?: ModelRef): ConfigResult => {
	const warnings: string[] = [];
	const rule = ruleFor(file.rules, model);
	const matched = rule === undefined ? undefined : file.rules[rule];
	const numeric = (setting: Setting, parse: (text: string) => number | undefined, fallback: number | undefined, expected: string) => {
		const given = raw(setting, env, flag);
		if (given === undefined) return fallback;
		const value = parse(given.text);
		if (value !== undefined) return value;
		warnings.push(`${given.from}=${given.text} is not ${expected}; using ${fallback ?? "no cap"}`);
		return fallback;
	};
	const nudgeAt = matched?.nudgeAt ?? file.nudgeAt ?? DEFAULT_NUDGE_AT;
	const nudgeEvery = matched?.nudgeEvery ?? file.nudgeEvery ?? DEFAULT_NUDGE_EVERY;
	const config: RelayConfig = {
		nudgeAt: numeric(SETTINGS.nudgeAt, parsePositive, nudgeAt, "a positive number") ?? nudgeAt,
		nudgeEvery: numeric(SETTINGS.nudgeEvery, parsePositive, nudgeEvery, "a positive number") ?? nudgeEvery,
		maxResets: numeric(SETTINGS.maxResets, parseCount, file.maxResets, "a whole number ≥ 0"),
		goal: raw(SETTINGS.goal, env, flag)?.text,
	};
	return { config, warnings, rule };
};
