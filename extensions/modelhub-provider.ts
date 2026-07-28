import {
	anthropicMessagesApi,
	createProvider,
	openAICompletionsApi,
	openAIResponsesApi,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { catalogToModels, fetchModelHub, MODELHUB_BASE_URL, type ModelHubCatalog } from "./shared/modelhub.ts";

function configuredKeys(): Array<{ provider: string; env: string }> {
	const keys: Array<{ provider: string; env: string }> = [{ provider: "modelhub", env: "MODELHUB_API_KEY" }];
	for (let index = 2; index <= 8; index++) if (process.env[`MODELHUB_API_KEY_${index}`]) keys.push({ provider: `modelhub-${index}`, env: `MODELHUB_API_KEY_${index}` });
	return keys;
}

function modelsFor(provider: string, catalog: ModelHubCatalog): Model<Api>[] {
	return catalogToModels(catalog).map((model) => ({ ...model, provider, api: model.api! } as Model<Api>));
}

function registerEnvironmentAlias(pi: ExtensionAPI, provider: string, env: string, models: ProviderModelConfig[]): void {
	pi.registerProvider(provider, {
		name: `ModelHub (${provider.slice(9)})`,
		baseUrl: MODELHUB_BASE_URL,
		apiKey: `$${env}`,
		authHeader: true,
		models,
		async refreshModels({ signal }) { return catalogToModels(await fetchModelHub<ModelHubCatalog>("/api/wallet/prices", { signal })); },
	});
}

export default async function modelHubProvider(pi: ExtensionAPI) {
	let catalog: ModelHubCatalog;
	try { catalog = await fetchModelHub<ModelHubCatalog>("/api/wallet/prices"); }
	catch (error) { console.error(`ModelHub catalog unavailable: ${error instanceof Error ? error.message : String(error)}`); return; }

	pi.registerProvider(createProvider<Api>({
		id: "modelhub",
		name: "ModelHub",
		baseUrl: MODELHUB_BASE_URL,
		auth: {
			apiKey: {
				name: "ModelHub API key",
				async login(interaction) {
					const key = (await interaction.prompt({ type: "secret", message: "Paste your ModelHub API key (sk-mh-…)", placeholder: "sk-mh-…" })).trim();
					if (!key) throw new Error("A ModelHub API key is required");
					interaction.notify({ type: "progress", message: "Validating ModelHub API key…" });
					await fetchModelHub("/v1/models", { apiKey: key, signal: interaction.signal });
					return { type: "api_key", key };
				},
				async resolve({ ctx, credential }) {
					const stored = credential?.key;
					const key = stored ?? await ctx.env("MODELHUB_API_KEY");
					if (!key) return undefined;
					return { auth: { apiKey: key, headers: { authorization: `Bearer ${key}` } }, source: stored ? "stored API key" : "MODELHUB_API_KEY" };
				},
			},
		},
		models: modelsFor("modelhub", catalog),
		async fetchModels({ signal }) { return modelsFor("modelhub", await fetchModelHub<ModelHubCatalog>("/api/wallet/prices", { signal })); },
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	}));

	for (const key of configuredKeys().slice(1)) registerEnvironmentAlias(pi, key.provider, key.env, catalogToModels(catalog));

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error" || !ctx.model?.provider.startsWith("modelhub")) return;
		const text = message.errorMessage ?? "";
		if (/context_length|context too (?:large|long)|maximum context/i.test(text) && !text.includes("context_length_exceeded")) return { message: { ...message, errorMessage: `context_length_exceeded: ${text}` } };
	});
}
