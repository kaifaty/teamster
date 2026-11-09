// The kit the scene's drawing shares: the painted art, sprites and glows, the procedural textures, the grey filter and
// whether motion is reduced. The scene makes it once and frees it when it goes.

import { Assets, ColorMatrixFilter, Sprite, Texture } from "pixi.js";
import { ART, type ArtName } from "../art";
import { noise } from "./math";

export interface Kit {
  /** prefers-reduced-motion: the scene stands still. */
  still: boolean;
  art(name: ArtName): Texture;
  /** A sprite of `texture` centred on its position, `size` world units across its longer side. */
  sprite(texture: Texture, size: number): Sprite;
  /** A soft additive glow of `color`, `size` world units across. */
  glow(color: string, size: number): Sprite;
  glowTexture: Texture;
  cloudTexture: Texture;
  stormTexture: Texture;
  greyFilter: ColorMatrixFilter;
  /** Frees the procedural textures and the filter; the art stays in the Assets cache for the next scene. */
  dispose(): void;
}

/** Loads the art and makes the procedural textures. */
export async function createKit(): Promise<Kit> {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const loaded = (await Assets.load(Object.values(ART))) as Record<string, Texture>;
  const art = (name: ArtName): Texture => loaded[ART[name]]!;
  const glowTexture = Texture.from(softDisc(), true);
  const cloudTexture = Texture.from(softCloud(), true);
  const stormTexture = Texture.from(stormCloud(), true);
  const greyFilter = new ColorMatrixFilter();
  greyFilter.desaturate();

  const sprite = (texture: Texture, size: number): Sprite => {
    const made = new Sprite(texture);
    made.anchor.set(0.5);
    made.scale.set(size / Math.max(texture.width, texture.height));
    return made;
  };
  const glow = (color: string, size: number): Sprite => {
    const made = sprite(glowTexture, size);
    made.tint = color;
    made.blendMode = "add";
    return made;
  };
  return {
    still,
    art,
    sprite,
    glow,
    glowTexture,
    cloudTexture,
    stormTexture,
    greyFilter,
    dispose() {
      glowTexture.destroy(true);
      stormTexture.destroy(true);
      greyFilter.destroy();
      cloudTexture.destroy(true);
    },
  };
}

function softDisc(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return canvas;
}

/** A wide soft disc, nearly even to half its radius: overlapping, these run together into one cloud. */
function softCloud(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.8, "rgba(255,255,255,0.25)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return canvas;
}

/** A dark cloud with curling arms and a thinner eye, for a storm over a star; its rims catch a cold light. */
function stormCloud(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  // A body that is thin over the star and dense around it.
  const body = context.createRadialGradient(128, 128, 0, 128, 128, 124);
  body.addColorStop(0, "rgba(14,10,22,0)");
  body.addColorStop(0.3, "rgba(14,10,22,0.08)");
  body.addColorStop(0.45, "rgba(20,15,30,0.5)");
  body.addColorStop(0.75, "rgba(24,18,34,0.45)");
  body.addColorStop(1, "rgba(24,18,34,0)");
  context.fillStyle = body;
  context.fillRect(0, 0, 256, 256);
  // Spiral arms: a dark band each, soft-edged, with a thin lit rim along its outer side.
  const arm = (start: number, width: number, inner: number, outer: number, sweep: number) => {
    context.beginPath();
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const angle = start + u * sweep;
      const distance = inner + (outer - inner) * u;
      const x = 128 + Math.cos(angle) * distance;
      const y = 128 + Math.sin(angle) * distance;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.lineWidth = width;
    context.stroke();
  };
  context.lineCap = "round";
  context.lineJoin = "round";
  for (let i = 0; i < 4; i++) {
    const start = (i * Math.PI) / 2 + noise(i + 20) * 0.5;
    const sweep = 2.2 + noise(i + 30) * 0.8;
    context.filter = "blur(9px)";
    context.strokeStyle = "rgba(18,13,28,0.9)";
    arm(start, 38 - i * 3, 46, 116, sweep);
    arm(start, 38 - i * 3, 46, 116, sweep);
    context.filter = "blur(3px)";
    context.strokeStyle = "rgba(12,9,20,0.7)";
    arm(start, 14, 48, 114, sweep);
    context.filter = "blur(4px)";
    context.strokeStyle = "rgba(150,128,186,0.34)";
    arm(start - 0.16, 6, 60, 124, sweep);
  }
  context.filter = "none";
  return canvas;
}
