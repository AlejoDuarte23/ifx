import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { planarFace, nearestFaceEdge, measurementBasis } from "../dist/index.js";

const triangle = geometry => [0, 1, 2].map(at => new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), geometry.index ? geometry.index.getX(at) : at));

test("a subdivided flat face has four boundary edges and no triangulation diagonal", () => {
  const geometry = new THREE.PlaneGeometry(4, 3, 4, 3);
  const face = planarFace(geometry, triangle(geometry));
  assert.ok(face); assert.ok(Math.abs(face.area - 12) < 1e-6); assert.equal(face.boundary.length, 4);
  const project = point => new THREE.Vector2(point.x * 100, point.y * 100);
  assert.equal(nearestFaceEdge(face, new THREE.Vector2(0, 0), project), null);
  assert.ok(nearestFaceEdge(face, new THREE.Vector2(195, 0), project));
  geometry.dispose();
});
test("face area excludes openings and retains their boundary dimensions", () => {
  const shape = new THREE.Shape().moveTo(0, 0).lineTo(4, 0).lineTo(4, 4).lineTo(0, 4).closePath();
  shape.holes.push(new THREE.Path().moveTo(1, 1).lineTo(1, 3).lineTo(3, 3).lineTo(3, 1).closePath());
  const geometry = new THREE.ShapeGeometry(shape), face = planarFace(geometry, triangle(geometry));
  assert.ok(face); assert.ok(Math.abs(face.area - 12) < 1e-6); assert.equal(face.boundary.length, 8);
  geometry.dispose();
});
test("coplanar disconnected islands do not change the clicked face area", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,2,0,0,0,2,0, 20,0,0,22,0,0,20,2,0], 3));
  const face = planarFace(geometry, triangle(geometry));
  assert.ok(face); assert.equal(face.area, 2); assert.equal(face.boundary.length, 3);
  geometry.dispose();
});
test("automatic IFC dimensions use stable plan and elevation placement planes", () => {
  const start = [1000, 2000, 0], end = [1003, 2004, 12];
  const plan = measurementBasis(start, end);
  assert.ok(Math.abs(plan.perpendicular.z) < 1e-12);
  const elevation = measurementBasis(start, end, "z");
  assert.ok(Math.abs(elevation.perpendicular.y) < 1e-12);
  assert.throws(() => measurementBasis(start, end, "z", "xy"), /contains/);
});
test("smooth tessellation seams are not offered as straight model edges", () => {
  const geometry = new THREE.CylinderGeometry(2, 2, 5, 128, 1, true);
  const face = planarFace(geometry, triangle(geometry));
  assert.ok(face); assert.ok(face.boundary.some(edge => !edge.sharp));
  geometry.dispose();
});
