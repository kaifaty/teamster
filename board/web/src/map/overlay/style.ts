// The labels over the map's canvas: where each stands. Pure data, no Vue.

/** Where a label stands in the world; the camera's --tx, --ty and --zoom on the overlay turn it into pixels. */
export const at = (x: number, y: number) => ({ "--x": Math.round(x), "--y": Math.round(y) });
