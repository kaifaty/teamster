import { loadJson, saveJson } from "../../lib/storage";

// The array index is the project's bank. Only open sites need a slot on it.
export interface BankPlacement {
  project: string;
  slots: Record<string, number>;
}

const KEY = "codex-board.project-task-surface.v1";

function isPlacement(value: unknown): value is BankPlacement[] {
  if (!Array.isArray(value)) return false;
  const projects = new Set<string>();
  for (const bank of value) {
    if (!bank || typeof bank.project !== "string" || projects.has(bank.project)) return false;
    projects.add(bank.project);
    if (!bank.slots || typeof bank.slots !== "object" || Array.isArray(bank.slots)) return false;
    const slots = Object.values(bank.slots);
    if (new Set(slots).size !== slots.length ||
        !slots.every(slot => typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0)) return false;
  }
  return true;
}

export function loadPlacement(): BankPlacement[] {
  return loadJson(KEY, [], isPlacement);
}

export function savePlacement(placement: BankPlacement[]) {
  saveJson(KEY, placement);
}
