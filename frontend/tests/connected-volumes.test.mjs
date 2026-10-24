import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {findConnectedVolumes, ConnectedVolumes, OverlayScenes} from '../dist/index.js';

const box = (id, x = 0, y = 0, z = 0, size = 1) =>
  ({id, geometry:new THREE.BoxGeometry(size,size,size).translate(x,y,z)});
const groups = sources => findConnectedVolumes(sources).map(group => group.elementIds);

test('touching slabs and pedestals join through transitive mesh contacts', () => {
  assert.deepEqual(groups([box(1), box(2,1), box(3,2), box(4,5), box(5,0,0,1)]), [[1,2,3,5],[4]]);
});
test('overlapping bounds do not join separated rotated solids', () => {
  const a = {id:1, geometry:new THREE.BoxGeometry(4,.1,1).rotateZ(Math.PI/4)};
  const b = {id:2, geometry:new THREE.BoxGeometry(4,.1,1).rotateZ(Math.PI/4).translate(.3,-.3,0)};
  assert.deepEqual(groups([a,b]), [[1],[2]]);
});
test('a solid inside a courtyard stays separate from its surrounding walls', () => {
  const outline = new THREE.Shape();
  outline.moveTo(0,0); outline.lineTo(6,0); outline.lineTo(6,6); outline.lineTo(0,6); outline.closePath();
  const hole = new THREE.Path();
  hole.moveTo(1,1); hole.lineTo(1,5); hole.lineTo(5,5); hole.lineTo(5,1); hole.closePath();
  outline.holes.push(hole);
  const ring = {id:1, geometry:new THREE.ExtrudeGeometry(outline,{depth:1,bevelEnabled:false}).translate(0,0,-.5)};
  assert.deepEqual(groups([ring,box(2,3,3)]), [[1],[2]]);
});
test('solid containment joins without a surface intersection', () => {
  assert.deepEqual(groups([box(1,0,0,0,5),box(2)]), [[1,2]]);
});
test('contact tolerance includes small mesh gaps and excludes larger gaps', () => {
  assert.deepEqual(groups([box(1),box(2,1.0005),box(3,2.003)]), [[1,2],[3]]);
  assert.deepEqual(findConnectedVolumes([box(1),box(2,1.0005)],{tolerance:0}).map(g=>g.elementIds), [[1],[2]]);
  assert.throws(()=>findConnectedVolumes([],{tolerance:-1}), /tolerance/);
});
test('connected overlays release their meshes and keep model materials untouched', () => {
  const sources = new Map([[1,box(1).geometry],[2,box(2,1).geometry]]);
  const events = new Map();
  const overlays = new OverlayScenes(new THREE.Scene(),()=>{});
  const host = {overlays, invalidate:()=>{}, getElementIds:()=>[1,2],
    getElementGeometry:id=>sources.get(id).clone(),
    on:(name,callback)=>{events.set(name,callback); return ()=>events.delete(name);}};
  const component = new ConnectedVolumes(host);
  const found = component.find();
  assert.deepEqual(component.connectedTo(2),[1,2]);
  component.show(found);
  assert.equal(overlays.addScene(component.overlayName).children.length,2);
  component.setVisible(false);
  assert.equal(overlays.addScene(component.overlayName).visible,false);
  component.dispose(); component.dispose();
  assert.equal(overlays.hasScene(component.overlayName),false);
  assert.equal(events.size,0);
  assert.equal(sources.get(1).attributes.position.count,24);
});
