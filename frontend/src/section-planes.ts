import * as THREE from "three";
import type { Viewer } from "./viewer.js";
import { disposeObject } from "./overlays.js";
import { VertexSnapper } from "./vertex-snap.js";

export type SectionAxis = "x" | "y" | "z";
export type SectionPoint = readonly [number, number, number];
export type SectionPickMode = "three" | "vertical";
export type SectionState = {
  axis: SectionAxis | "custom" | null;
  active: boolean;
  position: number;
  normal: [number, number, number];
  flipped: boolean;
  visible: boolean;
  picking: SectionPickMode | null;
  picked: number;
  notice: string;
};
const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const colors = { x: 0xb85c61, y: 0x42886a, z: 0x627bc0 };
const normalAxis = new THREE.Vector3(0, 0, 1);
const arcRadius = 1.6;
const arcLength = 1;

type Arc = { axis: THREE.Vector3; mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>; hit: THREE.Mesh; color: number };
type Drag = {
  id: number; x: number; y: number; controls: boolean;
  center: THREE.Vector3; orientation: THREE.Quaternion;
  axis: THREE.Vector3 | null; localAxis: THREE.Vector3 | null;
  position: number; screen: THREE.Vector2;
  tangent: THREE.Vector2 | null; radiansPerPixel: number;
};

export function sectionRange(bounds: THREE.Box3, normal: THREE.Vector3): [number, number] {
  const center = bounds.getCenter(new THREE.Vector3()), half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const extent = Math.abs(normal.x) * half.x + Math.abs(normal.y) * half.y + Math.abs(normal.z) * half.z;
  return [center.dot(normal) - extent, center.dot(normal) + extent];
}
export function sectionPlane(bounds: THREE.Box3, normal: THREE.Vector3, position: number, flipped = false): THREE.Plane {
  if (bounds.isEmpty() || ![...bounds.min, ...bounds.max, ...normal, position].every(Number.isFinite) || normal.lengthSq() < 1e-12 || position < 0 || position > 1)
    throw new Error("Use finite model bounds, a nonzero normal, and a section position from 0 to 1.");
  const direction = normal.clone().normalize(), [min, max] = sectionRange(bounds, direction);
  const plane = new THREE.Plane(direction, -THREE.MathUtils.lerp(min, max, position));
  return flipped ? plane.negate() : plane;
}
export function sectionFromPoints(points: readonly SectionPoint[], mode: SectionPickMode = points.length === 2 ? "vertical" : "three") {
  const count = mode === "vertical" ? 2 : 3;
  if ((mode !== "vertical" && mode !== "three") || points.length !== count || points.some(point => point.length !== 3 || !point.every(Number.isFinite)))
    throw new Error(`Choose ${count} finite points for this section plane.`);
  const values = points.map(point => new THREE.Vector3(...point)), direction = values[1].clone().sub(values[0]);
  if (direction.length() < 1e-7) throw new Error("Choose a different second point.");
  const normal = direction.clone().cross(mode === "vertical" ? normalAxis : values[2].clone().sub(values[0]));
  const scale = direction.length() * (mode === "vertical" ? 1 : values[2].distanceTo(values[0]));
  if (normal.length() < Math.max(1e-10, scale * 1e-6))
    throw new Error(mode === "vertical" ? "Choose points with different X or Y coordinates for a vertical plane." : "Choose a third point away from the line between the first two points.");
  normal.normalize(); direction.normalize();
  const center = values.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(count);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(direction, normal.clone().cross(direction).normalize(), normal));
  return { normal, center, orientation };
}

export class SectionPlanes {
  private readonly group = new THREE.Group();
  private readonly handle = new THREE.Group();
  private readonly draft = new THREE.Group();
  private readonly plane = new THREE.Plane();
  private readonly bounds = new THREE.Box3();
  private readonly normal = new THREE.Vector3(1, 0, 0);
  private readonly center = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private readonly listeners = new Set<(state: SectionState) => void>();
  private readonly stops: (() => void)[] = [];
  private readonly lifetime = new AbortController();
  private readonly controls: { enabled: boolean };
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly picks: THREE.Object3D[] = [];
  private readonly arcs: Arc[] = [];
  private readonly snapper: VertexSnapper;
  private readonly points: THREE.Vector3[] = [];
  private hover: THREE.Vector3 | null = null;
  private pointerDown: { id: number; x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private hovered: THREE.Object3D | null = null;
  private disposed = false;
  private cursor: string | null = null;
  state: SectionState = { axis: null, active: false, position: 0.5, normal: [1, 0, 0], flipped: false, visible: true, picking: null, picked: 0, notice: "" };

  constructor(private readonly viewer: Viewer) {
    this.controls = viewer.controls as typeof viewer.controls & { enabled: boolean };
    this.snapper = new VertexSnapper(viewer);
    this.group.name = "Section plane"; this.handle.name = "Section handles"; this.draft.name = "Section points";
    this.group.visible = false; this.group.add(this.handle); viewer.scene.add(this.group, this.draft);
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener("pointerdown", this.start, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointermove", this.move, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointerup", this.end, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointercancel", this.end, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("lostpointercapture", this.end, { signal: this.lifetime.signal });
    canvas.addEventListener("pointerleave", () => { if (!this.drag) { this.highlight(null); this.hover = null; this.paintDraft(); } }, { signal: this.lifetime.signal });
    if (typeof window !== "undefined") window.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (this.drag) { event.preventDefault(); this.cancelDrag(); }
      else if (this.state.picking) { event.preventDefault(); this.cancelPick(); }
    }, { signal: this.lifetime.signal });
    const controlEvents = viewer.controls as typeof viewer.controls & { addEventListener?: (name: string, listener: () => void) => void; removeEventListener?: (name: string, listener: () => void) => void };
    controlEvents.addEventListener?.("change", this.sizeHandles);
    this.stops.push(() => controlEvents.removeEventListener?.("change", this.sizeHandles));
    if (typeof window !== "undefined") window.addEventListener("blur", () => this.cancelDrag(), { signal: this.lifetime.signal });
    this.stops.push(viewer.on("render", this.sizeHandles), viewer.on("clear", this.reset), viewer.on("ready", this.reset), viewer.on("dispose", () => this.dispose()));
  }
  subscribe(listener: (state: SectionState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void {
    this.state = { ...this.state, normal: this.normal.toArray() as [number, number, number], picked: this.points.length };
    for (const listener of this.listeners) listener({ ...this.state, normal: [...this.state.normal] });
  }
  private requireBounds(): void {
    const values = this.viewer.getModelInfo().local_bbox;
    if (!values) throw new Error("Open a model before adding a section plane.");
    this.bounds.set(new THREE.Vector3(...values.slice(0, 3)), new THREE.Vector3(...values.slice(3, 6)));
    sectionPlane(this.bounds, normalAxis, 0.5);
  }
  setActive(active: boolean): void {
    this.finishDrag(); this.clearDraft(); this.highlight(null);
    this.state = { ...this.state, active, picking: null, notice: "" };
    this.apply();
  }
  setAxis(axis: SectionAxis): void {
    if (!Object.hasOwn(axes, axis)) throw new Error("Choose an X, Y, or Z section plane.");
    this.requireBounds(); this.finishDrag(); this.clearDraft();
    this.center.copy(this.bounds.getCenter(new THREE.Vector3()));
    this.orientation.setFromUnitVectors(normalAxis, axes[axis]); this.normal.copy(axes[axis]);
    this.state = { ...this.state, axis, active: true, flipped: false, visible: true, picking: null, notice: "" };
    this.build(); this.apply();
  }
  setPosition(position: number): void {
    if (!this.state.axis) return;
    sectionPlane(this.bounds, this.normal, position);
    const [min, max] = sectionRange(this.bounds, this.normal);
    this.center.addScaledVector(this.normal, THREE.MathUtils.lerp(min, max, position) - this.center.dot(this.normal));
    this.apply();
  }
  setNormal(normal: SectionPoint): void {
    if (!this.state.axis) return;
    const next = new THREE.Vector3(...normal);
    sectionPlane(this.bounds, next, 0.5); next.normalize();
    const delta = this.normal.dot(next) < -0.999999
      ? new THREE.Quaternion().setFromAxisAngle(axes.x.clone().applyQuaternion(this.orientation), Math.PI)
      : new THREE.Quaternion().setFromUnitVectors(this.normal, next);
    this.orientation.premultiply(delta).normalize(); this.apply();
  }
  rotate(axis: SectionAxis, degrees: number): void {
    if (!Object.hasOwn(axes, axis) || !Number.isFinite(degrees)) throw new Error("Use a valid axis and a finite angle.");
    if (!this.state.axis) return;
    this.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(axes[axis], THREE.MathUtils.degToRad(degrees))).normalize(); this.apply();
  }
  flip(): void { if (this.state.axis) { this.state = { ...this.state, flipped: !this.state.flipped }; this.apply(); } }
  setVisible(visible: boolean): void {
    if (!visible) { this.finishDrag(); if (this.state.picking) this.cancelPick(); }
    this.state = { ...this.state, visible }; this.highlight(null); this.apply();
  }
  beginPick(mode: SectionPickMode): void {
    if (mode !== "three" && mode !== "vertical") throw new Error("Choose three points or two points for a vertical plane.");
    this.requireBounds(); this.finishDrag(); this.clearDraft(); this.highlight(null);
    this.state = { ...this.state, active: true, visible: true, picking: mode, notice: "" }; this.apply();
  }
  cancelPick(): void { this.clearDraft(); this.state = { ...this.state, picking: null, notice: "" }; this.apply(); }
  setFromPoints(points: readonly SectionPoint[], mode: SectionPickMode = points.length === 2 ? "vertical" : "three"): void {
    this.requireBounds();
    const local = points.map(point => this.viewer.toLocal(new THREE.Vector3(...point)).toArray() as [number, number, number]);
    const result = sectionFromPoints(local, mode);
    // Keep the far side of a picked surface so its interior is visible.
    if (result.normal.dot(this.viewer.camera.position.clone().sub(result.center)) > 0) {
      result.orientation.multiply(new THREE.Quaternion().setFromAxisAngle(axes.x, Math.PI));
    }
    this.finishDrag(); this.clearDraft(); this.center.copy(result.center); this.orientation.copy(result.orientation);
    this.state = { ...this.state, axis: "custom", active: true, visible: true, picking: null, flipped: false, notice: "" };
    this.build(); this.apply();
  }
  clear(): void {
    if (this.disposed) return;
    this.finishDrag(); this.clearDraft(); this.highlight(null);
    this.state = { ...this.state, axis: null, position: 0.5, flipped: false, picking: null, notice: "" }; this.apply();
  }
  private reset = (): void => { this.state = { ...this.state, active: false }; this.snapper.clear(); this.clear(); };
  private apply(): void {
    this.normal.copy(normalAxis).applyQuaternion(this.orientation).normalize();
    const enabled = this.state.active && this.state.axis !== null && !this.state.picking;
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.center);
    if (this.state.flipped) this.plane.negate();
    this.viewer.setClippingPlanes(enabled ? [this.plane] : []);
    if (this.state.axis) {
      const [min, max] = sectionRange(this.bounds, this.normal);
      this.state = { ...this.state, position: THREE.MathUtils.clamp((this.center.dot(this.normal) - min) / Math.max(max - min, 1e-9), 0, 1) };
    }
    this.group.position.copy(this.center); this.group.quaternion.copy(this.orientation);
    this.group.visible = Boolean(enabled && this.state.visible);
    this.draft.visible = Boolean(this.state.active && this.state.visible && this.state.picking);
    if (this.draft.visible) this.setCursor("crosshair"); else if (!this.drag && !this.hovered) this.restoreCursor();
    this.sizeHandles(); this.viewer.invalidate(); this.emit();
  }
  private build(): void {
    for (const child of [...this.group.children]) if (child !== this.handle) { child.removeFromParent(); disposeObject(child); }
    for (const child of [...this.handle.children]) { child.removeFromParent(); disposeObject(child); }
    this.picks.length = 0; this.arcs.length = 0; this.hovered = null;
    const length = this.bounds.getSize(new THREE.Vector3()).length() * 1.05;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x * length / 2, y * length / 2, 0));
    this.group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: 0xa1a1aa, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false })));
    this.group.add(new THREE.Mesh(new THREE.PlaneGeometry(length, length), new THREE.MeshBasicMaterial({ color: 0x71717a, transparent: true, opacity: 0.025, side: THREE.DoubleSide, depthWrite: false })));
    const material = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.85, 12), material(0x52525b));
    stem.rotation.x = Math.PI / 2; stem.position.z = 0.44;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 16), material(0x52525b));
    tip.rotation.x = Math.PI / 2; tip.position.z = 0.98;
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), material(0x52525b));
    for (const mesh of [stem, tip, center]) { mesh.userData.sectionAction = "move"; this.handle.add(mesh); this.picks.push(mesh); }
    const moveHit = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.18, 12), material(0x52525b));
    moveHit.rotation.x = Math.PI / 2; moveHit.position.z = 0.5; moveHit.material.visible = false;
    moveHit.userData.sectionAction = "move"; this.handle.add(moveHit); this.picks.push(moveHit);
    const unused = new Set<SectionAxis>(["x", "y", "z"]);
    for (const axis of [axes.x, axes.y]) {
      const world = axis.clone().applyQuaternion(this.orientation);
      const name = [...unused].sort((a, b) => Math.abs(world.dot(axes[b])) - Math.abs(world.dot(axes[a])))[0]; unused.delete(name);
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(arcRadius, 0.017, 8, 64, arcLength), material(colors[name]));
      const hit = new THREE.Mesh(new THREE.TorusGeometry(arcRadius, 0.095, 6, 48, arcLength), material(colors[name]));
      hit.material.visible = false; hit.userData.sectionAxis = axis; mesh.userData.sectionAxis = axis;
      const tangent = axis.clone().cross(normalAxis);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(normalAxis, tangent, axis));
      mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(normalAxis, -arcLength / 2));
      mesh.position.set(0, 0, -arcRadius); hit.quaternion.copy(mesh.quaternion); hit.position.copy(mesh.position);
      this.handle.add(mesh, hit); this.picks.push(hit); this.arcs.push({ axis, mesh, hit, color: colors[name] });
    }
    for (const child of this.handle.children) child.renderOrder = 30;
  }
  private sizeHandles = (): void => {
    if (!this.state.axis && !this.state.picking) return;
    const camera = this.viewer.camera, height = this.viewer.renderer.domElement.getBoundingClientRect().height;
    if (!height) return;
    const scale = Math.max(2 * camera.position.distanceTo(this.center) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 58 / height, 1e-6);
    this.handle.scale.setScalar(scale);
    this.group.updateMatrixWorld(true);
    for (const child of this.draft.children) if (child instanceof THREE.Mesh) {
      child.scale.setScalar(2 * camera.position.distanceTo(child.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 4 / height);
    }
  };
  private ray(event: PointerEvent): THREE.Ray {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.viewer.camera.updateMatrixWorld(); this.raycaster.setFromCamera(this.pointer, this.viewer.camera); return this.raycaster.ray;
  }
  private pick(event: PointerEvent): THREE.Intersection | null {
    if (!this.group.visible) return null;
    this.ray(event); this.group.updateMatrixWorld(true);
    return this.raycaster.intersectObjects(this.picks, false).find(hit => hit.object.visible) ?? null;
  }
  private screen(point: THREE.Vector3): THREE.Vector2 {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect(), projected = point.clone().project(this.viewer.camera);
    return new THREE.Vector2((projected.x + 1) * rect.width / 2 + rect.left, (1 - projected.y) * rect.height / 2 + rect.top);
  }
  private highlight(object: THREE.Object3D | null): void {
    this.hovered = object;
    const selectedAxis = this.drag?.localAxis ?? object?.userData.sectionAxis;
    for (const arc of this.arcs) {
      const selected = selectedAxis === arc.axis;
      arc.mesh.visible = !this.drag || !this.drag.axis || selected;
      arc.hit.visible = arc.mesh.visible;
      arc.mesh.material.color.setHex(selected ? 0x18181b : arc.color);
    }
    if (this.state.picking) this.setCursor("crosshair");
    else if (object || this.drag) this.setCursor(this.drag ? "grabbing" : "grab"); else this.restoreCursor();
    this.viewer.invalidate();
  }
  private start = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag) return;
    if (this.state.picking) { this.pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY }; return; }
    const hit = this.pick(event); if (!hit) return;
    const localAxis: THREE.Vector3 | null = hit.object.userData.sectionAxis ?? null;
    const axis = localAxis?.clone().applyQuaternion(this.orientation).normalize() ?? null;
    let tangent: THREE.Vector2 | null = null;
    const view = this.viewer.camera.position.clone().sub(this.center).normalize();
    if (axis) {
      const arcCenter = this.center.clone().addScaledVector(this.normal, -arcRadius * this.handle.scale.x);
      const radial = hit.point.clone().sub(arcCenter); radial.addScaledVector(axis, -radial.dot(axis)).normalize();
      const direction = axis.clone().cross(radial).normalize();
      tangent = this.screen(hit.point.clone().add(direction)).sub(this.screen(hit.point));
      if (tangent.lengthSq() < 1e-6) tangent = this.screen(this.center.clone().add(axis.clone().cross(view))).sub(this.screen(this.center));
      if (tangent.lengthSq() < 1e-6) return;
      tangent.normalize();
    }
    const [min, max] = sectionRange(this.bounds, this.normal), screen = this.screen(this.center.clone().addScaledVector(this.normal, Math.max(max - min, 1e-6))).sub(this.screen(this.center));
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, controls: this.controls.enabled, center: this.center.clone(), orientation: this.orientation.clone(), axis, localAxis, position: this.state.position, screen, tangent, radiansPerPixel: 1 / (58 * arcRadius) };
    this.controls.enabled = false; this.viewer.renderer.domElement.setPointerCapture(event.pointerId);
    this.hovered = null; this.highlight(hit.object); event.preventDefault(); event.stopImmediatePropagation();
  };
  private move = (event: PointerEvent): void => {
    if (this.state.picking) {
      if (!event.buttons) { const snap = this.snapper.at(event.clientX, event.clientY); this.hover = snap ? this.viewer.toLocal(snap.point) : null; this.paintDraft(); }
      return;
    }
    const drag = this.drag;
    if (!drag) { this.highlight(this.pick(event)?.object ?? null); return; }
    if (event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (drag.axis) {
      const angle = new THREE.Vector2(event.clientX - drag.x, event.clientY - drag.y).dot(drag.tangent!) * drag.radiansPerPixel;
      this.center.copy(drag.center);
      this.orientation.copy(drag.orientation).premultiply(new THREE.Quaternion().setFromAxisAngle(drag.axis, angle)).normalize(); this.apply();
    } else {
      const delta = new THREE.Vector2(event.clientX - drag.x, event.clientY - drag.y);
      const movement = drag.screen.lengthSq() > 64 ? delta.dot(drag.screen) / drag.screen.lengthSq() : -delta.y / 250;
      this.setPosition(THREE.MathUtils.clamp(drag.position + movement, 0, 1));
    }
  };
  private end = (event: PointerEvent): void => {
    if (this.state.picking && this.pointerDown?.id === event.pointerId) {
      const down = this.pointerDown; this.pointerDown = null;
      if (event.type !== "pointerup" || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      event.preventDefault();
      const snap = this.snapper.at(event.clientX, event.clientY); if (!snap) return;
      const point = this.viewer.toLocal(snap.point);
      if (this.points.some(previous => previous.distanceTo(point) < 1e-7)) { this.state = { ...this.state, notice: "Choose a different point." }; this.emit(); return; }
      const count = this.state.picking === "vertical" ? 2 : 3;
      if (this.points.length + 1 === count) {
        try { this.setFromPoints([...this.points, point].map(point => this.viewer.toWorld(point).toArray() as [number, number, number]), this.state.picking); }
        catch (reason) { this.state = { ...this.state, notice: reason instanceof Error ? reason.message : "Choose a different point." }; this.emit(); }
      } else { this.points.push(point); this.state = { ...this.state, notice: "" }; this.paintDraft(); this.emit(); }
      return;
    }
    if (!this.drag || event.pointerId !== this.drag.id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === "pointercancel" || event.type === "lostpointercapture") this.cancelDrag(); else this.finishDrag();
  };
  private clearDraft(): void {
    this.pointerDown = null; this.points.length = 0; this.hover = null;
    for (const child of [...this.draft.children]) { child.removeFromParent(); disposeObject(child); }
  }
  private paintDraft(): void {
    for (const child of [...this.draft.children]) { child.removeFromParent(); disposeObject(child); }
    const points = [...this.points, ...(this.hover ? [this.hover] : [])];
    for (const point of points) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x18181b, depthTest: false, depthWrite: false }));
      dot.position.copy(point); dot.renderOrder = 31; this.draft.add(dot);
    }
    if (points.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.length === 3 ? [...points, points[0]] : points), new THREE.LineBasicMaterial({ color: 0x737373, depthTest: false, depthWrite: false }));
      line.renderOrder = 30; this.draft.add(line);
    }
    this.sizeHandles(); this.viewer.invalidate();
  }
  private cancelDrag(): void {
    if (!this.drag) return;
    this.center.copy(this.drag.center); this.orientation.copy(this.drag.orientation); this.finishDrag(); this.apply();
  }
  private finishDrag(): void {
    if (!this.drag) return;
    const drag = this.drag; this.drag = null; this.controls.enabled = drag.controls;
    const canvas = this.viewer.renderer.domElement;
    if (canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    this.hovered = null; this.highlight(null); this.sizeHandles(); this.viewer.invalidate();
  }
  private setCursor(cursor: string): void {
    const canvas = this.viewer.renderer.domElement; if (this.cursor === null) this.cursor = canvas.style.cursor; canvas.style.cursor = cursor;
  }
  private restoreCursor(): void { if (this.cursor !== null) this.viewer.renderer.domElement.style.cursor = this.cursor; this.cursor = null; }
  dispose(): void {
    if (this.disposed) return;
    this.reset(); this.disposed = true; this.lifetime.abort(); this.stops.forEach(stop => stop());
    for (const object of [this.group, this.draft]) { object.removeFromParent(); disposeObject(object); object.clear(); }
    this.listeners.clear();
  }
}
