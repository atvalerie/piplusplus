import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listPiPlusPlusSettingsSections } from "./shared/settings-service.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const COMMAND_NAMES = ["pi++", "piplusplus", "pipp"] as const;

export function settingsHubSummary(): string {
	const sections = listPiPlusPlusSettingsSections();
	if (!sections.length) return "No Pi++ settings pages are currently registered.";
	return sections.map((section) => `${section.label}: ${section.summary()}`).join("\n");
}

async function openSettingsHub(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const requested = args.trim().toLowerCase();
	if (!ctx.hasUI) {
		ctx.ui.notify(settingsHubSummary(), "info");
		return;
	}

	if (requested) {
		const section = listPiPlusPlusSettingsSections().find((candidate) => candidate.id.toLowerCase() === requested || candidate.label.toLowerCase() === requested);
		if (!section) {
			ctx.ui.notify(`Unknown Pi++ settings page: ${args.trim()}\n\n${settingsHubSummary()}`, "error");
			return;
		}
		await section.open(ctx);
		return;
	}

	while (true) {
		const sections = listPiPlusPlusSettingsSections();
		if (!sections.length) {
			ctx.ui.notify("No Pi++ settings pages are currently registered.", "warning");
			return;
		}
		const options = sections.map((section) => `${section.label} · ${section.summary()}`);
		options.push("Close");
		const selected = await ctx.ui.select("Pi++ control center", options);
		if (!selected || selected === "Close") return;
		const index = options.indexOf(selected);
		const section = sections[index];
		if (!section) continue;
		try { await section.open(ctx); }
		catch (error) { ctx.ui.notify(`Could not open ${section.label}: ${error instanceof Error ? error.message : String(error)}`, "error"); }
	}
}

export default function piPlusPlusSettingsExtension(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") return;
	for (const name of COMMAND_NAMES) {
		pi.registerCommand(name, {
			description: "Open the interactive Pi++ control center for permissions, workflows, interface, and integrations",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trim().toLowerCase();
				const matches = listPiPlusPlusSettingsSections()
					.filter((section) => section.id.toLowerCase().startsWith(normalized))
					.map((section) => ({ value: section.id, label: section.label, description: section.summary() }));
				return matches.length ? matches : null;
			},
			handler: openSettingsHub,
		});
	}
}
