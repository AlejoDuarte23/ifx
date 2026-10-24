import * as THREE from "three";

export type FaceBoundary = { start: THREE.Vector3; end: THREE.Vector3; outward: THREE.Vector3; sharp: boolean };
export type MeasuredFace = { area: number; center: THREE.Vector3; normal: THREE.Vector3; boundary: FaceBoundary[] };

export function planarFace(geometry: THREE.BufferGeometry, hit: THREE.Vector3[]): MeasuredFace | null {
  if (hit.length !== 3) return null;
  const normal = new THREE.Triangle(...hit as [THREE.Vector3, THREE.Vector3, THREE.Vector3]).getNormal(new THREE.Vector3());
  if (!normal.lengthSq()) return null;
  geometry.computeBoundingBox();
  const tolerance = Math.max(1e-6, geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 1e-7);
  const positions = geometry.getAttribute("position"), index = geometry.index;
  const vertices = new Map<string, THREE.Vector3>();
  const key = (point: THREE.Vector3) => point.toArray().map(value => Math.round(value / tolerance)).join(":");
  const edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const wanted = hit.map(key).sort().join("|");
  const triangles: { ids: string[]; points: THREE.Vector3[]; edges: string[]; area: number }[] = [];
  const owners = new Map<string, number[]>();
  const allNormals = new Map<string, THREE.Vector3[]>();
  let seed = -1;
  for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
    const points = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(i + offset) : i + offset));
    const triangle = new THREE.Triangle(...points as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
    const n = triangle.getNormal(new THREE.Vector3()), area = triangle.getArea();
    if (area > tolerance * tolerance) for (let edge = 0; edge < 3; edge++) {
      const id = edgeKey(key(points[edge]), key(points[(edge + 1) % 3]));
      if (!allNormals.has(id)) allNormals.set(id, []);
      allNormals.get(id)!.push(n);
    }
    if (area <= tolerance * tolerance || Math.abs(n.dot(normal)) < 1 - 1e-6 || points.some(point => Math.abs(point.clone().sub(hit[0]).dot(normal)) > tolerance)) continue;
    if (n.dot(normal) < 0) [points[1], points[2]] = [points[2], points[1]];
    const ids = points.map(point => { const id = key(point); vertices.set(id, point); return id; });
    const edges = ids.map((id, offset) => edgeKey(id, ids[(offset + 1) % 3]));
    const at = triangles.length;
    if ([...ids].sort().join("|") === wanted) seed = at;
    triangles.push({ ids, points, edges, area });
    for (const edge of edges) { if (!owners.has(edge)) owners.set(edge, []); owners.get(edge)!.push(at); }
  }
  if (seed < 0) return null;
  const connected = new Set<number>([seed]), queue = [seed];
  for (let at = 0; at < queue.length; at++) for (const edge of triangles[queue[at]].edges) for (const neighbor of owners.get(edge)!) {
    if (!connected.has(neighbor)) { connected.add(neighbor); queue.push(neighbor); }
  }
  const next = new Map<string, string>(), center = new THREE.Vector3();
  let area = 0;
  for (const id of connected) {
    const triangle = triangles[id]; area += triangle.area;
    center.add(triangle.points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(triangle.area / 3));
    triangle.edges.forEach((edge, at) => {
      if (owners.get(edge)!.filter(owner => connected.has(owner)).length === 1) next.set(triangle.ids[at], triangle.ids[(at + 1) % 3]);
    });
  }
  if (!area || !next.size) return null;
  center.divideScalar(area);
  const boundary: FaceBoundary[] = [];
  while (next.size) {
    const first = next.keys().next().value!, loop: { point: THREE.Vector3; sharp: boolean }[] = [];
    let current = first;
    do {
      const to = next.get(current); if (!to) return null;
      const normals = allNormals.get(edgeKey(current, to))!;
      const sharp = normals.length === 1 || normals.some(other => Math.abs(other.dot(normal)) < Math.cos(Math.PI / 12));
      loop.push({ point: vertices.get(current)!, sharp }); next.delete(current); current = to;
    } while (current !== first && loop.length <= vertices.size);
    if (current !== first || loop.length < 3) return null;
    let changed = true;
    while (changed && loop.length > 3) {
      changed = false;
      for (let i = 0; i < loop.length; i++) {
        const previous = loop[(i + loop.length - 1) % loop.length];
        const a = loop[i].point.clone().sub(previous.point).normalize();
        const b = loop[(i + 1) % loop.length].point.clone().sub(loop[i].point).normalize();
        if (a.dot(b) > 1 - 1e-8 && previous.sharp === loop[i].sharp) { loop.splice(i, 1); changed = true; break; }
      }
    }
    for (let i = 0; i < loop.length; i++) {
      const start = loop[i].point, end = loop[(i + 1) % loop.length].point;
      boundary.push({ start, end, sharp: loop[i].sharp, outward: end.clone().sub(start).normalize().cross(normal).normalize() });
    }
  }
  return { area, center, normal, boundary };
}

export function nearestFaceEdge(face: MeasuredFace, pointer: THREE.Vector2, project: (point: THREE.Vector3) => THREE.Vector2, tolerance = 16) {
  let best: { edge: FaceBoundary; distance: number } | null = null;
  for (const edge of face.boundary) {
    if (!edge.sharp) continue;
    const start = project(edge.start), end = project(edge.end), delta = end.clone().sub(start);
    const t = Math.max(0, Math.min(1, pointer.clone().sub(start).dot(delta) / (delta.lengthSq() || 1)));
    const distance = start.addScaledVector(delta, t).distanceTo(pointer);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { edge, distance };
  }
  return best?.edge ?? null;
}
