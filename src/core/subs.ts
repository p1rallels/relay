/**
 * msg's presence records, as relay reads them to tell whether a session has a live sub (a session
 * started from its bash). The store is msg's contract (github.com/p1rallels/msg, README "Store"): relay
 * only reads it, imports nothing from msg, and parses records the way msg and pi-web's msg-store.ts do.
 *
 *   <root>/sessions/<session id>.json   presence: v, id, name?, parent?, cwd, pid, mode, activity, startedAt, heartbeatAt, endedAt?
 */
import { join } from "node:path";
import { agentDir, type Env, expandHome, nonEmpty } from "./paths.ts";

export const PRESENCE_VERSION = 1;
/** msg's STALE_AFTER_MS: a record whose heartbeat is older than this is offline, whatever it claims. */
export const STALE_AFTER_MS = 45_000;
/** File times can be a second or two coarse; a record is never written before the heartbeat it carries. */
const MTIME_SLACK_MS = 2_000;

/** The fields relay needs from a presence record. */
export interface Presence {
	readonly id: string;
	/** The session whose bash started this one. */
	readonly parent: string | undefined;
	readonly pid: number;
	readonly heartbeatAt: number;
	readonly endedAt: number | undefined;
}

/** msg's ids (src/core/paths.ts): anything else names no session. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isMsgId = (id: string): boolean => ID_PATTERN.test(id) && !id.includes("..");

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Where msg keeps its store: $PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg; a leading ~ is home. */
export const msgStoreRoot = (env: Env, home: string): string => {
	const configured = nonEmpty(env.PI_MSG_DIR);
	if (configured) return expandHome(configured, home);
	return join(agentDir(env, home), "msg");
};

export const presenceDir = (root: string): string => join(root, "sessions");

const RECORD_SUFFIX = ".json";

/** The record files in a listing of `sessions/` that could be another session's (msg names them `<id>.json`). */
export const otherRecordFiles = (names: readonly string[], selfId: string): string[] =>
	names.filter((name) => name.endsWith(RECORD_SUFFIX) && isMsgId(name.slice(0, -RECORD_SUFFIX.length)) && name !== `${selfId}${RECORD_SUFFIX}`);

/** Live records are rewritten every 10s; one whose file is older than the stale window can't be live, so it isn't read. */
export const mayBeFresh = (mtimeMs: number, now: number): boolean => now - mtimeMs <= STALE_AFTER_MS + MTIME_SLACK_MS;

/** A presence record the way msg reads one (registry.ts parsePresence), or undefined when it isn't one. */
export const parsePresence = (value: unknown): Presence | undefined => {
	const fields = record(value);
	if (fields?.v !== PRESENCE_VERSION) return undefined;
	const id = typeof fields.id === "string" ? fields.id : "";
	const pid = finite(fields.pid);
	const heartbeatAt = finite(fields.heartbeatAt);
	if (!isMsgId(id) || pid === undefined || finite(fields.startedAt) === undefined || heartbeatAt === undefined) return undefined;
	const parent = typeof fields.parent === "string" && isMsgId(fields.parent) && fields.parent !== id ? fields.parent : undefined;
	return { id, parent, pid, heartbeatAt, endedAt: finite(fields.endedAt) };
};

/** A live sub of `parentId`: its record names it as parent, it never ended, it beat under 45s ago, and its process runs. */
export const isLiveSubOf = (presence: Presence, parentId: string, now: number, running: (pid: number) => boolean): boolean =>
	presence.parent === parentId && presence.endedAt === undefined && now - presence.heartbeatAt <= STALE_AFTER_MS && running(presence.pid);
