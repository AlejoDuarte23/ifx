import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import * as THREE from "three";

const source = await readFile(new URL("../src/world-axes.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const moduleSource = code.replace('"three"', JSON.stringify(import.meta.resolve("three")));
const { axisLayout } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);

function orientation(position) {
  const camera = new THREE.PerspectiveCamera();
  camera.up.set(0, 0, 1);
  camera.position.fromArray(position);
  camera.lookAt(0, 0, 0);
  return camera.quaternion;
}

function screenLabels(layout) {
  return Object.fromEntries(layout.axes.map(axis => [axis.label, {
    x: axis.labelPoint.x + layout.origin.x,
    y: axis.labelPoint.y + layout.origin.y,
  }]));
}

function assertSpacingAndPadding(layout) {
  for (let i = 0; i < layout.axes.length; i++) {
    const axis = layout.axes[i];
    for (const other of layout.axes.slice(i + 1)) {
      const dx = Math.abs(axis.labelPoint.x - other.labelPoint.x);
      const dy = Math.abs(axis.labelPoint.y - other.labelPoint.y);
      assert.ok(dx >= 10 - 1e-6 || dy >= 14 - 1e-6, `${axis.label}/${other.label} labels overlap`);
    }
    const x = axis.labelPoint.x + layout.origin.x - 44;
    const y = axis.labelPoint.y + layout.origin.y - 44;
    assert.ok(Math.hypot(Math.abs(x) + 4, Math.abs(y) + 6) <= 40 + 1e-6, `${axis.label} leaves the disc`);
    for (const [px, py, padding] of [[axis.tip.x, axis.tip.y, 3], [-axis.x * 10, -axis.y * 10, 1]]) {
      assert.ok(Math.hypot(Math.abs(px + layout.origin.x - 44) + padding, Math.abs(py + layout.origin.y - 44) + padding) <= 41);
    }
  }
}

test("top, front and oblique axes keep their colors, arm lengths and clear label gaps", () => {
  for (const position of [[0, 0, 1], [0, -1, 0], [1, -1, 1], [1, -1, .1], [1, -1, 0], [0, 1, -1], [1, 0, -1]]) {
    const layout = axisLayout(orientation(position));
    assertSpacingAndPadding(layout);
    assert.deepEqual(Object.fromEntries(layout.axes.map(axis => [axis.label, axis.color])), { Y: "#42886a", Z: "#627bc0", X: "#b85c61" });
    for (const axis of layout.axes) {
      assert.ok(Math.abs(axis.tip.x - axis.x * 22) < 1e-10);
      assert.ok(Math.abs(axis.tip.y - axis.y * 22) < 1e-10);
    }
  }
  for (const axis of axisLayout(orientation([1, -1, 1])).axes) {
    assert.ok(Math.abs(Math.hypot(axis.labelPoint.x - axis.tip.x, axis.labelPoint.y - axis.tip.y) - 10) < .1);
  }
});

test("label boxes stay apart and inside the disc through an orientation sweep", () => {
  for (let azimuth = 0; azimuth < 360; azimuth += 5) {
    for (let elevation = -90; elevation <= 90; elevation += 5) {
      const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
      assertSpacingAndPadding(axisLayout(orientation([Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)])));
    }
  }
});

test("label placement stays smooth across the old .15 cutoff and a collapsed axis", () => {
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      for (let angle = 0; angle < 360; angle += 15) {
        const a = angle * Math.PI / 180;
        const layouts = [.1499, .1501].map(length => {
          const position = new THREE.Vector3().setComponent(axis, sign * Math.sqrt(1 - length * length));
          position.setComponent((axis + 1) % 3, length * Math.cos(a));
          position.setComponent((axis + 2) % 3, length * Math.sin(a));
          return axisLayout(orientation(position.toArray()));
        });
        const [before, after] = layouts.map(screenLabels);
        assert.ok(Math.hypot(layouts[0].origin.x - layouts[1].origin.x, layouts[0].origin.y - layouts[1].origin.y) < .2);
        for (const label of ["X", "Y", "Z"]) assert.ok(Math.hypot(before[label].x - after[label].x, before[label].y - after[label].y) < .2);
      }
    }
  }
  const aroundZero = [-.00001, 0, .00001].map(angle => screenLabels(axisLayout(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle))));
  for (const labels of aroundZero) {
    for (const label of ["X", "Y", "Z"]) assert.ok(Math.hypot(labels[label].x - aroundZero[1][label].x, labels[label].y - aroundZero[1][label].y) < .01);
  }
});

test("nearly aligned label pairs do not swap positions during a small orbit", () => {
  for (const [base, component] of [[[1, -1, 0], 2], [[1, 0, -1], 1], [[0, 1, -1], 0]]) {
    let previous;
    for (let step = -100; step <= 100; step++) {
      const position = [...base];
      position[component] = step * .00001;
      const layout = axisLayout(orientation(position));
      assertSpacingAndPadding(layout);
      const labels = screenLabels(layout);
      if (previous) {
        for (const label of ["X", "Y", "Z"]) assert.ok(Math.hypot(labels[label].x - previous[label].x, labels[label].y - previous[label].y) < .1);
      }
      previous = labels;
    }
  }
});
