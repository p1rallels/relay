export const DEFAULT_NUDGE_AT = 40;
export const DEFAULT_NUDGE_EVERY = 5;

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

export type Env = Readonly<Record<string, string | undefined>>;
export type FlagReader = (name: string) => string | boolean | undefined;

export interface ConfigResult {
	readonly config: RelayConfig;
	readonly warnings: readonly string[];
}

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

export const readConfig = (env: Env, flag: FlagReader): ConfigResult => {
	const warnings: string[] = [];
	const numeric = (setting: Setting, parse: (text: string) => number | undefined, fallback: number | undefined, expected: string) => {
		const given = raw(setting, env, flag);
		if (given === undefined) return fallback;
		const value = parse(given.text);
		if (value !== undefined) return value;
		warnings.push(`${given.from}=${given.text} is not ${expected}; using ${fallback ?? "no cap"}`);
		return fallback;
	};
	const config: RelayConfig = {
		nudgeAt: numeric(SETTINGS.nudgeAt, parsePositive, DEFAULT_NUDGE_AT, "a positive number") ?? DEFAULT_NUDGE_AT,
		nudgeEvery: numeric(SETTINGS.nudgeEvery, parsePositive, DEFAULT_NUDGE_EVERY, "a positive number") ?? DEFAULT_NUDGE_EVERY,
		maxResets: numeric(SETTINGS.maxResets, parseCount, undefined, "a whole number ≥ 0"),
		goal: raw(SETTINGS.goal, env, flag)?.text,
	};
	return { config, warnings };
};
