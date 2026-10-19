export type RelayCommand =
	| { readonly kind: "reset"; readonly note: string }
	| { readonly kind: "on"; readonly goal: string | undefined }
	| { readonly kind: "off" }
	| { readonly kind: "status" };

export const SUBCOMMANDS = ["on", "off", "status"] as const;

/** `/relay [note]` · `/relay on [goal]` · `/relay off` · `/relay status`. The first word decides; anything else is a note. */
export const parseCommand = (args: string): RelayCommand => {
	const text = args.trim();
	const head = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	const rest = text.slice(head.length).trim();
	switch (head) {
		case "on":
			return { kind: "on", goal: rest === "" ? undefined : rest };
		case "off":
			return { kind: "off" };
		case "status":
			return { kind: "status" };
		default:
			return { kind: "reset", note: text };
	}
};
