import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { ViewerRuntime } from "./runtime.js";
import type { Bounds } from "./types.js";

export type ConnectionGeometry = { id: number; geometry: THREE.BufferGeometry };
export type ConnectedVolume = { elementIds: number[]; bounds: Bounds };
export type ConnectionOptions = { tolerance?: number };
type Part = ConnectionGeometry & { bounds: THREE.Box3; tree: MeshBVH; closed?: boolean };
const identity = new THREE.Matrix4();

function gapSquared(a: THREE.Box3, b: THREE.Box3): number {
  return ["x", "y", "z"].reduce((sum, axis) => {
    const gap = Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
    return sum + gap * gap;
  }, 0);
}

function isClosed(part: Part): boolean {
  if (part.closed !== undefined) return part.closed;
  const points = part.geometry.getAttribute("position");
  const indices = part.geometry.index;
  const vertexIds = new Map<string, number>();
  const vertices = Array.from({ length: points.count }, (_, index) => {
    const key = `${points.getX(index)},${points.getY(index)},${points.getZ(index)}`;
    if (!vertexIds.has(key)) vertexIds.set(key, vertexIds.size);
    return vertexIds.get(key)!;
  });
  const edges = new Map<string, number>();
  for (let index = 0; index < (indices?.count ?? points.count); index += 3) {
    const ids = [0, 1, 2].map(offset => vertices[indices ? indices.getX(index + offset) : index + offset]);
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return part.closed = edges.size > 0 && [...edges.values()].every(count => count === 2);
}

function containsVertex(container: Part, other: Part): boolean {
  if (!isClosed(container)) return false;
  const vertices = other.geometry.getAttribute("position");
  const point = new THREE.Vector3();
  // Multiple directions avoid a decision based on a ray through a triangle edge.
  const directions = [[1, 0.371, 0.529], [0.233, 1, 0.617], [0.419, 0.277, 1]]
    .map(values => new THREE.Vector3(...values).normalize());
  for (let index = 0; index < vertices.count; index++) {
    point.fromBufferAttribute(vertices, index);
    if (!container.bounds.containsPoint(point)) continue;
    let inside = 0;
    for (const direction of directions) {
      const hits = container.tree.raycast(new THREE.Ray(point, direction), THREE.DoubleSide)
        .map(hit => hit.distance).sort((a, b) => a - b);
      const crossings = hits.filter((distance, i) => !i || distance - hits[i - 1] > 1e-7);
      inside += crossings.length % 2;
    }
    if (inside >= 2) return true;
  }
  return false;
}

// Bounds are only a broad phase. Triangle distance and closed-solid containment
// decide contact; intersecting bounds alone never join two parts.
export function findConnectedVolumes(
  sources: ConnectionGeometry[], { tolerance = 0.001 }: ConnectionOptions = {},
): ConnectedVolume[] {
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error("Use a finite, non-negative contact tolerance.");
  if (new Set(sources.map(source => source.id)).size !== sources.length)
    throw new Error("Each connection geometry needs a unique element ID.");
  const parts: Part[] = sources.filter(source => source.geometry.getAttribute("position")?.count >= 3)
    .map(source => {
      source.geometry.computeBoundingBox();
      return { ...source, bounds: source.geometry.boundingBox!.clone(),
        tree: new MeshBVH(source.geometry, { indirect: true }) };
    }).sort((a, b) => a.bounds.min.x - b.bounds.min.x || a.id - b.id);
  const parents = parts.map((_, index) => index);
  function root(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j];
      if (b.bounds.min.x > a.bounds.max.x + tolerance) break;
      if (root(i) === root(j) || gapSquared(a.bounds, b.bounds) > tolerance * tolerance) continue;
      const nearest = a.tree.closestPointToGeometry(b.geometry, identity, undefined, undefined,
        tolerance, tolerance + 1e-9);
      if ((nearest && nearest.distance <= tolerance + 1e-9)
        || containsVertex(a, b) || containsVertex(b, a)) parents[root(j)] = root(i);
    }
  }
  const groups = new Map<number, { elementIds: number[]; bounds: THREE.Box3 }>();
  parts.forEach((part, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, { elementIds: [], bounds: new THREE.Box3() });
    groups.get(key)!.elementIds.push(part.id);
    groups.get(key)!.bounds.union(part.bounds);
  });
  return [...groups.values()].map(group => ({
    elementIds: group.elementIds.sort((a, b) => a - b),
    bounds: [...group.bounds.min.toArray(), ...group.bounds.max.toArray()] as Bounds,
  })).sort((a, b) => a.elementIds[0] - b.elementIds[0]);
}

type ConnectionHost = Pick<ViewerRuntime,
  "getElementIds" | "getElementGeometry" | "overlays" | "invalidate" | "on">;

export class ConnectedVolumes {
  private groups: ConnectedVolume[] = [];
  private unsubscribers: (() => void)[];
  private disposed = false;
  readonly overlayName: string;
  constructor(private readonly viewer: ConnectionHost, name = "connected-volumes") {
    this.overlayName = name;
    if (viewer.overlays.hasScene(name)) throw new Error(`Overlay ${name} already exists.`);
    viewer.overlays.addScene(name).visible = false;
    this.unsubscribers = [viewer.on("ready", () => this.clear()),
      viewer.on("dispose", () => this.dispose())];
  }
  find(options: ConnectionOptions & { elementIds?: Iterable<number> } = {}): ConnectedVolume[] {
    if (this.disposed) throw new Error("The connected volume component has been disposed.");
    const sources: ConnectionGeometry[] = [];
    try {
      for (const id of new Set(options.elementIds ?? this.viewer.getElementIds())) {
        const geometry = this.viewer.getElementGeometry(id);
        if (geometry) sources.push({ id, geometry });
      }
      this.groups = findConnectedVolumes(sources, options);
      return this.groups.map(group => ({ elementIds: [...group.elementIds], bounds: [...group.bounds] }));
    } finally {
      for (const source of sources) source.geometry.dispose();
    }
  }
  connectedTo(id: number): number[] {
    return [...(this.groups.find(group => group.elementIds.includes(id))?.elementIds ?? [])];
  }
  show(groups: ConnectedVolume[] = this.groups): void {
    if (this.disposed) throw new Error("The connected volume component has been disposed.");
    this.viewer.overlays.clearScene(this.overlayName, true);
    const layer = this.viewer.overlays.addScene(this.overlayName);
    const colors = [0xffbe00, 0x36a4ba, 0xad74cf, 0xe77c55, 0x77b369, 0x6589d4];
    groups.forEach((group, index) => {
      for (const id of group.elementIds) {
        const geometry = this.viewer.getElementGeometry(id);
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
          color: colors[index % colors.length], transparent: true, opacity: 0.55,
          depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false,
        }));
        mesh.renderOrder = 4;
        mesh.userData.connectedVolume = index;
        mesh.userData.elementId = id;
        layer.add(mesh);
      }
    });
    this.setVisible(true);
  }
  setVisible(visible: boolean): void {
    this.viewer.overlays.setVisible(this.overlayName, visible);
  }
  clear(): void {
    this.groups = [];
    this.viewer.overlays.clearScene(this.overlayName, true);
    this.setVisible(false);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    this.viewer.overlays.removeScene(this.overlayName, true);
    this.groups = [];
  }
}
