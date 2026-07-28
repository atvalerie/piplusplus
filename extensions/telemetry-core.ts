import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTelemetryService, removeTelemetryService, type ProviderTelemetry, type TelemetryService, type TelemetrySource } from "./shared/telemetry-service.ts";

const REFRESH_MS = 60_000;

export default function telemetryCore(pi: ExtensionAPI) {
	const sources = new Map<string, TelemetrySource>();
	const snapshots = new Map<string, ProviderTelemetry>();
	const listeners = new Set<() => void>();
	const controllers = new Map<string, AbortController>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const notify = () => { for (const listener of listeners) listener(); };
	const refreshOne = async (source: TelemetrySource) => {
		controllers.get(source.id)?.abort();
		const controller = new AbortController();
		controllers.set(source.id, controller);
		try { snapshots.set(source.id, await source.refresh(controller.signal)); }
		catch (error) {
			const previous = snapshots.get(source.id);
			snapshots.set(source.id, { provider: source.id, label: previous?.label ?? source.id, fetchedAt: previous?.fetchedAt ?? Date.now(), ...previous, message: error instanceof Error ? error.message : String(error) });
		} finally {
			if (controllers.get(source.id) === controller) controllers.delete(source.id);
			notify();
		}
	};
	const service: TelemetryService = {
		register(source) {
			sources.set(source.id, source);
			void refreshOne(source);
			return () => { if (sources.get(source.id) === source) { sources.delete(source.id); snapshots.delete(source.id); controllers.get(source.id)?.abort(); notify(); } };
		},
		get: (provider) => provider ? snapshots.get(provider) : snapshots.values().next().value,
		getSource: (provider) => sources.get(provider),
		getAll: () => [...snapshots.values()],
		async refresh(provider) {
			if (provider) { const source = sources.get(provider); if (source) await refreshOne(source); return; }
			await Promise.all([...sources.values()].map(refreshOne));
		},
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
	};
	installTelemetryService(service);

	pi.on("session_start", () => { if (!timer) timer = setInterval(() => void service.refresh(), REFRESH_MS); });
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		removeTelemetryService(service);
	});
}
