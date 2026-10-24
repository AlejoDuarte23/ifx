import * as THREE from "three";
import type { Viewer } from "./viewer.js";

export class VertexSnapper {
  private cache = new Map<number, THREE.Vector3[]>();
  constructor(private viewer: Viewer) {}
  clear() { this.cache.clear(); }
  at(clientX: number, clientY: number, tolerance = 14) {
    const { viewer } = this;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const hit = viewer.hitTest(clientX, clientY);
    const ids = new Set<number>();
    if (hit) ids.add(hit.element.id);
    // Nearby rays include corners just outside the model silhouette.
    for (const [x, y] of [[-tolerance, 0], [tolerance, 0], [0, -tolerance], [0, tolerance]]) {
      const nearby = viewer.hitTest(clientX + x, clientY + y);
      if (nearby) ids.add(nearby.element.id);
    }
    let best: { point: THREE.Vector3; pixels: number; depth: number } | null = null;
    for (const id of ids) {
      if (!viewer.isVisible(id)) continue;
      let vertices = this.cache.get(id);
      if (!vertices) {
        const geometry = viewer.getElementGeometry(id);
        if (!geometry) continue;
        const attribute = geometry.getAttribute("position");
        const unique = new Map<string, THREE.Vector3>();
        for (let i = 0; i < attribute.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(attribute, i);
          unique.set(point.toArray().map(value => Math.round(value * 1e6)).join(":"), point);
        }
        geometry.dispose();
        vertices = [...unique.values()];
        if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(id, vertices);
      }
      for (const point of vertices) {
        if (viewer.isPointVisible && !viewer.isPointVisible(point)) continue;
        const projected = point.clone().project(viewer.camera);
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
        const x = rect.left + (projected.x + 1) * rect.width / 2;
        const y = rect.top + (1 - projected.y) * rect.height / 2;
        const pixels = Math.hypot(x - clientX, y - clientY);
        if (pixels > tolerance || (best && pixels > best.pixels + 1)) continue;
        const depth = viewer.camera.position.distanceTo(point);
        if (best && Math.abs(pixels - best.pixels) <= 1 && depth >= best.depth) continue;
        const obstruction = viewer.hitTest(x, y);
        if (obstruction && obstruction.distance < depth - Math.max(1e-5, depth * 1e-5)) continue;
        best = { point, pixels, depth };
      }
    }
    return best ? { point: viewer.toWorld(best.point), kind: "vertex" as const } : hit ? { point: viewer.toWorld(hit.point), kind: "surface" as const } : null;
  }
}
