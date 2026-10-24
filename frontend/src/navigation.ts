import * as THREE from "three";
import type { ViewerRuntime } from "./runtime.js";

type Point = [number, number, number];
export function wheelZoomScale(pixels: number): number {
  return Math.exp(Math.max(-1200, Math.min(1200, pixels)) * 0.002);
}
export function cursorZoom(position: Point, forward: Point, direction: Point, distance: number, scale: number) {
  if (![...position, ...forward, ...direction, distance, scale].every(Number.isFinite) || distance <= 0 || scale <= 0) return null;
  const nextDistance = distance * scale;
  const alignment = forward.reduce((sum, value, i) => sum + value * direction[i], 0);
  if (alignment <= 0 || !Number.isFinite(nextDistance)) return null;
  const moved = position.map((value, i) => value + direction[i] * (distance - nextDistance)) as Point;
  const target = moved.map((value, i) => value + forward[i] * nextDistance * alignment) as Point;
  return [...moved, ...target].every(Number.isFinite) ? { position: moved, target } : null;
}
export function modelClipping(position: Point, target: Point, bounds: number[]) {
  const distance = Math.hypot(...position.map((value, i) => value - target[i]));
  const near = Math.max(distance / 1000, 1e-7);
  const centre = [0, 1, 2].map(i => (bounds[i] + bounds[i + 3]) / 2);
  const radius = Math.hypot(...[0, 1, 2].map(i => bounds[i + 3] - bounds[i])) / 2;
  return { near, far: Math.max(Math.hypot(...position.map((value, i) => value - centre[i])) + radius, near * 100) };
}
export function attachCursorNavigation(viewer: Pick<ViewerRuntime, "camera" | "controls" | "renderer" | "hitTest" | "invalidate">): () => void {
  const { camera, controls, renderer } = viewer;
  const lifetime = new AbortController();
  controls.minDistance = 0;
  controls.maxDistance = Infinity;
  renderer.domElement.addEventListener("wheel", event => {
    if (!(controls as unknown as { enabled: boolean }).enabled || !controls.enableZoom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const alignment = forward.dot(ray.ray.direction);
    if (alignment <= 0) return;
    const distance = viewer.hitTest(event.clientX, event.clientY)?.distance ?? camera.position.distanceTo(controls.target) / alignment;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const moved = cursorZoom(camera.position.toArray() as Point, forward.toArray() as Point, ray.ray.direction.toArray() as Point, distance, wheelZoomScale(event.deltaY * unit * (event.ctrlKey ? 4 : 1)));
    if (!moved) return;
    camera.position.fromArray(moved.position);
    controls.target.fromArray(moved.target);
    controls.update();
    viewer.invalidate();
  }, { capture: true, passive: false, signal: lifetime.signal });
  return () => lifetime.abort();
}
