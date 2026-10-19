export type RelayCommand =
	| { readonly kind: "reset" }
	| { readonly kind: "on"; readonly goal: string | undefined }
	| { readonly kind: "off" }
	| { readonly kind: "status" }
	| { readonly kind: "unknown"; readonly text: string };

export const SUBCOMMANDS = ["on", "off", "status"] as const;

/**
 * `/relay` · `/relay on [goal]` · `/relay off` · `/relay status`. The first word decides. Only a bare
 * `/relay` resets: any other text is likely a goal that lost its `on`, and a reset can't be taken back.
 */
export const parseCommand = (args: string): RelayCommand => {
	const text = args.trim();
	const head = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	const rest = text.slice(head.length).trim();
	switch (head) {
		case "":
			return { kind: "reset" };
		case "on":
			return { kind: "on", goal: rest === "" ? undefined : rest };
		case "off":
			return { kind: "off" };
		case "status":
			return { kind: "status" };
		default:
			return { kind: "unknown", text };
	}
};
