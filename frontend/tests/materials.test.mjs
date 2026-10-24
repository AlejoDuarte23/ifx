import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { extractIfc, extractIfcStreaming, prepareModel, elementRanges } from '../dist/index.js';
import init from '../dist/wasm/ifx_core.js';
await init({ module_or_path: readFileSync(new URL('../dist/wasm/ifx_core_bg.wasm', import.meta.url)) });

for (const schema of ['ifc2x3', 'ifc4']) test(`${schema} retains opaque frames and glass in streaming and complete data`, async () => {
  const source = new Uint8Array(readFileSync(new URL(`./fixtures/${schema}-materials.ifc`, import.meta.url)));
  const streamed = [];
  const result = await extractIfcStreaming(source, 'medium', batch => streamed.push(batch.geometry));
  const regular = await extractIfc(source, 'medium', { useWorker: false });
  assert.deepEqual(result.geometry, regular.geometry);
  const geometry = Object.values(result.geometry.elements)[0];
  assert.equal(geometry.material_groups.length, 3);
  assert.equal(geometry.material_groups[2].color[3] < 0.13, true);
  const prepared = prepareModel(result);
  assert.equal(prepared.metadata.elements.length, 1);
  const ranges = elementRanges(prepared.metadata.elements[0]);
  assert.deepEqual(ranges.map(range => [range.batch, range.triangle_count]), [['opaque', 24], ['transparent', 12]]);
  assert.equal(ranges[0].materials.length, 2);
  const colors = prepared.sections.opaque_colors;
  assert.notDeepEqual([...colors.slice(0, 3)], [...colors.slice(-4, -1)]);
  assert.equal(prepared.sections.transparent_colors[3], 31);
  assert.ok(streamed.length > 0);
  const preview = prepareModel({ ...result, geometry: streamed[0] }, prepared.metadata.model.world_origin);
  assert.deepEqual([...preview.sections.transparent_colors], [...prepared.sections.transparent_colors]);
  assert.deepEqual([...preview.sections.opaque_colors], [...prepared.sections.opaque_colors]);
});
