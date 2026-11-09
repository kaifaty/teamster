// The Pixi scene under the labels: made once the stage is in the page, fed whatever the map shows, and made again when
// the graphics card drops it and the viewer asks.

import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type ShallowRef } from "vue";
import type { Camera, Insets } from "../layout";
import { replayExits } from "../replay";
import { createFleetScene, type FleetScene, type ShipEntry } from "../scene";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapPanels } from "./useMapPanels";
import type { MapSources } from "./useMapSources";

export interface SceneOptions {
  props: Readonly<{ active: boolean; machine?: string | null }>;
  host: Readonly<Ref<HTMLElement | null>>;
  overlay: Readonly<Ref<HTMLElement | null>>;
  sources: MapSources;
  model: GalaxyModel;
  panels: MapPanels;
  entries: Readonly<Ref<ShipEntry[]>>;
  stars: { hoveredStar: Ref<string | null>; setCamera: (camera: Camera) => void };
  stage: { insets: Readonly<ShallowRef<Insets>>; measureInsets: () => void };
}

export function useFleetScene({ props, host, overlay, sources, model, panels, entries, stars, stage }: SceneOptions) {
  const { replay, repoArt } = sources;
  const { world, systemWorld } = model;
  const { repo, selected, hovered, researchOpen } = panels;
  const failure = ref<"webgl" | "lost" | null>(null);
  let scene: FleetScene | null = null;
  let unmounted = false;

  /** Whether the scene's ships were last the replay's: going back on air, the ships the live fleet lacks fade. */
  let replayedShips = false;
  function setShips(next: ShipEntry[]) {
    if (!scene) return;
    scene.setShips(next, replayExits(replay.at, replayedShips, replay.events));
    replayedShips = replay.at !== null;
  }

  function feed() {
    if (!scene) return;
    stage.measureInsets();
    scene.setGalaxy(model.galaxyModel());
    scene.setArt(repoArt.value);
    scene.setView(repo.value);
    setShips(entries.value);
    scene.setSelected(selected.value);
    scene.setMachine(props.machine ?? null);
    scene.setHovered(hovered.value);
    scene.setActive(props.active && !researchOpen.value);
  }

  function applyCamera(camera: Camera) {
    stars.setCamera(camera);
    const style = overlay.value?.style;
    style?.setProperty("--tx", `${camera.tx}px`);
    style?.setProperty("--ty", `${camera.ty}px`);
    style?.setProperty("--zoom", `${camera.zoom}`);
  }

  async function mount() {
    if (!host.value) return;
    let made: FleetScene;
    try {
      made = await createFleetScene({
        host: host.value,
        onEnter: panels.enter,
        onLeave: panels.leave,
        onPick: panels.open,
        onResearch: panels.openResearch,
        onMachine: panels.openMachineAt,
        onHover: (slug) => {
          hovered.value = slug;
        },
        onHoverStar: (name) => {
          stars.hoveredStar.value = name;
        },
        onCamera: (worlds, camera) => {
          if (worlds.galaxy.width !== world.value.width || worlds.galaxy.height !== world.value.height) world.value = worlds.galaxy;
          if (worlds.system.width !== systemWorld.value.width || worlds.system.height !== systemWorld.value.height) systemWorld.value = worlds.system;
          applyCamera(camera);
        },
        labels: overlay.value ?? undefined,
        onLost: () => {
          failure.value = "lost";
          scene?.dispose();
          scene = null;
        },
      });
    } catch (error) {
      console.error(error);
      failure.value = "webgl";
      return;
    }
    if (unmounted) {
      made.dispose();
      return;
    }
    failure.value = null;
    scene = made;
    feed();
  }

  function retry() {
    failure.value = null;
    void nextTick(mount);
  }

  // Every measure of the stage in a system tells the scene, as it is made.
  watch(stage.insets, (insets) => scene?.setInsets(insets), { flush: "sync" });
  watch(model.galaxySources, () => scene?.setGalaxy(model.galaxyModel()));
  watch(() => props.machine, (id) => scene?.setMachine(id ?? null));
  watch(repoArt, (art) => scene?.setArt(art));
  // The station's screen covers the whole map: the galaxy under it stops drawing until it closes.
  watch(researchOpen, (open) => scene?.setActive(props.active && !open));
  watch(repo, (name) => scene?.setView(name), { flush: "sync" });
  watch(entries, setShips);
  watch(selected, (slug) => scene?.setSelected(slug));
  watch(hovered, (slug) => scene?.setHovered(slug));
  watch(
    () => props.active,
    (active) => scene?.setActive(active && !researchOpen.value),
  );
  onMounted(() => void mount());
  onBeforeUnmount(() => {
    unmounted = true;
    scene?.dispose();
    scene = null;
  });

  return { failure, retry };
}
