import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSupportedIfcSchema, detectIfcSchema } from '../dist/index.js';

const file = (schema) => new TextEncoder().encode(
  `ISO-10303-21;HEADER;FILE_SCHEMA(('${schema}'));ENDSEC;DATA;ENDSEC;END-ISO-10303-21;`,
);

test('detects supported IFC schemas', () => {
  assert.equal(detectIfcSchema(file('IFC4')), 'IFC4');
  assert.equal(assertSupportedIfcSchema(file('IFC4X3_ADD2')), 'IFC4X3');
});

test('supports the declared releases and rejects unknown releases', () => {
  for (const schema of ['IFC2X3', 'IFC2X3_TC1']) assert.equal(assertSupportedIfcSchema(file(schema)), 'IFC2X3');
  for (const schema of ['IFC4', 'IFC4_ADD2', 'IFC4_ADD2_TC1']) assert.equal(assertSupportedIfcSchema(file(schema)), 'IFC4');
  for (const schema of ['IFC4X3', 'IFC4X3_RC4', 'IFC4X3_ADD2']) assert.equal(assertSupportedIfcSchema(file(schema)), 'IFC4X3');
  for (const schema of ['IFC4X3_FAKE', 'IFC4_UNKNOWN', 'IFC2X3_UNKNOWN', 'IFC5'])
    assert.throws(() => assertSupportedIfcSchema(file(schema)), /does not declare/);
});

test('ignores schema text in descriptions and comments', () => {
  const source = new TextEncoder().encode(`HEADER;FILE_DESCRIPTION(('FILE_SCHEMA((''IFC4X3_FAKE'')); ENDSEC;'), '2;1'); /* FILE_SCHEMA(('IFC4')); */ FILE_SCHEMA(('IFC2X3'));ENDSEC;`);
  assert.equal(assertSupportedIfcSchema(source), 'IFC2X3');
  assert.equal(detectIfcSchema(new TextEncoder().encode("HEADER;FILE_SCHEMA(('IFC4','IFC2X3'));ENDSEC;")), null);
  assert.equal(detectIfcSchema(new TextEncoder().encode("HEADER;/* unfinished")), null);
});

test('rejects data without a supported schema declaration', () => {
  assert.throws(() => assertSupportedIfcSchema(new Uint8Array([1, 2, 3])), /does not declare/);
});
