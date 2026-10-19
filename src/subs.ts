import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLiveSubOf, mayBeFresh, msgStoreRoot, otherRecordFiles, parsePresence, presenceDir } from "./core/subs.ts";

/** `kill(pid, 0)` checks the process exists without signalling it; EPERM still means it does. */
const running = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
};

const isLiveSubFile = async (path: string, parentId: string, now: number): Promise<boolean> => {
	try {
		if (!mayBeFresh((await stat(path)).mtimeMs, now)) return false;
		const presence = parsePresence(JSON.parse(await readFile(path, "utf8")));
		return presence !== undefined && isLiveSubOf(presence, parentId, now, running);
	} catch {
		// gone between the listing and the read, mid-rename, or not JSON: not a live sub
		return false;
	}
};

/**
 * Whether a session this one started is live (msg's lineage, read-only): one readdir of msg's
 * `sessions/`, then only the records rewritten recently enough to be live, until one is.
 */
export const hasLiveSub = async (sessionId: string, now: number = Date.now()): Promise<boolean> => {
	const dir = presenceDir(msgStoreRoot(process.env, homedir()));
	const names = await readdir(dir).catch((): string[] => []);
	for (const name of otherRecordFiles(names, sessionId)) {
		if (await isLiveSubFile(join(dir, name), sessionId, now)) return true;
	}
	return false;
};
