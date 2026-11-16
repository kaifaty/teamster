// The notification sound: when it is on, a short quiet chime as a task comes into «ждут тебя» or into «тревоги», lower for
// an alarm. Made by Web Audio, without files. The browser lets a page sound only after the viewer acted on it, so the
// audio starts at the first press or key and stays silent until then; the first snapshot and a change of source chime
// for nothing. The choice outlives the page.

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadJson, saveJson } from "../../lib/storage";
import { arrivals, slugsIn, type QueueColumn } from "../console/queue";
import type { MapSources } from "./useMapSources";

/** Whether the notification sound is on; off unless the viewer turned it on. */
export const SOUND_KEY = "codex-board.console-sound.v1";

/** Each chime's tones in hertz, one after another; the alarm's go down. */
const TONES: Record<QueueColumn, readonly number[]> = { review_me: [660, 880], attention: [440, 330] };
const TONE_SECONDS = 0.12;
const VOLUME = 0.05;

type AudioCtor = typeof AudioContext;

export function useArrivalChime(sources: Pick<MapSources, "tasks" | "loaded" | "source">) {
  const sound = ref(loadJson(SOUND_KEY, false, (value): value is boolean => typeof value === "boolean"));
  watch(sound, (value) => saveJson(SOUND_KEY, value));

  let audio: AudioContext | null = null;
  /** Made or woken at the viewer's own press or key, while the sound is on. */
  function wake() {
    if (!sound.value) return;
    try {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext) as AudioCtor | undefined;
      if (!audio && Ctor) audio = new Ctor();
      if (audio?.state === "suspended") audio.resume().catch(() => {});
    } catch {
      audio = null;
    }
  }
  // Turned on from the menu: the press that did it lets the page sound.
  watch(sound, (on) => {
    if (on) wake();
  });

  function chime(column: QueueColumn) {
    if (!audio || audio.state !== "running") return;
    try {
      const start = audio.currentTime + 0.02;
      TONES[column].forEach((frequency, i) => {
        const at = start + i * TONE_SECONDS;
        const tone = audio!.createOscillator();
        const gain = audio!.createGain();
        tone.type = column === "attention" ? "triangle" : "sine";
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(VOLUME, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + TONE_SECONDS);
        tone.connect(gain).connect(audio!.destination);
        tone.start(at);
        tone.stop(at + TONE_SECONDS + 0.02);
      });
    } catch {
      // No sound this time.
    }
  }

  /** The queues' slugs at the last snapshot; null until the first one has loaded. */
  const queues = computed(() => (sources.loaded.value ? { review_me: slugsIn(sources.tasks.value, "review_me"), attention: slugsIn(sources.tasks.value, "attention") } : null));
  // A change of source starts the comparison anew.
  watch(sources.source, () => {
    last = null;
  });
  let last: Record<QueueColumn, Set<string>> | null = null;
  watch(queues, (now) => {
    const before = last;
    last = now;
    if (!now || !before || !sound.value) return;
    if (arrivals(before.attention, now.attention).length) chime("attention");
    else if (arrivals(before.review_me, now.review_me).length) chime("review_me");
  });

  onMounted(() => {
    last = queues.value;
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
    void audio?.close().catch(() => {});
  });

  return { sound };
}
