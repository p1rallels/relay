import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export const nonEmpty = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed === "" ? undefined : trimmed;
};

export const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
};

/** pi's agent dir: $PI_CODING_AGENT_DIR, else ~/.pi/agent; a leading ~ is home. */
export const agentDir = (env: Env, home: string): string => {
	const configured = nonEmpty(env.PI_CODING_AGENT_DIR);
	return configured ? expandHome(configured, home) : join(home, ".pi", "agent");
};
