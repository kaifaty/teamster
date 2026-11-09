// The machines' labels by their reactors: a machine's name, what is free ring by ring, and the rest in the title.

import { dataAge, errorLabel, freeItems, machineRings, statusLevel, statusText, type FreeItem, type Rings } from "../../lib/machines";
import type { Machine } from "../../types";
import { machineLabelAnchor, type MachineColumn, type MachineShape } from "../layout";
import { RINGS } from "../palette";
import { at } from "./style";

export const RING_NOTE = "Кольца снаружи внутрь: CPU, память, GPU; дуга — занято";

/** What a machine's label tells under its name: what is free, ring by ring; why nothing is known when it is offline. */
export function freeOf(machine: Machine): FreeItem[] {
  return machine.status === "offline" || machine.status === "unknown" ? [] : freeItems(machine.metrics);
}

/** What a machine's label shows, so that the column knows its size. */
export function machineShape(machine: Machine): MachineShape {
  const free = freeOf(machine);
  // A dot before each free resource counts as one character of the line.
  return { id: machine.id, name: machine.name, status: free.length ? free.map((item) => `● ${item.text}`).join(" ") : statusText(machine) };
}

/** How pressing the ring of a free resource is, for the colour of its figure: none when calm. */
export function ringLevel(rings: Rings, key: FreeItem["key"]): "warn" | "bad" | null {
  const level = rings[key]?.level;
  return level === "warn" || level === "bad" ? level : null;
}

/** "Свободно: 28 ядер, памяти 24 ГБ, видеопамяти 8 ГБ" for a label's title. */
export function freeTitle(free: readonly FreeItem[]): string | null {
  if (!free.length) return null;
  const words: Record<FreeItem["key"], (text: string) => string> = {
    cpu: (text) => text,
    memory: (text) => `памяти ${text}`,
    gpu: (text) => (text.endsWith("%") ? `GPU ${text}` : `видеопамяти ${text}`),
  };
  return `Свободно: ${free.map((item) => words[item.key](item.text)).join(", ")}`;
}

/** A label for each machine the column places. */
export function machineLabels(machines: readonly Machine[], column: MachineColumn | null, now: number) {
  if (!column) return [];
  return machines.flatMap((machine) => {
    const anchor = machineLabelAnchor(machine.id, column);
    if (!anchor) return [];
    const status = statusText(machine);
    // A failed probe that has not yet made the machine offline, and data that is not fresh: in the title, as the card has them.
    const mark = machine.error && machine.status !== "offline" ? `⚠ ${errorLabel(machine.error)}` : null;
    const extra = [mark, dataAge(machine, now)].filter(Boolean).join(" · ") || null;
    const rings = machineRings(machine.metrics);
    const free = freeOf(machine).map((item) => ({ ...item, color: RINGS[item.key], level: ringLevel(rings, item.key) }));
    return [{
      machine,
      status,
      free,
      level: statusLevel(machine.status) ?? "muted",
      showStatus: column.status,
      title: [machine.role ? `${machine.name} · ${machine.role}` : machine.name, status, freeTitle(free), RING_NOTE, extra].filter(Boolean).join("\n"),
      style: at(anchor.x, anchor.y),
    }];
  });
}
