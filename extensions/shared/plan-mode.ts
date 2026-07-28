export interface PlanStep { number: number; text: string; completed: boolean }
export interface ExtractedPlan { text: string; steps: PlanStep[] }

export function extractPlan(text: string): ExtractedPlan | undefined {
	const header = /^(?:#{1,4}\s*)?(?:implementation\s+)?plan\s*:?\s*$/im.exec(text);
	if (!header?.index && header?.index !== 0) return undefined;
	const planText = text.slice(header.index).trim();
	const steps: PlanStep[] = [];
	for (const match of planText.matchAll(/^\s*(\d+)[.)]\s+(.+?)\s*$/gm)) {
		const value = match[2].replace(/\s+/g, " ").trim();
		if (value.length >= 3) steps.push({ number: steps.length + 1, text: value, completed: false });
	}
	return steps.length ? { text: planText, steps } : undefined;
}

export function markPlanSteps(text: string, steps: PlanStep[]): number {
	let changed = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = steps.find((candidate) => candidate.number === Number(match[1]));
		if (step && !step.completed) { step.completed = true; changed++; }
	}
	return changed;
}

export function formatPlanSteps(steps: PlanStep[]): string {
	return steps.map((step) => `${step.number}. ${step.completed ? "✓" : "○"} ${step.text}`).join("\n");
}
