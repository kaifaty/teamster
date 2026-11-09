// The science station's label in the galaxy: its most pressing note, and the rest in the title.

import type { Point } from "../layout";
import { RESEARCH_LABEL_DROP } from "../layout";
import { shortDate, type Research } from "../research";
import { at } from "./style";

export type StationMarks = Pick<Research, "batch" | "proposed" | "waiting" | "running" | "pending">;

/** The station's label under it; `point` is the station's centre. */
export function stationLabel(marks: StationMarks, point: Point) {
  const last = marks.batch ? `разбор ${shortDate(marks.batch.date)}` : "разборов не было";
  const proposed = marks.proposed.length;
  const asks = marks.waiting;
  // One note under the name, the most pressing one; the station's screen has the rest. A question waits on the human
  // before anything else.
  const note = asks ? `ждёт ответа ${asks}` : marks.running ? "идёт разбор" : proposed ? `ждут решения ${proposed}` : last;
  const title = [
    marks.running ? "идёт разбор" : last,
    ...(asks ? [`ждут ответа ${asks}`] : []),
    `ждут решения ${proposed}`,
    `с сигналом ${marks.pending.signals} из ${marks.pending.records}`,
  ].join("\n");
  return {
    style: at(point.x, point.y + RESEARCH_LABEL_DROP),
    note,
    title,
    running: marks.running && !asks,
    waiting: asks > 0 || (!marks.running && proposed > 0),
  };
}
