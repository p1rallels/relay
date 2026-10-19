import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

export const REPO = resolve(import.meta.dir, "..");
export const EXTENSION = join(REPO, "src/extension.ts");
/** e2e only: holds the agent's first relay call, and queues a message the way msg does. */
export const HOLD_EXTENSION = join(REPO, "e2e/hold.ts");
export const MODEL = process.env.E2E_MODEL ?? "anthropic/claude-haiku-5-5";
export const THINKING = process.env.E2E_THINKING ?? "low";

export type Json = Record<string, unknown>;

export interface World {
	readonly cwd: string;
	readonly sessions: string;
	readonly env: Record<string, string>;
	readonly children: Subprocess[];
	readonly dispose: () => void;
}

/** A temp cwd, session dir and msg store, and an env without the caller's session or relay settings. */
export const world = (label: string, extraEnv: Record<string, string> = {}): World => {
	const base = mkdtempSync(join(tmpdir(), `relay-e2e-${label}-`));
	const cwd = join(base, "cwd");
	const sessions = join(base, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	const inherited = Object.entries(process.env).filter(
		(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("PI_RELAY_") && entry[0] !== "PI_SESSION_ID" && entry[0] !== "PI_SESSION_FILE",
	);
	const children: Subprocess[] = [];
	return {
		cwd,
		sessions,
		env: { ...Object.fromEntries(inherited), PI_MSG_DIR: join(base, "msg"), ...extraEnv },
		children,
		dispose: () => {
			for (const child of children) if (child.exitCode === null) child.kill();
			if (process.env.E2E_KEEP) console.log(`kept ${base}`);
			else rmSync(base, { recursive: true, force: true });
		},
	};
};

/** pi with only this extension, a cheap model, and sessions kept out of ~/.pi. */
export const piArgs = (w: World, extra: readonly string[]): string[] => [
	"pi",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-mcp",
	"-e",
	EXTENSION,
	"--model",
	MODEL,
	"--thinking",
	THINKING,
	"--session-dir",
	w.sessions,
	...extra,
];

export interface Run {
	readonly proc: Subprocess<"pipe", "pipe", "pipe">;
	readonly done: Promise<{ code: number; stdout: string; stderr: string }>;
}

export const spawnPi = (w: World, args: readonly string[], keepStdin = false): Run => {
	const proc = Bun.spawn(args as string[], { cwd: w.cwd, env: w.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	w.children.push(proc);
	if (!keepStdin) proc.stdin.end();
	const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({
		code,
		stdout,
		stderr,
	}));
	return { proc, done };
};

/** One rpc command on pi's stdin. */
export const send = (run: Run, command: Json): void => {
	run.proc.stdin.write(`${JSON.stringify(command)}\n`);
};

export const jsonLines = (text: string): Json[] =>
	text
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Json];
			} catch {
				return [];
			}
		});

/** What extensions told the human in rpc mode (ctx.ui.notify), in order. */
export const notices = (stdout: string): string[] =>
	jsonLines(stdout).flatMap((line) => (line.type === "extension_ui_request" && line.method === "notify" ? [String(line.message ?? "")] : []));

/** The rpc response to the command with this id. */
export const responseTo = (stdout: string, id: string): Json | undefined => jsonLines(stdout).find((line) => line.type === "response" && line.id === id);

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const within = <T>(what: string, promise: Promise<T>, ms: number): Promise<T> =>
	Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`timed out after ${ms / 1000}s: ${what}`)))]);

export const waitUntil = async <T>(what: string, probe: () => T | undefined, timeoutMs: number, everyMs = 250): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
		await sleep(everyMs);
	}
};

export const sessionFiles = (w: World): string[] => readdirSync(w.sessions).filter((name) => name.endsWith(".jsonl"));

/** Lines of the one session file in the world (pi files them flat into --session-dir). */
export const sessionLines = (w: World): Json[] => {
	const [file] = sessionFiles(w);
	if (!file) return [];
	return readFileSync(join(w.sessions, file), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Json];
			} catch {
				return [];
			}
		});
};

const record = (value: unknown): Json | undefined => (typeof value === "object" && value !== null ? (value as Json) : undefined);

export const relayMessages = (lines: readonly Json[], kind?: string): Json[] =>
	lines.filter((line) => line.type === "custom_message" && line.customType === "relay" && (kind === undefined || record(line.details)?.kind === kind));

export const relaySwitches = (lines: readonly Json[]): Json[] => lines.filter((line) => line.type === "custom" && line.customType === "relay");

export const messageOf = (line: Json): Json | undefined => (line.type === "message" ? record(line.message) : undefined);

export const isAssistant = (line: Json): boolean => messageOf(line)?.role === "assistant";

export const relayResults = (lines: readonly Json[]): Json[] =>
	lines.filter((line) => {
		const message = messageOf(line);
		return message?.role === "toolResult" && message.toolName === "relay";
	});

export const detailsOf = (line: Json | undefined): Json => record(line?.details) ?? record(messageOf(line ?? {})?.details) ?? {};

/** Tokens the request behind an assistant message carried (what the model read). */
export const requestTokens = (line: Json): number => {
	const usage = record(messageOf(line)?.usage) ?? {};
	return ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (typeof usage[key] === "number" ? (usage[key] as number) : 0), 0);
};

/** The names of the tools an assistant message calls. */
export const toolCalls = (line: Json): string[] => {
	const content = messageOf(line)?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => (record(part)?.type === "toolCall" ? [String(record(part)?.name ?? "")] : []));
};

/** The text of any message: a user's, an assistant's, a tool result's, or an extension's custom message. */
export const textOf = (line: Json | undefined): string => {
	const content = line?.type === "custom_message" ? line.content : messageOf(line ?? {})?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (record(part)?.type === "text" ? String(record(part)?.text ?? "") : "")).join("");
};

export const assistantText = (line: Json | undefined): string => {
	const content = messageOf(line ?? {})?.content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (record(part)?.type === "text" ? String(record(part)?.text ?? "") : "")).join("");
};

export interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

export const check = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, ...(detail ? { detail } : {}) });

export const clip = (text: string, max = 600): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export const report = (scenario: string, checks: readonly Check[]): boolean => {
	const passed = checks.length > 0 && checks.every((item) => item.ok);
	console.log(`\n${passed ? "PASS" : "FAIL"} ${scenario}`);
	for (const item of checks) console.log(`  ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail ? `\n       ${item.detail.replace(/\n/g, "\n       ")}` : ""}`);
	return passed;
};
