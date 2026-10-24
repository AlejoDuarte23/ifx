import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SectionPlanes, sectionPlane, sectionRange, sectionFromPoints, VertexSnapper } from "../dist/index.js";

const bounds = new THREE.Box3(new THREE.Vector3(1000, 2000, -2), new THREE.Vector3(1020, 2040, 10));
test("section planes cut each model axis at a normalized position and reverse the retained half", () => {
  for (const normal of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
    const [min, max] = sectionRange(bounds, normal);
    for (const position of [0, 0.25, 0.5, 1]) {
      const plane = sectionPlane(bounds, normal, position);
      assert.ok(Math.abs(plane.constant + min + (max - min) * position) < 1e-9);
      assert.ok(plane.distanceToPoint(bounds.max) >= -1e-9);
      assert.ok(plane.distanceToPoint(bounds.min) <= 1e-9);
      const reverse = sectionPlane(bounds, normal, position, true);
      assert.ok(Math.abs(reverse.distanceToPoint(bounds.max) + plane.distanceToPoint(bounds.max)) < 1e-9);
    }
  }
});
test("rotated section ranges contain all eight corners and reject invalid inputs before mutation", () => {
  const normal = new THREE.Vector3(1, -2, 3).normalize(), [min, max] = sectionRange(bounds, normal);
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const distance = new THREE.Vector3(x, y, z).dot(normal);
    assert.ok(distance >= min - 1e-9 && distance <= max + 1e-9);
  }
  for (const position of [NaN, Infinity, -0.1, 1.1]) assert.throws(() => sectionPlane(bounds, normal, position));
  assert.throws(() => sectionPlane(bounds, new THREE.Vector3(), 0.5));
  assert.throws(() => sectionPlane(new THREE.Box3(), normal, 0.5));
});

class Canvas extends EventTarget {
  style = { cursor: "" };
  captures = new Set();
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture() {
  const events = new Map(), scene = new THREE.Scene(), canvas = new Canvas();
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 10000);
  camera.position.set(1060, 1940, 40); camera.lookAt(bounds.getCenter(new THREE.Vector3())); camera.updateMatrixWorld();
  let clips = [];
  const viewer = { scene, camera, renderer: { domElement: canvas }, controls: { enabled: true }, invalidate() {},
    getModelInfo: () => ({ local_bbox: [...bounds.min, ...bounds.max] }),
    toLocal: point => point.clone(), toWorld: point => point.clone(),
    isVisible: () => true, getElementGeometry: () => null, hitTest: () => null,
    setClippingPlanes(planes) { clips = planes.map(plane => plane.clone()); },
    on(type, callback) { events.set(type, callback); return () => events.delete(type); } };
  const sections = new SectionPlanes(viewer);
  return { sections, viewer, canvas, events, clips: () => clips };
}
test("section state survives helper visibility, resets on replacement, and releases resources", () => {
  const { sections, viewer, events, clips } = fixture();
  const updates = []; sections.subscribe(state => updates.push(state));
  sections.setAxis("z"); sections.setPosition(0.25); sections.rotate("x", 30);
  assert.ok(Math.abs(sections.state.normal[1] + 0.5) < 1e-9);
  const current = clips()[0].clone();
  sections.setVisible(false);
  assert.ok(clips()[0].equals(current));
  assert.equal(viewer.scene.children[0].visible, false);
  sections.flip(); assert.ok(clips()[0].normal.dot(current.normal) < -0.999);
  const before = structuredClone(sections.state);
  assert.throws(() => sections.setNormal([0, 0, 0]));
  assert.deepEqual(sections.state, before);
  sections.setVisible(true); events.get("ready")();
  assert.equal(clips().length, 0); assert.equal(sections.state.axis, null);
  sections.setAxis("x"); events.get("clear")(); assert.equal(clips().length, 0);
  sections.setAxis("y");
  const materials = [];
  viewer.scene.traverse(object => { if (object.material) materials.push(object.material); });
  let released = 0; for (const material of materials) material.addEventListener("dispose", () => released++);
  sections.dispose(); sections.dispose();
  assert.equal(released, new Set(materials).size);
  assert.equal(viewer.scene.children.length, 0); assert.equal(events.size, 0);
  assert.ok(updates.length > 5);
});
test("dragging a section handle blocks orbit and selection and cancellation restores controls", () => {
  const { sections, viewer, canvas } = fixture(); sections.setAxis("z");
  const handle = viewer.scene.children[0].children[0].children.find(object => object.userData.sectionAction === "move");
  viewer.scene.updateMatrixWorld(true);
  const point = handle.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
  const event = type => {
    const result = new Event(type, { cancelable: true });
    Object.assign(result, { button: 0, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 300, pointerId: 3 });
    return result;
  };
  const down = event("pointerdown"); canvas.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true); assert.equal(viewer.controls.enabled, false);
  const moved = event("pointermove"); Object.assign(moved, { clientY: moved.clientY - 30 });
  canvas.dispatchEvent(moved);
  assert.ok(Math.abs(sections.state.position - 0.5) > 0.001);
  canvas.dispatchEvent(event("pointercancel")); assert.equal(viewer.controls.enabled, true); assert.equal(canvas.captures.size, 0);
  canvas.dispatchEvent(event("pointerdown")); sections.clear(); assert.equal(viewer.controls.enabled, true);
  sections.dispose();
});

test("measurement snapping skips clipped corners of an otherwise visible element", () => {
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 1000);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const point = new THREE.Vector3(0.1, 0, 0);
  const viewer = { camera, renderer: { domElement: new Canvas() },
    hitTest: () => ({ element: { id: 1 }, point, distance: camera.position.distanceTo(point) }), isVisible: () => true,
    isPointVisible: point => point.x > 0.05, toWorld: point => point.clone(),
    getElementGeometry: () => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), point]) };
  const result = new VertexSnapper(viewer).at(400, 300);
  assert.equal(result.kind, "vertex"); assert.ok(result.point.distanceTo(point) < 1e-7);
});

test("rotation retains its pivot after translation and keeps a continuous full frame through 360 degrees", () => {
  const { sections, viewer, clips } = fixture(); sections.setAxis("z"); sections.setPosition(0.25);
  const group = viewer.scene.children[0], pivot = group.position.clone(), initial = group.quaternion.clone();
  for (let step = 0; step < 72; step++) {
    const previous = group.quaternion.clone(); sections.rotate("x", 5);
    assert.ok(group.position.distanceTo(pivot) < 1e-9);
    assert.ok(Math.abs(clips()[0].distanceToPoint(pivot)) < 1e-9);
    assert.ok(previous.angleTo(group.quaternion) <= THREE.MathUtils.degToRad(5.001));
  }
  assert.ok(initial.angleTo(group.quaternion) < 1e-6);
  sections.rotate("y", 20); sections.rotate("x", 35);
  assert.ok(group.position.distanceTo(pivot) < 1e-9);
  sections.dispose();
});
test("turning sectioning off retains the plane and turning it back on restores the same cut", () => {
  const { sections, viewer, clips, events } = fixture(); sections.setAxis("x"); sections.setPosition(0.35); sections.rotate("z", 15);
  const pose = viewer.scene.children[0].matrix.clone(), plane = clips()[0].clone(), state = structuredClone(sections.state);
  sections.setActive(false); assert.equal(clips().length, 0); assert.equal(sections.state.active, false); assert.equal(viewer.scene.children[0].visible, false);
  assert.equal(sections.state.axis, state.axis); assert.deepEqual(sections.state.normal, state.normal);
  sections.setActive(true); assert.ok(clips()[0].equals(plane)); assert.ok(viewer.scene.children[0].matrix.equals(pose));
  sections.clear(); assert.equal(sections.state.axis, null); assert.equal(sections.state.active, true);
  events.get("ready")(); assert.equal(sections.state.active, false);
  sections.dispose();
});
test("three noncollinear points define any plane; two points define only a vertical plane", () => {
  const points = [[1001, 2002, 1], [1005, 2002, 1], [1001, 2006, 3]];
  const result = sectionFromPoints(points), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(result.normal, result.center);
  for (const point of points) assert.ok(Math.abs(plane.distanceToPoint(new THREE.Vector3(...point))) < 1e-9);
  const vertical = sectionFromPoints(points.slice(0, 2), "vertical");
  assert.equal(vertical.normal.z, 0);
  const verticalPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(vertical.normal, vertical.center);
  assert.ok(Math.abs(verticalPlane.distanceToPoint(new THREE.Vector3(...points[0]).add(new THREE.Vector3(0, 0, 100)))) < 1e-9);
  assert.throws(() => sectionFromPoints([[0, 0, 0], [0, 0, 1]], "vertical"), /different X or Y/);
  assert.throws(() => sectionFromPoints([[0, 0, 0], [1, 1, 1], [2, 2, 2]]), /third point away/);
  assert.throws(() => sectionFromPoints([[0, 0, 0], [0, 0, 0], [1, 0, 0]]), /different second/);
  assert.throws(() => sectionFromPoints([[NaN, 0, 0], [1, 0, 0]], "vertical"), /finite/);
});
test("point picking retries a collinear third point and does not select geometry or change the camera", () => {
  const { sections, viewer, canvas, clips } = fixture();
  const camera = viewer.camera.matrixWorld.clone();
  const points = [[1001, 2001, 0], [1005, 2001, 0], [1008, 2001, 0], [1005, 2005, 2]];
  let current = 0;
  viewer.hitTest = () => ({ element: { id: 1 }, point: new THREE.Vector3(...points[current]), distance: 10 });
  const click = () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new Event(type, { cancelable: true }); Object.assign(event, { button: 0, clientX: 300, clientY: 200, pointerId: 1 });
      canvas.dispatchEvent(event); if (type === "pointerup") assert.equal(event.defaultPrevented, true);
    }
    current++;
  };
  sections.beginPick("three");
  canvas.dispatchEvent(new Event("pointerleave")); assert.equal(canvas.style.cursor, "crosshair");
  click(); click(); click();
  assert.equal(sections.state.picked, 2); assert.match(sections.state.notice, /third point away/); assert.equal(clips().length, 0);
  click(); assert.equal(sections.state.axis, "custom"); assert.equal(sections.state.picking, null); assert.equal(sections.state.picked, 0);
  for (const point of [points[0], points[1], points[3]]) assert.ok(Math.abs(clips()[0].distanceToPoint(new THREE.Vector3(...point))) < 1e-9);
  assert.ok(viewer.camera.matrixWorld.equals(camera));
  const previous = clips()[0].clone(); sections.beginPick("vertical"); assert.equal(clips().length, 0); sections.cancelPick(); assert.ok(clips()[0].equals(previous));
  sections.beginPick("three"); current = 0; click(); sections.setActive(false); assert.equal(sections.state.picked, 0); assert.equal(sections.state.picking, null);
  sections.dispose();
});
test("edge-on rotation follows small pointer moves without a half-turn jump and cancel restores the pose", () => {
  const { sections, viewer, canvas, clips } = fixture();
  const center = bounds.getCenter(new THREE.Vector3()); viewer.camera.position.copy(center).add(new THREE.Vector3(0, -0.01, 60));
  viewer.camera.lookAt(center); viewer.camera.updateMatrixWorld(); sections.setAxis("z"); sections.setPosition(0.3);
  const group = viewer.scene.children[0], pose = group.quaternion.clone(), pivot = group.position.clone(), plane = clips()[0].clone();
  const ring = group.children[0].children.find(object => object.geometry?.type === "TorusGeometry" && object.material.visible);
  const angle = ring.geometry.parameters.arc * 0.15, radius = ring.geometry.parameters.radius;
  const world = ring.localToWorld(new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), 0));
  const screen = world.clone().project(viewer.camera), x = (screen.x + 1) * 400, y = (1 - screen.y) * 300;
  const dispatch = (type, dx = 0, dy = 0) => {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { button: 0, clientX: x + dx, clientY: y + dy, pointerId: 4 }); canvas.dispatchEvent(event);
  };
  dispatch("pointerdown"); assert.equal(viewer.controls.enabled, false);
  dispatch("pointermove", 0, 2);
  const small = group.quaternion.angleTo(pose); assert.ok(small > 0.005 && small < 0.12, `small drag rotated ${small} radians`);
  dispatch("pointermove", 0, 20); assert.ok(group.quaternion.angleTo(pose) < 0.7);
  assert.ok(group.position.distanceTo(pivot) < 1e-9);
  dispatch("pointercancel"); assert.ok(group.quaternion.angleTo(pose) < 1e-6); assert.ok(clips()[0].equals(plane)); assert.equal(viewer.controls.enabled, true);
  sections.dispose();
});
