import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLiveSubOf, mayBeFresh, msgStoreRoot, otherRecordFiles, parsePresence, type Presence, STALE_AFTER_MS } from "../src/core/subs.ts";
import { hasLiveSub } from "../src/subs.ts";

const NOW = 1_800_000_000_000;

const presence = (patch: Partial<Presence> = {}): Presence => ({ id: "child", parent: "parent", pid: 42, heartbeatAt: NOW - 1_000, endedAt: undefined, ...patch });

const raw = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
	v: 1,
	id: "child",
	parent: "parent",
	cwd: "/tmp/fork",
	pid: 42,
	mode: "print",
	activity: "busy",
	startedAt: NOW - 60_000,
	heartbeatAt: NOW - 1_000,
	...patch,
});

describe("msgStoreRoot", () => {
	test("$PI_MSG_DIR, else $PI_CODING_AGENT_DIR/msg, else ~/.pi/agent/msg", () => {
		expect(msgStoreRoot({ PI_MSG_DIR: "/store", PI_CODING_AGENT_DIR: "/agent" }, "/h")).toBe("/store");
		expect(msgStoreRoot({ PI_CODING_AGENT_DIR: "/agent" }, "/h")).toBe("/agent/msg");
		expect(msgStoreRoot({}, "/h")).toBe("/h/.pi/agent/msg");
	});
	test("a leading ~ is home; blank counts as unset", () => {
		expect(msgStoreRoot({ PI_MSG_DIR: "~/m" }, "/h")).toBe("/h/m");
		expect(msgStoreRoot({ PI_MSG_DIR: "~" }, "/h")).toBe("/h");
		expect(msgStoreRoot({ PI_MSG_DIR: "  ", PI_CODING_AGENT_DIR: "~/agent" }, "/h")).toBe("/h/agent/msg");
	});
});

describe("parsePresence", () => {
	test("reads what relay needs", () => {
		expect(parsePresence(raw())).toEqual({ id: "child", parent: "parent", pid: 42, heartbeatAt: NOW - 1_000, endedAt: undefined });
		expect(parsePresence(raw({ endedAt: NOW }))?.endedAt).toBe(NOW);
	});
	test("rejects what msg rejects", () => {
		expect(parsePresence(raw({ v: 2 }))).toBeUndefined();
		expect(parsePresence(raw({ id: "../escape" }))).toBeUndefined();
		expect(parsePresence(raw({ pid: "42" }))).toBeUndefined();
		expect(parsePresence(raw({ heartbeatAt: Number.NaN }))).toBeUndefined();
		expect(parsePresence(raw({ startedAt: undefined }))).toBeUndefined();
		expect(parsePresence(null)).toBeUndefined();
		expect(parsePresence([raw()])).toBeUndefined();
	});
	test("a parent that isn't an id, or is itself, is no parent", () => {
		expect(parsePresence(raw({ parent: "child" }))?.parent).toBeUndefined();
		expect(parsePresence(raw({ parent: "no/slashes" }))?.parent).toBeUndefined();
		expect(parsePresence(raw({ parent: 7 }))?.parent).toBeUndefined();
	});
});

describe("isLiveSubOf", () => {
	const alive = () => true;
	test("names this session, never ended, beat under 45s ago, process running", () => {
		expect(isLiveSubOf(presence(), "parent", NOW, alive)).toBe(true);
		expect(isLiveSubOf(presence({ heartbeatAt: NOW - STALE_AFTER_MS }), "parent", NOW, alive)).toBe(true);
	});
	test("each condition matters", () => {
		expect(isLiveSubOf(presence(), "someone-else", NOW, alive)).toBe(false);
		expect(isLiveSubOf(presence({ parent: undefined }), "parent", NOW, alive)).toBe(false);
		expect(isLiveSubOf(presence({ endedAt: NOW - 500 }), "parent", NOW, alive)).toBe(false);
		expect(isLiveSubOf(presence({ heartbeatAt: NOW - STALE_AFTER_MS - 1 }), "parent", NOW, alive)).toBe(false);
		expect(isLiveSubOf(presence(), "parent", NOW, () => false)).toBe(false);
	});
	test("the pid probed is the record's", () => {
		const probed: number[] = [];
		isLiveSubOf(presence({ pid: 4242 }), "parent", NOW, (pid) => probed.push(pid) > 0);
		expect(probed).toEqual([4242]);
	});
});

describe("which records get read", () => {
	test("only other sessions' record files", () => {
		const names = ["parent.json", "child.json", ".tmp-child.json", "notes.txt", "01a155b1-7b94-72f7-b96b-cb04ce50aef2.json", "..json"];
		expect(otherRecordFiles(names, "parent")).toEqual(["child.json", "01a155b1-7b94-72f7-b96b-cb04ce50aef2.json"]);
	});
	test("a file rewritten longer ago than the stale window can't be live", () => {
		expect(mayBeFresh(NOW - 1_000, NOW)).toBe(true);
		expect(mayBeFresh(NOW - STALE_AFTER_MS, NOW)).toBe(true);
		expect(mayBeFresh(NOW - STALE_AFTER_MS - 10_000, NOW)).toBe(false);
	});
});

describe("hasLiveSub (msg's store on disk)", () => {
	const saved = process.env.PI_MSG_DIR;
	let base = "";
	let sessions = "";
	const write = (id: string, record: Record<string, unknown>, ageMs = 0): void => {
		const path = join(sessions, `${id}.json`);
		writeFileSync(path, `${JSON.stringify(record)}\n`);
		if (ageMs > 0) utimesSync(path, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000);
	};
	const live = (id: string, patch: Record<string, unknown> = {}) => raw({ id, parent: "parent", pid: process.pid, startedAt: Date.now() - 5_000, heartbeatAt: Date.now(), ...patch });
	const deadPid = (): number => Bun.spawnSync(["true"]).pid;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "relay-subs-"));
		sessions = join(base, "sessions");
		mkdirSync(sessions, { recursive: true });
		process.env.PI_MSG_DIR = base;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_MSG_DIR;
		else process.env.PI_MSG_DIR = saved;
		rmSync(base, { recursive: true, force: true });
	});

	test("no store, an empty store: none", async () => {
		expect(await hasLiveSub("parent")).toBe(false);
		rmSync(sessions, { recursive: true });
		expect(await hasLiveSub("parent")).toBe(false);
	});
	test("a running child with a fresh heartbeat is live", async () => {
		write("child", live("child"));
		expect(await hasLiveSub("parent")).toBe(true);
		expect(await hasLiveSub("someone-else")).toBe(false);
	});
	test("ended, stale, dead, or someone else's: not live", async () => {
		write("ended", live("ended", { endedAt: Date.now() }));
		write("stale", live("stale", { heartbeatAt: Date.now() - STALE_AFTER_MS - 5_000 }));
		write("dead", live("dead", { pid: deadPid() }));
		write("other", live("other", { parent: "another-parent" }));
		write("parent", live("parent", { parent: "grandparent" }));
		writeFileSync(join(sessions, "broken.json"), "{ not json");
		expect(await hasLiveSub("parent")).toBe(false);
		write("child", live("child"));
		expect(await hasLiveSub("parent")).toBe(true);
	});
	test("a record whose file is older than the stale window isn't even read", async () => {
		write("old", live("old"), STALE_AFTER_MS + 30_000);
		expect(await hasLiveSub("parent")).toBe(false);
	});
});
