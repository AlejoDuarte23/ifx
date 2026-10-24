import * as THREE from "three";
export type MeasurementPoint = [number, number, number];
export type MeasurementReference = "length" | "x" | "y" | "z";
export type MeasurementPlane = "auto" | "xy" | "xz" | "yz";
export type MeasurementMode = "single" | "chain";
export type MeasurementOptions = { reference?: MeasurementReference; plane?: MeasurementPlane; offset?: MeasurementPoint };
export type MeasurementRecord = { id: string; start: MeasurementPoint; end: MeasurementPoint; reference: MeasurementReference; plane: MeasurementPlane; offset: MeasurementPoint; value: number; delta: MeasurementPoint; chainId?: string; overall?: boolean };
export function measurementBasis(start: MeasurementPoint, end: MeasurementPoint, reference: MeasurementReference = "length", plane: MeasurementPlane = "auto") {
  if (plane !== "auto" && reference !== "length" && !plane.includes(reference)) throw new Error("Choose a placement plane that contains the measurement axis.");
  const { a, b } = dimensionPoints({ start, end, reference, offset: [0, 0, 0] });
  const direction = b.sub(a).normalize();
  const normal = plane === "xz" || (plane === "auto" && reference === "z") ? new THREE.Vector3(0, 1, 0)
    : plane === "yz" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const perpendicular = direction.clone().cross(normal).normalize();
  if (perpendicular.lengthSq() < 1e-12) perpendicular.copy(direction).cross(new THREE.Vector3(1, 0, 0)).normalize();
  if (perpendicular.lengthSq() < 1e-12) perpendicular.copy(direction).cross(new THREE.Vector3(0, 1, 0)).normalize();
  return { direction, perpendicular, normal: direction.clone().cross(perpendicular).normalize() };
}
export function measurementValue(start: MeasurementPoint, end: MeasurementPoint, reference: MeasurementReference = "length") {
  if (![...start, ...end].every(Number.isFinite)) throw new Error("Measurement points must contain finite coordinates in metres.");
  const delta = end.map((value, index) => value - start[index]) as MeasurementPoint;
  return { delta, value: reference === "length" ? Math.hypot(...delta) : Math.abs(delta[{ x: 0, y: 1, z: 2 }[reference]]) };
}
export function dimensionPoints(record: Pick<MeasurementRecord, "start" | "end" | "offset" | "reference">) {
  const start = new THREE.Vector3(...record.start), end = new THREE.Vector3(...record.end);
  const a = start.clone().add(new THREE.Vector3(...record.offset));
  const b = end.clone().add(new THREE.Vector3(...record.offset));
  if (record.reference !== "length") {
    const index = { x: 0, y: 1, z: 2 }[record.reference];
    for (let axis = 0; axis < 3; axis++) if (axis !== index) b.setComponent(axis, a.getComponent(axis));
  }
  return { start, end, a, b, middle: a.clone().add(b).multiplyScalar(.5) };
}

export function measurementOffset(start: MeasurementPoint, end: MeasurementPoint, point: MeasurementPoint, normal: MeasurementPoint, reference: MeasurementReference = "length"): MeasurementPoint {
  const points = dimensionPoints({ start, end, offset: [0, 0, 0], reference });
  const planeNormal = new THREE.Vector3(...normal).normalize();
  const direction = points.b.clone().sub(points.a).normalize();
  const offset = new THREE.Vector3(...point).sub(points.middle);
  const perpendicular = planeNormal.clone().cross(direction);
  if (perpendicular.lengthSq() < 1e-12) offset.addScaledVector(planeNormal, -offset.dot(planeNormal));
  else { perpendicular.normalize(); offset.copy(perpendicular.multiplyScalar(offset.dot(perpendicular))); }
  return offset.toArray() as MeasurementPoint;
}
