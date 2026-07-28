export interface TelemetryLimit {
	id: string;
	label: string;
	used?: number;
	limit?: number;
	unit: "requests" | "tokens" | "usd" | "streams";
	window?: "minute" | "hour" | "day" | "month" | "lifetime";
	resetAt?: number;
}

export interface TelemetryKey {
	id: string;
	name: string;
	active: boolean;
	requests?: number;
	tokens?: number;
	cost?: number;
	spendLimit?: number;
	rpm?: number;
	rph?: number;
	expiresAt?: number;
	autoThrottled?: boolean;
}

export interface TelemetryModelUsage {
	model: string;
	requests?: number;
	input?: number;
	output?: number;
	cache?: number;
	tokens?: number;
	cost?: number;
}

export interface TelemetryRecentRequest {
	id: string;
	timestamp: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	latencyMs?: number;
	success: boolean;
	error?: string;
	cacheSavedTokens?: number;
}

export interface ProviderTelemetry {
	provider: string;
	label: string;
	fetchedAt: number;
	currency?: string;
	balance?: number;
	reservedBalance?: number;
	spentToday?: number;
	spentMonth?: number;
	totalCost?: number;
	requests?: number;
	tokens?: number;
	successRequests?: number;
	cacheSavedTokens?: number;
	cacheBaseTokens?: number;
	estimatedCacheSavings?: number;
	estimatedSavings?: number;
	limits?: readonly TelemetryLimit[];
	keys?: readonly TelemetryKey[];
	models?: readonly TelemetryModelUsage[];
	recent?: readonly TelemetryRecentRequest[];
	message?: string;
}

export interface TelemetrySourceSecret {
	id: string;
	title: string;
	description?: string;
	placeholder?: string;
	normalize?: (value: string) => string;
	validate?: (value: string, signal?: AbortSignal) => Promise<void>;
}

export interface TelemetrySource {
	id: string;
	secret?: TelemetrySourceSecret;
	refresh(signal?: AbortSignal): Promise<ProviderTelemetry>;
}

export interface TelemetryService {
	register(source: TelemetrySource): () => void;
	get(provider?: string): ProviderTelemetry | undefined;
	getSource(provider: string): TelemetrySource | undefined;
	getAll(): readonly ProviderTelemetry[];
	refresh(provider?: string): Promise<void>;
	subscribe(listener: () => void): () => void;
}

const SERVICE_KEY = Symbol.for("piplusplus.telemetry-service");
const PENDING_KEY = Symbol.for("piplusplus.telemetry-pending-sources");
type GlobalState = typeof globalThis & { [SERVICE_KEY]?: TelemetryService; [PENDING_KEY]?: Map<string, TelemetrySource> };
const state = globalThis as GlobalState;

export function installTelemetryService(service: TelemetryService): void {
	state[SERVICE_KEY] = service;
	for (const source of state[PENDING_KEY]?.values() ?? []) service.register(source);
}

export function getTelemetryService(): TelemetryService | undefined { return state[SERVICE_KEY]; }

export function removeTelemetryService(service: TelemetryService): void {
	if (state[SERVICE_KEY] === service) delete state[SERVICE_KEY];
}

export function registerTelemetrySource(source: TelemetrySource): () => void {
	const pending = state[PENDING_KEY] ??= new Map();
	pending.set(source.id, source);
	const removeLive = state[SERVICE_KEY]?.register(source);
	return () => {
		if (pending.get(source.id) === source) pending.delete(source.id);
		removeLive?.();
	};
}
