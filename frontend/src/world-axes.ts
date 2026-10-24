import * as THREE from "three";
import type { ViewerRuntime } from "./runtime.js";

const axes = [
  { label: "X", color: "#b85c61", vector: [1, 0, 0] },
  { label: "Y", color: "#42886a", vector: [0, 1, 0] },
  { label: "Z", color: "#627bc0", vector: [0, 0, 1] },
];
export function axisProjection(quaternion: THREE.Quaternion) {
  const inverse = quaternion.clone().invert();
  return axes.map(axis => {
    const p = new THREE.Vector3().fromArray(axis.vector).applyQuaternion(inverse);
    return { ...axis, x: p.x, y: -p.y, depth: p.z };
  }).sort((a, b) => a.depth - b.depth);
}

export function axisLayout(quaternion: THREE.Quaternion) {
  const projected = axisProjection(quaternion).sort((a, b) => a.label.localeCompare(b.label));
  const placed = projected.map(axis => {
    const length = Math.hypot(axis.x, axis.y);
    const gap = 10 / Math.sqrt(length * length + .0025);
    const collapsed = Math.exp(-length * length / .02);
    let aligned = 0;
    for (const other of projected) {
      if (other === axis) continue;
      const cosine = Math.max(0, (axis.x * other.x + axis.y * other.y) / Math.hypot(axis.x, axis.y, .001) / Math.hypot(other.x, other.y, .001));
      aligned = Math.max(aligned, cosine ** 16);
    }
    // Stagger nearly aligned labels by depth before they reach the same point.
    const radius = (22 + gap) * (1 - aligned) + (32 + 13 * axis.depth) / Math.hypot(length, .05) * aligned;
    return {
      ...axis,
      tip: { x: axis.x * 22, y: axis.y * 22 },
      labelPoint: { x: axis.x * radius - 12 * collapsed, y: axis.y * radius + 12 * collapsed },
    };
  });
  const center = () => {
    const bounds = { left: 0, right: 0, top: 0, bottom: 0 };
    const include = (x: number, y: number, paddingX: number, paddingY: number) => {
      bounds.left = Math.min(bounds.left, x - paddingX); bounds.right = Math.max(bounds.right, x + paddingX);
      bounds.top = Math.min(bounds.top, y - paddingY); bounds.bottom = Math.max(bounds.bottom, y + paddingY);
    };
    for (const axis of placed) {
      include(-axis.x * 10, -axis.y * 10, 1, 1);
      include(axis.tip.x, axis.tip.y, 3, 3);
      include(axis.labelPoint.x, axis.labelPoint.y, 4, 6);
    }
    return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  };
  // Keep a stable axis order so a depth change cannot change label placement.
  for (let pass = 0; pass < 64; pass++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const dx = a.labelPoint.x - b.labelPoint.x, dy = a.labelPoint.y - b.labelPoint.y;
        const distance = Math.hypot(dx, dy), overlap = Math.max(0, 18 - distance) / 2;
        // A small, stable sideways force separates labels at the same point.
        const sideX = -a.tip.y - b.tip.y, sideY = a.tip.x + b.tip.x;
        const sideLength = Math.hypot(sideX, sideY, .001);
        const pushX = dx + .01 * sideX / sideLength, pushY = dy + .01 * sideY / sideLength;
        const pushLength = Math.hypot(pushX, pushY, .000001);
        a.labelPoint.x += overlap * pushX / pushLength; a.labelPoint.y += overlap * pushY / pushLength;
        b.labelPoint.x -= overlap * pushX / pushLength; b.labelPoint.y -= overlap * pushY / pushLength;
      }
    }
    const midpoint = center();
    for (const axis of placed) {
      const x = axis.labelPoint.x - midpoint.x, y = axis.labelPoint.y - midpoint.y;
      const radiusSquared = x * x + y * y;
      const edge = 4 * Math.abs(x) + 6 * Math.abs(y);
      // Fit the full 8 by 12 label box, with one pixel of disc padding.
      if (Math.hypot(Math.abs(x) + 4, Math.abs(y) + 6) > 40) {
        const scale = (-edge + Math.sqrt(edge * edge + radiusSquared * (1600 - 52))) / radiusSquared;
        axis.labelPoint.x = midpoint.x + x * scale; axis.labelPoint.y = midpoint.y + y * scale;
      }
    }
  }
  const midpoint = center();
  return { axes: placed.sort((a, b) => a.depth - b.depth), origin: { x: 44 - midpoint.x, y: 44 - midpoint.y } };
}

export class WorldAxes {
  readonly element: SVGSVGElement;
  private stopDispose: () => void;
  private render = () => {
    this.element.replaceChildren();
    const make = (tag: string, attributes: Record<string, string | number>) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    };
    this.element.append(make("circle", { cx: 44, cy: 44, r: 41, fill: "white", "fill-opacity": .88 }));
    const group = make("g", {});
    const layout = axisLayout(this.viewer.camera.getWorldQuaternion(new THREE.Quaternion()));
    for (const axis of layout.axes) {
      const { x, y, color, tip, labelPoint } = axis;
      group.append(make("line", { x1: -x * 10, y1: -y * 10, x2: 0, y2: 0, stroke: color, opacity: .25, "stroke-width": 1 }));
      group.append(make("line", { x1: 0, y1: 0, x2: tip.x, y2: tip.y, stroke: color, "stroke-width": 1.5 }));
      const length = Math.hypot(x, y);
      if (length > .15) {
        const dx = x / length, dy = y / length;
        group.append(make("path", { d: `M${tip.x - dx * 4 - dy * 2},${tip.y - dy * 4 + dx * 2} L${tip.x},${tip.y} L${tip.x - dx * 4 + dy * 2},${tip.y - dy * 4 - dx * 2}`, fill: "none", stroke: color, "stroke-width": 1.2 }));
      }
      const label = make("text", { ...labelPoint, fill: color, "font-family": "'Geist Variable',Arial,sans-serif", "font-size": 10, "font-weight": 500, "text-anchor": "middle", "dominant-baseline": "central" });
      label.textContent = axis.label;
      group.append(label);
    }
    group.setAttribute("transform", `translate(${layout.origin.x} ${layout.origin.y})`);
    this.element.append(group);
  };
  constructor(private viewer: ViewerRuntime, host: HTMLElement) {
    this.element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.element.setAttribute("viewBox", "0 0 88 88");
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "World axes. X red, Y green, Z blue. Z is elevation.");
    this.element.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
    host.append(this.element);
    (viewer.controls as unknown as EventTarget).addEventListener("change", this.render);
    this.stopDispose = viewer.on("dispose", () => this.dispose());
    this.render();
  }
  dispose() {
    (this.viewer.controls as unknown as EventTarget).removeEventListener("change", this.render);
    this.stopDispose?.();
    this.element.remove();
  }
}
