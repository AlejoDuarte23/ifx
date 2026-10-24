import * as THREE from "three";
import { dimensionLayout, dimensionWitness } from "./dimension-layout.js";
import { VertexSnapper } from "./vertex-snap.js";
import { nearestFaceEdge, planarFace } from "./surface-measurement.js";
import type { Viewer } from "./viewer.js";
import { dimensionPoints, measurementValue, measurementBasis, measurementOffset, type MeasurementPoint, type MeasurementReference, type MeasurementPlane, type MeasurementMode, type MeasurementOptions, type MeasurementRecord } from "./measurement-geometry.js";

export type MeasurementTarget = "points" | "edge" | "face";
export type AreaMeasurement = { id: string; value: number; center: MeasurementPoint; dimensionIds: string[] };
export type MeasurementState = { active: boolean; mode: MeasurementMode; reference: MeasurementReference; plane: MeasurementPlane; step: "start" | "end" | "place"; count: number; visible: boolean; selectedId?: string | null; target?: MeasurementTarget; notice?: string };
export class Measurements {
  private records: MeasurementRecord[] = [];
  private areas: AreaMeasurement[] = [];
  private listeners = new Set<(state: MeasurementState) => void>();
  private lifetime = new AbortController();
  private labelHost: SVGSVGElement;
  private snapper: VertexSnapper;
  private hover: { point: MeasurementPoint; kind: "vertex" | "surface" } | null = null;
  private previewRecord: MeasurementRecord | null = null;
  private generation = 0;
  private sequence = 0;
  private pending: { start: MeasurementPoint; end?: MeasurementPoint } | null = null;
  private chain: { id: string; start: MeasurementPoint } | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private dragging: string | null = null;
  private stopReady: () => void;
  private stopClear: () => void;
  private stopDispose: () => void;
  private stopRender: () => void;
  private resize: ResizeObserver;
  state: MeasurementState = { active: false, mode: "single", reference: "length", plane: "auto", step: "start", count: 0, visible: true };

  constructor(private viewer: Viewer, host: HTMLElement) {
    this.snapper = new VertexSnapper(viewer);
    this.labelHost = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.labelHost.setAttribute("aria-label", "Model dimensions");
    this.labelHost.setAttribute("class", "ifx-dimensions");
    this.labelHost.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden";
    host.append(this.labelHost);
    const canvas = viewer.renderer.domElement as HTMLCanvasElement;
    canvas.addEventListener("pointerdown", event => { if (event.button === 0) this.pointerDown = { x: event.clientX, y: event.clientY }; }, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointerup", this.pick, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointermove", this.move, { capture: true, signal: this.lifetime.signal });
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.positionLabels(); }, { signal: this.lifetime.signal });
    canvas.addEventListener("pointercancel", () => { this.pointerDown = null; }, { signal: this.lifetime.signal });
    canvas.addEventListener("dblclick", event => { if (this.state.active) { event.preventDefault(); } }, { capture: true, signal: this.lifetime.signal });
    window.addEventListener("keydown", event => {
      if (event.target instanceof HTMLElement && event.target.closest("input,select,textarea,[role=combobox]")) return;
      if (event.key === "Escape") { this.cancelPending(); this.select(null); }
      if ((event.key === "Delete" || event.key === "Backspace") && this.state.selectedId) { event.preventDefault(); this.remove(this.state.selectedId); }
    }, { signal: this.lifetime.signal });
    window.addEventListener("pointermove", event => {
      const record = this.records.find(row => row.id === this.dragging);
      if (record) { event.preventDefault(); this.update(record.id, { offset: this.offsetAt(record, event.clientX, event.clientY) }); }
    }, { signal: this.lifetime.signal });
    window.addEventListener("pointerup", () => { this.dragging = null; }, { signal: this.lifetime.signal });
    window.addEventListener("pointercancel", () => { this.dragging = null; }, { signal: this.lifetime.signal });
    this.stopRender = viewer.on("render", this.positionLabels);
    this.resize = new ResizeObserver(this.positionLabels);
    this.resize.observe(canvas);
    this.stopReady = viewer.on("ready", () => { this.clear(); this.setActive(false); });
    this.stopClear = viewer.on("clear", () => { this.clear(); this.setActive(false); });
    this.stopDispose = viewer.on("dispose", () => this.dispose());
  }
  subscribe(listener: (state: MeasurementState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(patch: Partial<MeasurementState> = {}) { this.state = { ...this.state, ...patch, count: this.records.length + this.areas.length }; for (const listener of this.listeners) listener({ ...this.state }); }
  setActive(active: boolean) { this.cancelPending(); this.emit({ active, selectedId: null }); }
  setMode(mode: MeasurementMode) {
    if (mode === this.state.mode) return;
    this.chain = null; this.emit({ mode });
  }
  setTarget(target: MeasurementTarget) { this.cancelPending(); this.emit({ target, selectedId: null, notice: "" }); }
  setReference(reference: MeasurementReference) {
    const plane = this.state.plane !== "auto" && reference !== "length" && !this.state.plane.includes(reference) ? "auto" : this.state.plane;
    this.setSettings({ reference, plane });
  }
  setPlane(plane: MeasurementPlane) {
    this.setSettings({ reference: this.state.reference, plane });
  }
  setSettings(settings: { reference: MeasurementReference; plane: MeasurementPlane }) {
    if (settings.reference === this.state.reference && settings.plane === this.state.plane) return;
    measurementBasis([0,0,0], [1,1,1], settings.reference, settings.plane);
    if (this.pending?.end) {
      if (measurementValue(this.pending.start, this.pending.end, settings.reference).value < 1e-9)
        throw new Error("These points have no distance along that axis. Choose another reference.");
      measurementBasis(this.pending.start, this.pending.end, settings.reference, settings.plane);
    }
    if (this.state.selectedId) this.update(this.state.selectedId, settings);
    if (this.previewRecord) {
      const previous = this.previewRecord;
      const value = measurementValue(previous.start, previous.end, settings.reference);
      if (value.value > 1e-9) {
        const distance = new THREE.Vector3(...previous.offset).dot(measurementBasis(previous.start, previous.end, previous.reference, previous.plane).perpendicular);
        const offset = measurementBasis(previous.start, previous.end, settings.reference, settings.plane).perpendicular.multiplyScalar(distance).toArray() as MeasurementPoint;
        this.previewRecord = { ...previous, ...settings, ...value, offset };
      } else this.previewRecord = null;
    }
    this.chain = null;
    this.emit({ ...settings, notice: "" }); this.positionLabels();
  }
  setVisible(visible: boolean) { this.emit({ visible }); this.positionLabels(); }
  list(): MeasurementRecord[] { return structuredClone(this.records); }
  listAreas(): AreaMeasurement[] { return structuredClone(this.areas); }
  removeArea(id: string) {
    const area = this.areas.find(row => row.id === id);
    if (!area) return;
    this.records = this.records.filter(row => !area.dimensionIds.includes(row.id));
    this.areas = this.areas.filter(row => row.id !== id); this.emit({ selectedId: null }); this.paint();
  }
  add(start: MeasurementPoint, end: MeasurementPoint, options: MeasurementOptions = {}): MeasurementRecord {
    const reference = options.reference ?? this.state.reference;
    const plane = options.plane ?? this.state.plane;
    measurementBasis(start, end, reference, plane);
    const { value, delta } = measurementValue(start, end, reference);
    if (value < 1e-9) throw new Error("Choose points with different coordinates for this measurement reference.");
    const offset = options.offset ?? [0,0,0];
    if (!offset.every(Number.isFinite)) throw new Error("The dimension offset must be finite.");
    const record: MeasurementRecord = { id: `${this.generation}:${++this.sequence}`, start: [...start], end: [...end], reference, plane, offset: [...offset], value, delta };
    this.records.push(record);
    this.paint(); this.emit();
    return structuredClone(record);
  }
  update(id: string, options: MeasurementOptions): MeasurementRecord {
    const record = this.records.find(row => row.id === id);
    if (!record) throw new Error("This dimension is no longer available.");
    const reference = options.reference ?? record.reference, plane = options.plane ?? record.plane;
    const { value, delta } = measurementValue(record.start, record.end, reference);
    if (value < 1e-9) throw new Error("Choose points with different coordinates for this measurement reference.");
    const basis = measurementBasis(record.start, record.end, reference, plane);
    const distance = new THREE.Vector3(...record.offset).dot(measurementBasis(record.start, record.end, record.reference, record.plane).perpendicular);
    const offset = options.offset ?? basis.perpendicular.multiplyScalar(distance).toArray() as MeasurementPoint;
    if (!offset.every(Number.isFinite)) throw new Error("The dimension offset must be finite.");
    Object.assign(record, { reference, plane, value, delta, offset: [...offset] });
    this.paint(); this.emit(); return structuredClone(record);
  }
  select(id: string | null) {
    const record = this.records.find(row => row.id === id);
    this.cancelPending();
    this.emit({ selectedId: record?.id ?? null, ...(record ? { reference: record.reference, plane: record.plane } : {}) });
    this.paint();
  }
  remove(id: string) { this.records = this.records.filter(record => record.id !== id); this.paint(); this.emit({ selectedId: this.state.selectedId === id ? null : this.state.selectedId }); }
  clear() { ++this.generation; this.sequence = 0; this.records = []; this.areas = []; this.snapper.clear(); this.chain = null; this.dragging = null; this.cancelPending(); this.paint(); this.emit({ selectedId: null, notice: "" }); }
  cancelPending() { this.pending = null; this.chain = null; this.hover = null; this.previewRecord = null; this.emit({ step: "start" }); this.positionLabels(); }
  private pointAt(clientX: number, clientY: number): MeasurementPoint | null {
    const snap = this.snapper.at(clientX, clientY);
    this.hover = snap ? { point: snap.point.toArray() as MeasurementPoint, kind: snap.kind } : null;
    return this.hover?.point ?? null;
  }
  private placementAt(clientX: number, clientY: number): MeasurementPoint {
    if (!this.pending?.end) return [0,0,0];
    return this.offsetAt({ start: this.pending.start, end: this.pending.end, reference: this.state.reference, plane: this.state.plane }, clientX, clientY);
  }
  private offsetAt(record: Pick<MeasurementRecord, "start" | "end" | "reference" | "plane">, clientX: number, clientY: number): MeasurementPoint {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((clientX-rect.left)/rect.width*2-1, 1-(clientY-rect.top)/rect.height*2);
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.viewer.camera);
    const middle = this.viewer.toLocal(dimensionPoints({ ...record, offset: [0,0,0] }).middle);
    const { normal } = measurementBasis(record.start, record.end, record.reference, record.plane);
    const point = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, middle), new THREE.Vector3());
    if (!point) return [0,0,0];
    return measurementOffset(record.start, record.end, this.viewer.toWorld(point).toArray() as MeasurementPoint, normal.toArray() as MeasurementPoint, record.reference);
  }
  private pick = (event: PointerEvent) => {
    const start = this.pointerDown; this.pointerDown = null;
    if (!this.state.active || event.button !== 0 || !start || Math.hypot(event.clientX-start.x,event.clientY-start.y)>5) return;
    event.preventDefault();
    if (this.state.target === "edge" || this.state.target === "face") { this.pickGeometry(event.clientX, event.clientY); return; }
    if (this.state.selectedId) this.select(null);
    if (this.pending?.end) {
      const offset = this.placementAt(event.clientX,event.clientY);
      const { start, end } = this.pending;
      const record = this.add(start,end,{ offset });
      if (this.state.mode === "chain") {
        if (!this.chain) this.chain = { id: record.id, start };
        record.chainId = this.chain.id;
        this.records[this.records.length-1].chainId = this.chain.id;
        this.records = this.records.filter(row => !(row.overall && row.chainId === this.chain!.id));
        const bays = this.records.filter(row => row.chainId === this.chain!.id);
        if (bays.length > 1) {
          const total = this.add(this.chain.start,end,{ offset: offset.map(value => value*1.4) as MeasurementPoint });
          const stored = this.records.find(row => row.id === total.id)!; stored.chainId = this.chain.id; stored.overall = true;
        }
        this.pending = { start: end }; this.emit({ step: "end" });
      } else { this.pending = null; this.emit({ step: "start" }); }
      this.previewRecord = null; this.paint(); return;
    }
    const point = this.pointAt(event.clientX,event.clientY);
    if (!point) return;
    if (!this.pending) { this.pending = { start: point }; this.emit({ step: "end" }); }
    else if (measurementValue(this.pending.start, point, this.state.reference).value > 1e-9) { this.pending.end = point; this.emit({ step: "place" }); }
    this.preview(point);
  };
  private move = (event: PointerEvent) => {
    if (!this.state.active || event.buttons) return;
    if (this.state.target === "edge" || this.state.target === "face") return;
    if (!this.pending) { this.pointAt(event.clientX,event.clientY); this.positionLabels(); return; }
    if (this.pending.end) this.preview(this.pending.end,this.placementAt(event.clientX,event.clientY));
    else { const point = this.pointAt(event.clientX,event.clientY); if (point) this.preview(point); }
  };
  private pickGeometry(clientX: number, clientY: number) {
    const hit = this.viewer.hitTest(clientX, clientY);
    if (!hit) return;
    const geometry = this.viewer.getElementGeometry(hit.element.id);
    if (!geometry) return;
    let face: ReturnType<typeof planarFace>;
    try { face = planarFace(geometry, hit.vertices); } finally { geometry.dispose(); }
    if (!face) { this.emit({ notice: "Choose a flat face with a closed outline." }); return; }
    if (this.state.target === "face" && face.boundary.some(edge => !edge.sharp)) { this.emit({ notice: "This surface is curved. Choose a flat face, or use Two points." }); return; }
    if (this.state.target === "face") {
      const center = this.viewer.toWorld(face.center);
      const existing = this.areas.find(row => new THREE.Vector3(...row.center).distanceTo(center) < 1e-6 && Math.abs(row.value - face.area) < 1e-6);
      if (existing) { this.select(existing.dimensionIds[0] ?? null); return; }
    }
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const project = (point: THREE.Vector3) => {
      const p = point.clone().project(this.viewer.camera);
      return new THREE.Vector2(rect.left + (p.x + 1) * rect.width / 2, rect.top + (1 - p.y) * rect.height / 2);
    };
    const edge = this.state.target === "edge" ? nearestFaceEdge(face, new THREE.Vector2(clientX, clientY), project) : null;
    if (this.state.target === "edge" && !edge) { this.emit({ notice: "Click closer to a model edge." }); return; }
    if (!edge && face.boundary.length > 64) { this.emit({ notice: "This face has more than 64 edges. Use Edge or Two points for a clear view." }); return; }
    const perimeter = face.boundary.reduce((sum, row) => sum + row.start.distanceTo(row.end), 0);
    const distance = Math.max(perimeter * .025, 1e-4);
    const plane = Math.abs(face.normal.z) > .99 ? "xy" : Math.abs(face.normal.y) > .99 ? "xz" : Math.abs(face.normal.x) > .99 ? "yz" : "auto";
    const occupied: { x: number; y: number; width: number; height: number }[] = [];
    if (!edge) {
      const center = project(face.center), width = `${face.area.toFixed(3)} m²`.length * 6.6;
      occupied.push({ x: center.x - width / 2, y: center.y - 10, width, height: 20 });
    }
    const dimensions = (edge ? [edge] : face.boundary).map(row => {
      const start = this.viewer.toWorld(row.start).toArray() as MeasurementPoint;
      const end = this.viewer.toWorld(row.end).toArray() as MeasurementPoint;
      let offset = row.outward.clone().multiplyScalar(distance);
      // Use separate outward lanes when projected label boxes overlap.
      for (let lane = 1; lane <= 12; lane++) {
        offset = row.outward.clone().multiplyScalar(distance * lane);
        const a = project(row.start.clone().add(offset)), b = project(row.end.clone().add(offset));
        const middle = a.clone().add(b).multiplyScalar(.5), length = `${row.start.distanceTo(row.end).toFixed(3)} m`.length * 6.6;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const width = Math.abs(Math.cos(angle)) * length + Math.abs(Math.sin(angle)) * 16;
        const height = Math.abs(Math.sin(angle)) * length + Math.abs(Math.cos(angle)) * 16;
        const box = { x: middle.x - width / 2, y: middle.y - height / 2, width, height };
        if (occupied.some(other => box.x < other.x + other.width + 8 && box.x + box.width + 8 > other.x && box.y < other.y + other.height + 8 && box.y + box.height + 8 > other.y) && lane < 12) continue;
        occupied.push(box); break;
      }
      return this.add(start, end, { reference: "length", plane, offset: offset.toArray() as MeasurementPoint }).id;
    });
    if (!edge) this.areas.push({ id: `${this.generation}:area:${++this.sequence}`, value: face.area, center: this.viewer.toWorld(face.center).toArray() as MeasurementPoint, dimensionIds: dimensions });
    this.emit({ notice: "" }); this.paint();
  }
  private preview(end: MeasurementPoint, offset: MeasurementPoint = [0,0,0]) {
    if (!this.pending) return;
    this.previewRecord = { id: "preview", start: this.pending.start, end, reference: this.state.reference, plane: this.state.plane, offset, ...measurementValue(this.pending.start,end,this.state.reference) };
    this.positionLabels();
  }
  private paint() { this.positionLabels(); }
  private positionLabels = () => {
    // Direct edits can run before the next render. Use the current camera pose.
    this.viewer.camera.updateMatrixWorld();
    this.labelHost.replaceChildren();
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const host = this.labelHost.getBoundingClientRect();
    this.labelHost.setAttribute("viewBox", `0 0 ${host.width} ${host.height}`);
    const make = (tag: string, attributes: Record<string, string | number>) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,String(value));
      return node;
    };
    const project = (point: THREE.Vector3) => {
      const p = this.viewer.toLocal(point).project(this.viewer.camera);
      return p.z >= -1 && p.z <= 1 ? { x: rect.left-host.left+(p.x+1)*rect.width/2, y: rect.top-host.top+(1-p.y)*rect.height/2 } : null;
    };
    const records = [...(this.state.visible ? this.records : []), ...(this.state.active && this.previewRecord ? [this.previewRecord] : [])];
    for (const record of records) {
      const points = dimensionPoints(record);
      const start = project(points.start), end = project(points.end), a = project(points.a), b = project(points.b);
      if (!start || !end || !a || !b) continue;
      const label = `${record.overall ? "Overall · " : ""}${record.reference === "length" ? "" : `Δ${record.reference.toUpperCase()} · `}${record.value.toFixed(3)} m`;
      const layout = dimensionLayout(a,b,label.length*6.6);
      if (!layout) continue;
      const selected = this.state.selectedId === record.id;
      const group = make("g", { "data-dimension": record.id, opacity: record.id === "preview" ? .6 : 1, fill: "#303034", stroke: "#303034", "stroke-width": selected ? 1.5 : .85 });
      if (record.id !== "preview") {
        group.setAttribute("role", "button"); group.setAttribute("tabindex", "0");
        group.setAttribute("aria-label", `Dimension ${label}`); group.setAttribute("aria-pressed", String(selected));
        group.style.cssText = "pointer-events:auto;cursor:grab;touch-action:none";
        group.addEventListener("pointerdown", event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); this.select(record.id); this.dragging = record.id; });
        group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.select(record.id); } });
        group.append(make("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "transparent", "stroke-width": 16 }));
      }
      for (const [from,to] of [[start,a],[end,b]]) {
        const line = dimensionWitness(from,to);
        if (line) group.append(make("line",line));
      }
      const [p,q,r,t] = layout.lines;
      group.append(make("path", { d: `M${p.x},${p.y} L${q.x},${q.y} M${r.x},${r.y} L${t.x},${t.y}`, fill: "none" }));
      for (const arrow of layout.arrows) group.append(make("polygon", { points: arrow.map(point=>`${point.x},${point.y}`).join(" "), "stroke-width": 0 }));
      const text = make("text", { x: layout.label.x, y: layout.label.y, transform: `rotate(${layout.angle} ${layout.label.x} ${layout.label.y})`, "text-anchor": "middle", "dominant-baseline": "central", "font-family": "'Geist Mono Variable',monospace", "font-size": 11, "paint-order": "stroke", stroke: "#fafafa", "stroke-width": 3, "stroke-linejoin": "round", class: "ifx-dimension-label" });
      text.textContent = label;
      group.append(text); this.labelHost.append(group);
    }
    if (this.state.visible) for (const area of this.areas) {
      const point = project(new THREE.Vector3(...area.center));
      if (!point) continue;
      const text = make("text", { x: point.x, y: point.y, "text-anchor": "middle", "font-family": "'Geist Mono Variable',monospace", "font-size": 11, fill: "#303034", stroke: "#fafafa", "stroke-width": 4, "paint-order": "stroke", "data-area": area.id });
      text.textContent = `${area.value.toFixed(3)} m²`; this.labelHost.append(text);
    }
    if (this.state.active) {
      const aids = [...(this.pending ? [this.pending.start, ...(this.pending.end ? [this.pending.end] : [])] : [])];
      for (const point of aids) {
        const p = project(new THREE.Vector3(...point));
        if (p) this.labelHost.append(make("circle", { cx:p.x,cy:p.y,r:4,fill:"white",stroke:"#303034","stroke-width":1.5 }));
      }
      if (this.hover && !this.pending?.end) {
        const p = project(new THREE.Vector3(...this.hover.point));
        if (p) {
          const snapped = this.hover.kind === "vertex";
          const marker = make("g", { "data-snap": this.hover.kind });
          marker.append(make("circle", { cx:p.x,cy:p.y,r:snapped?10:5,fill:"#ffffffa6",stroke:snapped?"#627bc0":"#737373","stroke-width":1.25 }));
          if (snapped) marker.append(make("circle", { cx:p.x,cy:p.y,r:2,fill:"#303034" }));
          this.labelHost.append(marker);
        }
      }
    }
  };
  dispose() {
    this.lifetime.abort(); this.resize.disconnect(); this.stopReady?.(); this.stopClear?.(); this.stopDispose?.();
    this.stopRender();
    this.snapper.clear(); this.labelHost.remove(); this.listeners.clear(); this.records=[];
  }
}
