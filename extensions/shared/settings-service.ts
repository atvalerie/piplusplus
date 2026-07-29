import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface PiPlusPlusSettingsSection {
	/** Stable, globally unique id owned by one extension. */
	id: string;
	label: string;
	description: string;
	/** Short live summary displayed in the root control-center menu. */
	summary: () => string;
	/** Open the owner-provided interactive editor. */
	open: (ctx: ExtensionCommandContext) => void | Promise<void>;
	order?: number;
}

const SECTIONS_KEY = Symbol.for("piplusplus.settings-sections");
type GlobalState = typeof globalThis & { [SECTIONS_KEY]?: Map<string, PiPlusPlusSettingsSection> };

// Pi loads each top-level extension through a separate jiti module cache. Keep
// the registry on globalThis so owner extensions and the control-center
// extension see the same pages even when settings-service.ts is evaluated more
// than once. Symbol.for also keeps independently evaluated copies on one key.
const sections = (globalThis as GlobalState)[SECTIONS_KEY] ??= new Map<string, PiPlusPlusSettingsSection>();

/**
 * Register an owner-controlled settings page. The owner remains responsible for
 * validation, persistence, and synchronizing any live runtime state.
 */
export function registerPiPlusPlusSettingsSection(section: PiPlusPlusSettingsSection): () => void {
	if (!section.id.trim()) throw new Error("Pi++ settings section id cannot be empty.");
	if (!section.label.trim()) throw new Error(`Pi++ settings section ${section.id} needs a label.`);
	const registered = { ...section };
	sections.set(section.id, registered);
	return () => {
		if (sections.get(section.id) === registered) sections.delete(section.id);
	};
}

export function listPiPlusPlusSettingsSections(): PiPlusPlusSettingsSection[] {
	return [...sections.values()].sort((left, right) =>
		(left.order ?? 100) - (right.order ?? 100)
		|| left.label.localeCompare(right.label)
		|| left.id.localeCompare(right.id));
}

/** Test/reload helper. Normal extensions should dispose only their own page. */
export function clearPiPlusPlusSettingsSections(): void {
	sections.clear();
}
