import assert from "node:assert/strict";
import test from "node:test";
import piPlusPlusSettingsExtension from "../extensions/piplusplus.ts";
import {
	clearPiPlusPlusSettingsSections,
	listPiPlusPlusSettingsSections,
	registerPiPlusPlusSettingsSection,
} from "../extensions/shared/settings-service.ts";

test("Pi++ settings sections are ordered, replaceable, and safely disposable", () => {
	clearPiPlusPlusSettingsSections();
	const disposeLater = registerPiPlusPlusSettingsSection({ id: "later", label: "Later", description: "", order: 20, summary: () => "two", open: () => {} });
	const disposeOriginal = registerPiPlusPlusSettingsSection({ id: "first", label: "Original", description: "", order: 10, summary: () => "old", open: () => {} });
	const disposeReplacement = registerPiPlusPlusSettingsSection({ id: "first", label: "Replacement", description: "", order: 10, summary: () => "new", open: () => {} });

	assert.deepEqual(listPiPlusPlusSettingsSections().map((section) => section.label), ["Replacement", "Later"]);
	disposeOriginal();
	assert.equal(listPiPlusPlusSettingsSections()[0]?.label, "Replacement", "stale disposer must not delete a replacement");
	disposeReplacement();
	disposeLater();
	assert.deepEqual(listPiPlusPlusSettingsSections(), []);
});

test("settings registry is shared across isolated module instances", async () => {
	const owner = await import("../extensions/shared/settings-service.ts?instance=owner");
	const hub = await import("../extensions/shared/settings-service.ts?instance=hub");
	owner.clearPiPlusPlusSettingsSections();

	const disposeOwner = owner.registerPiPlusPlusSettingsSection({ id: "shared", label: "Owner", description: "", summary: () => "owner", open: () => {} });
	assert.deepEqual(hub.listPiPlusPlusSettingsSections().map((section) => section.label), ["Owner"]);

	const disposeReplacement = hub.registerPiPlusPlusSettingsSection({ id: "shared", label: "Replacement", description: "", summary: () => "hub", open: () => {} });
	disposeOwner();
	assert.deepEqual(owner.listPiPlusPlusSettingsSections().map((section) => section.label), ["Replacement"], "a stale disposer from another module instance must preserve the replacement");

	disposeReplacement();
	assert.deepEqual(owner.listPiPlusPlusSettingsSections(), []);
});

test("control center registers all requested command aliases", () => {
	const commands = new Map<string, unknown>();
	piPlusPlusSettingsExtension({
		registerCommand(name: string, options: unknown) { commands.set(name, options); },
	} as any);
	assert.deepEqual([...commands.keys()], ["pi++", "piplusplus", "pipp"]);
});
