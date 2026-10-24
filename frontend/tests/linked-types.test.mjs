import assert from "node:assert/strict";
import test from "node:test";
import { inspectLinkedTypes } from "../dist/index.js";

test("linked types retain source fields and share their definition", () => {
  const definition = { express_id: 20, ifc_type: "IfcDuctSegmentType", name: "SS1002", description: "Rectangular duct", global_id: "TypeA", attributes: [{ name: "PredefinedType", value: "RIGIDSEGMENT", value_type: "IFCENUM" }] };
  const store = { model: { object_types: { definitions: { 20: definition }, types_by_element: { 1: [20, 20], 2: [20], 3: [99] } } } };
  assert.deepEqual(inspectLinkedTypes(store, 1), [definition]);
  assert.equal(inspectLinkedTypes(store, 2)[0], definition);
  assert.deepEqual(inspectLinkedTypes(store, 3), []);
  assert.deepEqual(inspectLinkedTypes(store, 4), []);
  assert.deepEqual(inspectLinkedTypes({ model: {} }, 1), []);
});
