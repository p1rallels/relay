import { readFileSync } from "node:fs";
import type { ConfigFileRead } from "./core/config.ts";

const isMissing = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads relay's config file; a missing file is "absent", not an error. Small and local, so synchronous. */
export const readConfigFile = (path: string): ConfigFileRead => {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return isMissing(error) ? { kind: "absent", path } : { kind: "broken", path, error: messageOf(error) };
	}
	try {
		return { kind: "json", path, value: JSON.parse(text) };
	} catch (error) {
		return { kind: "broken", path, error: `not valid JSON (${messageOf(error)})` };
	}
};
