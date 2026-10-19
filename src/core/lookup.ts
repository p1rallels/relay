import { delimiter, isAbsolute, join } from "node:path";

export const CATCHUP_RECORDS = 30;
export const LOOKUP_TIMEOUT_MS = 10_000;

/** `lookup --root <dir> catchup <id> -n 30`: --root keeps it to the session's own folder, temp dirs included. */
export const catchupArgs = (root: string, sessionId: string, records = CATCHUP_RECORDS): string[] => [
	"--root",
	root,
	"catchup",
	sessionId,
	"-n",
	String(records),
];

export const searchArgs = (root: string | undefined, sessionId: string): string[] => [
	...(root ? ["--root", root] : []),
	"search",
	"<term>",
	"--session",
	sessionId,
];

const SAFE_WORD = /^[\w@%+=:,./-]+$/;

export const shellQuote = (word: string): string => (SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

export const commandLine = (bin: string, args: readonly string[]): string => [bin, ...args].map(shellQuote).join(" ");

export interface LookupBinary {
	/** What to run. */
	readonly path: string;
	/** How to write it in text the agent may copy into its own shell. */
	readonly display: string;
}

/**
 * lookup on PATH, else ~/.cargo/bin/lookup (pi-web's launchd PATH may lack cargo's bin).
 * When it comes from the fallback, the agent's shell may not find it by name, so show the full path.
 */
export const findLookup = (pathEnv: string | undefined, home: string, isExecutable: (path: string) => boolean): LookupBinary | undefined => {
	const onPath = (pathEnv ?? "")
		.split(delimiter)
		.filter((dir) => dir !== "" && isAbsolute(dir))
		.map((dir) => join(dir, "lookup"))
		.find(isExecutable);
	if (onPath) return { path: onPath, display: "lookup" };
	const fallback = join(home, ".cargo", "bin", "lookup");
	return isExecutable(fallback) ? { path: fallback, display: fallback } : undefined;
};
