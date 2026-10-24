import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractIfc, extractIfcStreaming, inspectLinkedTypes } from '../dist/index.js';
import init from '../dist/wasm/ifx_core.js';

await init({ module_or_path: readFileSync(new URL('../dist/wasm/ifx_core_bg.wasm', import.meta.url)) });
const source = new Uint8Array(readFileSync(new URL('./fixtures/ifc2x3-box.ifc', import.meta.url)));

test('IFC2X3 streams real geometry before final metadata and keeps its source schema', async () => {
  let finished = false;
  const batches = [];
  const streamed = await extractIfcStreaming(source, 'medium', batch => {
    assert.equal(finished, false);
    assert.ok(batch.total > 0);
    assert.ok(batch.processed > 0 && batch.processed <= batch.total);
    batches.push(batch);
  });
  finished = true;
  assert.equal(streamed.model.schema, 'IFC2X3');
  assert.ok(batches.some(batch => batch.geometry.element_count > 0));
  assert.ok(streamed.geometry.element_count > 0);
  const regular = await extractIfc(source, 'medium', { useWorker: false });
  assert.deepEqual(streamed.geometry, regular.geometry);
  assert.deepEqual(streamed.entities, regular.entities);
  assert.deepEqual(streamed.model, regular.model);
});

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) test(`${schema} streams a tilted surface extrusion in its source frame`, async () => {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${schema.toLowerCase()}-surface.ifc`, import.meta.url)));
  const data = await extractIfcStreaming(bytes, 'medium', () => {});
  const mesh = Object.values(data.geometry.elements)[0];
  assert.ok(mesh);
  const bounds = [0, 1, 2].map(axis => [Math.min(...mesh.vertices.map(p => p[axis])), Math.max(...mesh.vertices.map(p => p[axis]))]);
  assert.deepEqual(bounds, [[9, 11], [20, 24], [30, 30]]);
  let area = 0;
  for (const [a, b, c] of mesh.faces) {
    const u = mesh.vertices[b].map((v, i) => v - mesh.vertices[a][i]);
    const v = mesh.vertices[c].map((v, i) => v - mesh.vertices[a][i]);
    area += Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) / 2;
  }
  assert.equal(area, 8);
});

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) test(`${schema} retains linked type metadata in complete and streaming extraction`, async () => {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${schema.toLowerCase()}-linked-type.ifc`, import.meta.url)));
  const streamed = await extractIfcStreaming(bytes, 'medium', () => {});
  const regular = await extractIfc(bytes, 'medium', { useWorker: false });
  const duct = streamed.entities.entities.find(row => row.ifc_type === (schema === 'IFC2X3' ? 'IfcFlowSegment' : 'IfcDuctSegment'));
  const [type] = inspectLinkedTypes(streamed, duct.express_id);
  assert.equal(type.ifc_type, 'IfcDuctSegmentType');
  assert.equal(type.name, 'SS1002');
  assert.equal(type.description, 'Rectangular duct');
  assert.equal(type.attributes.find(value => value.name === 'PredefinedType').value, 'RIGIDSEGMENT');
  assert.deepEqual(regular.model.object_types, streamed.model.object_types);
  assert.equal(duct.property_sets.flatMap(set => set.properties).filter(value => value.name === 'TypeCode').length, 1);
});
