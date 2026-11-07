// The browser tab tells about tasks that need attention: their count in the title and an alarm icon. Without
// them the tab shows its own title and icon again.

import { tabTitle } from "./labels";

/** A red alarm badge with an exclamation mark, drawn on a canvas; null where a canvas cannot draw. */
function alarmIcon(doc: Document): string | null {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const gradient = context.createRadialGradient(26, 24, 4, 32, 32, 30);
  gradient.addColorStop(0, "#ff8a70");
  gradient.addColorStop(0.55, "#e0412f");
  gradient.addColorStop(1, "#8e1d16");
  context.beginPath();
  context.arc(32, 32, 29, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = "#3a0d0a";
  context.stroke();
  context.fillStyle = "#fff6ec";
  context.beginPath();
  context.roundRect(27, 12, 10, 27, 4);
  context.fill();
  context.beginPath();
  context.arc(32, 49, 5.5, 0, Math.PI * 2);
  context.fill();
  return canvas.toDataURL("image/png");
}

/** Shows `alarms` tasks in trouble in the tab of `doc`; zero brings back the tab's own title and icon. */
export function tabAlarm(doc: Document): { show(alarms: number): void } {
  const title = doc.title;
  let link = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const href = link?.getAttribute("href") ?? null;
  const own = link === null;
  let icon: string | null | undefined;
  return {
    show(alarms) {
      doc.title = tabTitle(title, alarms);
      if (alarms > 0) {
        if (icon === undefined) icon = alarmIcon(doc);
        if (!icon) return;
        if (!link) {
          link = doc.createElement("link");
          link.rel = "icon";
          doc.head.appendChild(link);
        }
        link.href = icon;
      } else if (link && own) {
        link.remove();
        link = null;
      } else if (link && href !== null) {
        link.setAttribute("href", href);
      }
    },
  };
}
