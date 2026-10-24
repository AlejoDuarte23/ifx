import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {OverlayScenes, prepareModel} from '../dist/index.js';
test('named overlays retain app resources unless disposal is requested', () => {
  const scene = new THREE.Scene(); let renders=0;
  const overlays = new OverlayScenes(scene,()=>renders++);
  const group=overlays.addScene('excavation');
  assert.equal(overlays.addScene('excavation'),group);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
  let disposed=0; mesh.geometry.addEventListener('dispose',()=>disposed++);
  overlays.addMesh(mesh,'excavation'); overlays.setVisible('excavation',false);
  assert.equal(group.visible,false); assert.equal(mesh.parent,group);
  overlays.removeMesh(mesh,'excavation'); assert.equal(disposed,0); assert.equal(mesh.parent,null);
  overlays.addMesh(mesh,'excavation'); overlays.removeScene('excavation',true);
  assert.equal(disposed,1); assert.equal(scene.children.length,0); assert.equal(overlays.hasScene('excavation'),false);
  assert.ok(renders>0);
});
test('WASM geometry is localized once and source property units are kept',()=>{
  const model={schema:'IFC4',entity_count:1,length_unit_scale:.001,units:{by_type:{LENGTHUNIT:{symbol:'mm'}}},spatial:{},relationships:{edges:[]},materials:{},classifications:{},documents:{},groups:{},connections:{},georeferencing:{},openings:{}};
  const data={geometry:{elements:{7:{ifc_type:'IfcSlab',vertices:[[1000,2000,3],[1002,2000,3],[1000,2004,3]],faces:[[0,1,2]],color:[1,0,0,1]}}},entities:{entities:[{express_id:7,ifc_type:'IfcSlab',property_sets:[{name:'Pset',properties:[{name:'Length',value:'2000'}]}]}],units:{length_unit_scale:.001}},model};
  const prepared=prepareModel(data);
  assert.deepEqual(prepared.metadata.model.world_origin,[1001,2002,3]);
  assert.deepEqual([...prepared.sections.opaque_positions],[-1,-2,0,1,-2,0,-1,2,0]);
  assert.equal(prepared.metadata.elements[0].property_sets[0].properties[0].value,'2000');
  assert.equal(prepared.metadata.model.display_units.LENGTHUNIT,'mm');
});
test('viewer disposal releases shared resources once across nested overlays',()=>{
 const overlays=new OverlayScenes(new THREE.Scene(),()=>{});
 const parent=overlays.addScene('parent'),child=overlays.addScene('child'); parent.add(child);
 const geometry=new THREE.BoxGeometry(), material=new THREE.MeshBasicMaterial();let disposed=0;
 geometry.addEventListener('dispose',()=>disposed++);
 overlays.addMesh(new THREE.Mesh(geometry,material),'child'); overlays.addMesh(new THREE.Mesh(geometry,material),'parent');
 overlays.dispose(); assert.equal(disposed,1); assert.equal(overlays.hasScene('parent'),false); assert.equal(overlays.hasScene('child'),false);
});
