import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { CATCHUP_RECORDS, catchupArgs, commandLine, findLookup, LOOKUP_TIMEOUT_MS, type LookupBinary, searchArgs } from "./core/lookup.ts";
import type { Catchup } from "./core/summary.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

interface RunResult {
	readonly stdout: string;
	readonly error: string | undefined;
}

const run = (bin: string, args: readonly string[], timeoutMs: number): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
			if (!error) return resolve({ stdout, error: undefined });
			const firstLine = stderr.trim().split("\n")[0] ?? "";
			resolve({ stdout, error: error.killed ? `timed out after ${timeoutMs / 1000}s` : firstLine || error.message });
		});
	});

export interface SessionRef {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
}

export interface Lookup {
	readonly binary: LookupBinary | undefined;
	/** The session file's folder; undefined for sessions without a file. */
	readonly root: string | undefined;
}

export const locateLookup = (session: SessionRef): Lookup => ({
	binary: findLookup(process.env.PATH, homedir(), isExecutable),
	root: session.sessionFile ? dirname(session.sessionFile) : undefined,
});

export const searchCommand = (lookup: Lookup, sessionId: string): string => commandLine(lookup.binary?.display ?? "lookup", searchArgs(lookup.root, sessionId));

/** lookup's catch-up of this session, or why there is none plus the command to run by hand. */
export const runCatchup = async (lookup: Lookup, sessionId: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<Catchup> => {
	const display = lookup.binary?.display ?? "lookup";
	if (!lookup.root) {
		return { ok: false, command: commandLine(display, ["catchup", sessionId, "-n", String(CATCHUP_RECORDS)]), reason: "this session has no file" };
	}
	const args = catchupArgs(lookup.root, sessionId);
	const command = commandLine(display, args);
	if (!lookup.binary) return { ok: false, command, reason: "lookup is not installed (not on PATH, not in ~/.cargo/bin)" };
	const result = await run(lookup.binary.path, args, timeoutMs);
	if (result.error !== undefined) return { ok: false, command, reason: `lookup failed: ${result.error}` };
	return { ok: true, command, output: result.stdout };
};
