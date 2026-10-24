import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenProperties, propertySearchValues, inspectMaterialProperties } from '../dist/index.js';

const list = { name: 'Lengths', value: '200, 450', value_type: 'IfcPropertyListValue', details: { kind: 'list', values: [{ value: '200', value_type: 'IfcLengthMeasure' }, { value: '450', value_type: 'IfcLengthMeasure' }] } };

test('complex property paths and list members remain searchable', () => {
  const properties = flattenProperties([{ name: 'Dimensions', value: 'Lengths: 200, 450', value_type: 'IfcComplexProperty', details: { kind: 'complex', usage_name: null, properties: [list] } }]);
  assert.deepEqual(properties.map(p => p.name), ['Dimensions', 'Dimensions.Lengths']);
  assert.deepEqual(propertySearchValues(properties[1]), ['200, 450', '200', '450']);
});

test('material and profile sets resolve through layers, profiles and direct materials once', () => {
  const materialSet = { express_id: 10, resource_kind: 'material', properties: [] };
  const profileSet = { express_id: 11, resource_kind: 'profile', properties: [] };
  const store = { model: { materials: {
    element_materials: { 1: [
      { material: { material_type: 'Material', resolved_definition_id: 20 } },
      { material: { layers: [{ material_id: 20 }], profiles: [{ material_id: 20, profile_id: 30 }] } },
    ] },
    properties_by_material: { 20: [10] }, properties_by_profile: { 30: [11] }, property_sets: { 10: materialSet, 11: profileSet },
  } } };
  assert.deepEqual(inspectMaterialProperties(store, 1), [materialSet, profileSet]);
  assert.deepEqual(inspectMaterialProperties(store, 2), []);
});

test('recursive complex values cannot exceed the reader depth limit', () => {
  const p = { name: 'Loop', value: '', value_type: 'IfcComplexProperty', details: { kind: 'complex', usage_name: null, properties: [] } };
  p.details.properties.push(p);
  assert.equal(flattenProperties([p]).length, 16);
});

import { readFileSync } from 'node:fs';
import { extractIfc, extractIfcStreaming } from '../dist/index.js';
import init from '../dist/wasm/ifx_core.js';
await init({ module_or_path: readFileSync(new URL('../dist/wasm/ifx_core_bg.wasm', import.meta.url)) });

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) test(`${schema} keeps all property forms, material sets and coverage through WASM streaming`, async () => {
  const source = new Uint8Array(readFileSync(new URL(`./fixtures/${schema.toLowerCase()}-properties.ifc`, import.meta.url)));
  const result = await extractIfcStreaming(source, 'medium', () => {});
  const wall = result.entities.entities.find(e => e.ifc_type === 'IfcWall');
  assert.ok(wall);
  const properties = flattenProperties(wall.property_sets.flatMap(s => s.properties));
  for (const kind of ['enumerated', 'list', 'bounded', 'table', 'reference', 'complex']) assert.ok(properties.some(p => p.details?.kind === kind), kind);
  assert.ok(properties.some(p => p.name === 'Dimensions.Height' && p.value === '4'));
  assert.ok(properties.some(p => p.name === 'Wrapped identifier' && p.value === 'line break'));
  assert.ok(properties.every(p => !p.issue));
  assert.ok(inspectMaterialProperties(result, wall.express_id).some(s => s.name === 'Material stiffness'));
  const coverage = result.model.coverage;
  assert.equal(coverage.scan_complete, true);
  assert.equal(coverage.unknown_records, 0);
  assert.equal(coverage.extraction.mesh_elements, 1);
  assert.equal(coverage.extraction.unmeshed_represented_products.count, 0);
  const regular = await extractIfc(source, 'medium', { useWorker: false });
  assert.deepEqual(result.entities, regular.entities);
  assert.deepEqual(result.model, regular.model);
});
