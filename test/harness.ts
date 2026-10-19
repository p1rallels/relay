import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import relayLoop from "../src/extension.ts";

export const CONTEXT_WINDOW = 20_000;

type ExtensionMode = ExtensionContext["mode"];
type ToolArgs = Parameters<typeof fauxToolCall>[1];

/** A test-only tool that makes the context grow by `chars`, and a recorder of usage at each turn_end. */
const probe =
	(percents: (number | null)[]) =>
	(pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "pad",
			label: "Pad",
			description: "Returns `chars` characters of filler.",
			parameters: Type.Object({ chars: Type.Number() }),
			async execute(_id, params) {
				return { content: [{ type: "text" as const, text: "x".repeat(params.chars) }], details: undefined };
			},
		});
		pi.on("turn_end", (_event, ctx) => {
			percents.push(ctx.getContextUsage()?.percent ?? null);
		});
	};

export interface Harness {
	readonly session: AgentSession;
	readonly sessions: string;
	readonly requests: TranscriptContext[];
	/** Context usage seen at each turn_end, in order. */
	readonly percents: (number | null)[];
	readonly errors: string[];
	readonly respond: (steps: Step[]) => void;
	readonly entries: () => SessionEntry[];
	readonly reopen: (mode?: ExtensionMode) => Promise<Harness>;
	readonly dispose: () => void;
}

export type Step = AssistantMessage | ((context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>);

export const say = (text: string): AssistantMessage => fauxAssistantMessage(text);
export const call = (name: string, args: ToolArgs): AssistantMessage =>
	fauxAssistantMessage([fauxText(`calling ${name}`), fauxToolCall(name, args)], { stopReason: "toolUse" });
export const calls = (...list: [string, ToolArgs][]): AssistantMessage =>
	fauxAssistantMessage(
		list.map(([name, args]) => fauxToolCall(name, args)),
		{ stopReason: "toolUse" },
	);

interface World {
	readonly base: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessions: string;
}

const makeWorld = (): World => {
	const base = mkdtempSync(join(tmpdir(), "relay-test-"));
	const world = { base, cwd: join(base, "cwd"), agentDir: join(base, "agent"), sessions: join(base, "sessions") };
	for (const dir of [world.cwd, world.agentDir, world.sessions]) mkdirSync(dir, { recursive: true });
	return world;
};

const open = async (world: World, manager: SessionManager, mode: ExtensionMode): Promise<Harness> => {
	const requests: TranscriptContext[] = [];
	const percents: (number | null)[] = [];
	const errors: string[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "tiny", contextWindow: CONTEXT_WINDOW, maxTokens: 2_000 }] });
	const runtime = await ModelRuntime.create({ authPath: join(world.agentDir, "auth.json"), modelsPath: null });
	runtime.registerProvider("faux", {
		name: "Faux",
		baseUrl: "http://faux.invalid",
		apiKey: "test",
		api: faux.api,
		streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
		models: [
			{
				id: "tiny",
				name: "tiny",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: CONTEXT_WINDOW,
				maxTokens: 2_000,
			},
		],
	});
	const model = runtime.getModel("faux", "tiny");
	if (!model) throw new Error("faux model missing");
	const resourceLoader = new DefaultResourceLoader({
		cwd: world.cwd,
		agentDir: world.agentDir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [relayLoop, probe(percents)],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: world.cwd, agentDir: world.agentDir, sessionManager: manager, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader });
	await session.bindExtensions({ mode, onError: (error) => errors.push(`${error.event}: ${error.error}`) });
	const respond = (steps: Step[]): void => {
		const wrapped: FauxResponseStep[] = steps.map((step) => async (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return typeof step === "function" ? await step(context) : step;
		});
		faux.setResponses(wrapped);
	};
	const harness: Harness = {
		session,
		sessions: world.sessions,
		requests,
		percents,
		errors,
		respond,
		entries: () => session.sessionManager.getEntries(),
		reopen: async (nextMode = mode) => {
			const file = session.sessionManager.getSessionFile();
			session.dispose();
			if (!file) throw new Error("no session file to reopen");
			return open(world, SessionManager.open(file, world.sessions), nextMode);
		},
		dispose: () => {
			session.dispose();
			if (!process.env.KEEP_TEST_SESSIONS) rmSync(world.base, { recursive: true, force: true });
		},
	};
	return harness;
};

/** A real pi AgentSession with relay-loop loaded, a scripted faux model, and sessions in a temp dir. */
export const openSession = async (mode: ExtensionMode = "rpc"): Promise<Harness> => {
	const world = makeWorld();
	return open(world, SessionManager.create(world.cwd, world.sessions), mode);
};

export const sessionFiles = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".jsonl"));

export const textOf = (message: TranscriptContext["messages"][number]): string => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "")).join("");
};

export const contextChars = (context: TranscriptContext): number => context.messages.reduce((sum, message) => sum + textOf(message).length, 0);

export const relayEntries = (entries: readonly SessionEntry[], kind?: string) =>
	entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
			entry.type === "custom_message" && entry.customType === "relay" && (kind === undefined || (entry.details as { kind?: string } | undefined)?.kind === kind),
	);

export const waitFor = async <T>(what: string, probe: () => T | undefined, timeoutMs = 5_000): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 20));
	}
};
