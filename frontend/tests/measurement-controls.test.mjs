import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { axisProjection, measurementValue, dimensionPoints, measurementOffset, Measurements, dimensionLayout, dimensionWitness } from "../dist/index.js";

test("measurement values use world metres, axis projections and IFC Z elevation", () => {
  assert.equal(measurementValue([1000,2000,3],[1003,2004,15]).value,13);
  assert.equal(measurementValue([1000,2000,3],[1003,2004,15],"z").value,12);
  assert.equal(measurementValue([0,0,0],[3,4,12],"x").value,3);
  assert.throws(() => measurementValue([NaN,0,0],[0,0,0]));
  const points=dimensionPoints({start:[0,0,0],end:[3,4,12],offset:[0,1,0],reference:"z"});
  assert.deepEqual(points.a.toArray(),[0,1,0]);assert.deepEqual(points.b.toArray(),[0,1,12]);
});
test("world axes follow the camera and keep Spectral colors", () => {
  const projection = axisProjection(new THREE.Quaternion());
  assert.deepEqual(projection.map(axis=>axis.label).sort(),["X","Y","Z"]);
  assert.equal(projection.find(axis=>axis.label==="Z").depth,1);
  assert.equal(projection.find(axis=>axis.label==="X").color,"#b85c61");
  assert.equal(projection.find(axis=>axis.label==="Y").color,"#42886a");
  assert.equal(projection.find(axis=>axis.label==="Z").color,"#627bc0");
});
class Element extends EventTarget {
  style={};children=[];hidden=false;parent=null;attributes={};
  setAttribute(name,value){this.attributes[name]=value;}
  append(child){this.children.push(child);child.parent=this;}
  replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  getBoundingClientRect(){return {left:0,top:0,width:800,height:600};}
}
test("measurement records and SVG marks clear on model replacement and dispose", () => {
  const previous={document:globalThis.document,window:globalThis.window,ResizeObserver:globalThis.ResizeObserver};
  globalThis.document={createElement:()=>new Element(),createElementNS:()=>new Element()};globalThis.window=new EventTarget();globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  try {
    const scene=new THREE.Scene(),host=new Element(),controls=new EventTarget(),events=new Map();
    const camera=new THREE.PerspectiveCamera(50,800/600,.01,1000);camera.position.set(10,-10,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();

    const viewer={renderer:{domElement:new Element()},camera,controls,toLocal:p=>p.clone().sub(new THREE.Vector3(1000,2000,0)),toWorld:p=>p.clone().add(new THREE.Vector3(1000,2000,0)),isVisible(){return true;},getElementGeometry(){return null;},hitTest(x,y){return {element:{id:1},point:new THREE.Vector3(x,y,0),vertices:[]};},on(type,callback){events.set(type,callback);return()=>events.delete(type);}};
    const measurements=new Measurements(viewer,host);
    assert.throws(()=>measurements.add([1000,2000,0],[1000,2004,0],{reference:"x"}),/different coordinates/);
    const record=measurements.add([1000,2000,0],[1003,2004,0]);
    assert.equal(record.value,5);assert.equal(measurements.list().length,1);assert.equal(host.children[0].children.length,1);
    measurements.setActive(true);measurements.setActive(false);assert.equal(measurements.list().length,1);
    measurements.setVisible(false);assert.equal(host.children[0].children.length,0);
    events.get("ready")();assert.equal(measurements.list().length,0);assert.equal(host.children[0].children.length,0);
    const next=measurements.add([1000,2000,0],[1001,2000,0]);assert.notEqual(next.id,record.id);
    events.get("clear")();assert.equal(measurements.list().length,0);assert.equal(measurements.state.active,false);
    const click=(x,y)=>{for(const type of ["pointerdown","pointerup"]){const event=new Event(type,{cancelable:true});Object.assign(event,{button:0,clientX:x,clientY:y});viewer.renderer.domElement.dispatchEvent(event);}};
    measurements.setMode("chain");measurements.setActive(true);
    click(0,0);click(3,0);click(3,4);click(6,0);click(6,4);
    const chain=measurements.list();assert.equal(chain.length,3);assert.equal(chain.filter(row=>row.overall).length,1);assert.equal(chain.find(row=>row.overall).value,6);
    assert.equal(new Set(chain.map(row=>row.chainId)).size,1);
    measurements.cancelPending();click(20,0);click(23,0);click(23,4);
    assert.equal(measurements.list().filter(row=>row.overall).length,1);
    assert.notEqual(measurements.list().at(-1).chainId,chain[0].chainId);
    measurements.dispose();assert.equal(host.children.length,0);assert.equal(events.size,0);
  } finally {Object.assign(globalThis,previous);}
});

test("dimension placement remains on the chosen plane and perpendicular to the measured reference", () => {
  const start=[1000,2000,0],end=[1003,2004,12];
  const axis=measurementOffset(start,end,[1004,2005,0],[0,0,1],"x");
  assert.deepEqual(axis,[0,5,0]);
  const normal=new THREE.Vector3(0,1,0),direction=new THREE.Vector3(3,4,12);
  const aligned=new THREE.Vector3(...measurementOffset(start,end,[1008,2002,15],normal.toArray()));
  assert.ok(Math.abs(aligned.dot(normal))<1e-9);
  assert.ok(Math.abs(aligned.dot(direction))<1e-9);
  const parallel=measurementOffset(start,end,[1005,2006,6],[0,0,1],"z");
  assert.deepEqual(parallel,[5,6,0]);
});

test("dimensions use the rendered camera after orbit, pan, zoom and resize", () => {
  const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = { createElementNS: () => new Element() };
  globalThis.window = new EventTarget();
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  let measurements;
  try {
    const events = new Map(), host = new Element(), canvas = new Element();
    let width = 800, height = 600;
    host.getBoundingClientRect = canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    const camera = new THREE.PerspectiveCamera(50, width / height, .01, 1000);
    camera.position.set(10, -10, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const origin = new THREE.Vector3(1000, 2000, 0);
    const viewer = { camera, controls: new EventTarget(), renderer: { domElement: canvas }, toLocal: p => p.clone().sub(origin), on(type, callback) { events.set(type, callback); return () => events.delete(type); } };
    measurements = new Measurements(viewer, host);
    const record = measurements.add([1000, 2000, 0], [1003, 2004, 0], { offset: [0, 0, 1] });
    const check = () => {
      const expectedCamera = camera.clone(); expectedCamera.updateMatrixWorld();
      const point = viewer.toLocal(dimensionPoints(record).a).project(expectedCamera);
      const line = host.children[0].children[0].children[0].attributes;
      assert.ok(Math.abs(Number(line.x1) - (point.x + 1) * width / 2) < 1e-6);
      assert.ok(Math.abs(Number(line.y1) - (1 - point.y) * height / 2) < 1e-6);
      assert.deepEqual(measurements.list()[0], record);
    };
    for (const [position, target, size] of [
      [[14, -6, 8], [0, 0, 0], [800, 600]],
      [[16, -3, 8], [2, 3, 0], [800, 600]],
      [[8, -3, 4], [0, 0, 0], [800, 600]],
      [[8, -3, 4], [0, 0, 0], [520, 740]],
    ]) {
      camera.position.fromArray(position); camera.lookAt(...target);
      [width, height] = size; camera.aspect = width / height; camera.updateProjectionMatrix();
      viewer.controls.dispatchEvent(new Event("change"));
      camera.updateMatrixWorld();
      assert.equal(typeof events.get("render"), "function");
      events.get("render")(); check();
    }
    camera.position.set(9, -4, 7); camera.lookAt(0, 0, 0);
    measurements.select(record.id); check();
  } finally { measurements?.dispose(); Object.assign(globalThis, previous); }
});
