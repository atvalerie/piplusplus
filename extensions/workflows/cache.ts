import { createHash } from "node:crypto";

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonicalValue(item)]));
	}
	if (typeof value === "number" && !Number.isFinite(value)) return String(value);
	return value;
}

export function stableWorkflowHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}
