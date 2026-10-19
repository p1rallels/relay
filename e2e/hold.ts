import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loaded next to relay by the queue scenario only. When the agent first calls relay, this holds the
 * call for RELAY_E2E_HOLD_MS before it runs, so the scenario can queue a steer and a follow-up inside
 * the turn that resets, and sends a message the way msg delivers one into a working session: a custom
 * message with deliverAs steer. RELAY_E2E_HOLD_MARKER is written once the hold has begun.
 */
export default function hold(pi: ExtensionAPI): void {
	let held = false;
	pi.on("tool_call", async (event) => {
		if (held || event.toolName !== "relay") return undefined;
		held = true;
		pi.sendMessage(
			{ customType: "e2e-msg", content: "QUEUED-MSG: run `echo m > msg.txt` with bash.", display: true, details: { from: "e2e" } },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		const marker = process.env.RELAY_E2E_HOLD_MARKER;
		if (marker) writeFileSync(marker, String(Date.now()));
		await new Promise((done) => setTimeout(done, Number(process.env.RELAY_E2E_HOLD_MS ?? 8_000)));
		return undefined;
	});
}
