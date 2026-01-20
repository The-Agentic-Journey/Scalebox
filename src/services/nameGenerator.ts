import { vms } from "./vm";
import { adjectives, adverbs, nouns } from "./wordlists";

function pickRandom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export function generateUniqueName(): string {
	const existingNames = new Set(Array.from(vms.values()).map((vm) => vm.name));

	for (let i = 0; i < 100; i++) {
		const name = `${pickRandom(adverbs)}-${pickRandom(adjectives)}-${pickRandom(nouns)}`;
		if (!existingNames.has(name)) {
			return name;
		}
	}

	// Fallback with timestamp suffix
	const name = `${pickRandom(adverbs)}-${pickRandom(adjectives)}-${pickRandom(nouns)}`;
	const suffix = Date.now().toString().slice(-4);
	return `${name}-${suffix}`;
}
