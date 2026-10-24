import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { cursorZoom, modelClipping, wheelZoomScale, dimensionLayout, dimensionWitness, VertexSnapper } from "../dist/index.js";

test("cursor zoom reaches central and off-centre surfaces without stopping at the old orbit target", () => {
  for (const surface of [[0,0,0],[-4,2,0],[6,1,0],[200,100,0]]) {
    let position=[0,-10,8];
    const forward=new THREE.Vector3(0,10,-8).normalize().toArray();
    const direction=new THREE.Vector3(...surface).sub(new THREE.Vector3(...position)).normalize().toArray();
    for(let i=0;i<20;i++){
      const distance=Math.hypot(...surface.map((v,j)=>v-position[j]));
      const moved=cursorZoom(position,forward,direction,distance,.5);
      assert.ok(moved);
      const aim=new THREE.Vector3(...moved.target).sub(new THREE.Vector3(...moved.position)).normalize();
      assert.ok(aim.distanceTo(new THREE.Vector3(...forward))<1e-8);
      position=moved.position;
    }
    assert.ok(Math.hypot(...surface.map((v,j)=>v-position[j]))<.001);
  }
  assert.equal(cursorZoom([0,0,0],[0,0,-1],[0,0,1],1,.5),null);
  assert.equal(cursorZoom([NaN,0,0],[0,0,-1],[0,0,-1],1,.5),null);
  assert.ok(Number.isFinite(wheelZoomScale(1e9)));
});
test("close clipping permits detail and far clipping includes off-centre model corners", () => {
  const bounds=[-2000,-2000,-2000,2000,2000,2000];
  const position=[2000,0,.0001],target=[2000,0,0];
  const clip=modelClipping(position,target,bounds);
  assert.ok(clip.near<.0001);
  for(const x of [-2000,2000])for(const y of [-2000,2000])for(const z of [-2000,2000])assert.ok(Math.hypot(x-position[0],y-position[1],z-position[2])<=clip.far);
});
test("drafting marks keep readable text, a line gap, arrows and separated witness lines", () => {
  const forward=dimensionLayout({x:0,y:0},{x:200,y:200},60);
  const reverse=dimensionLayout({x:200,y:200},{x:0,y:0},60);
  assert.equal(forward.angle,45);assert.equal(reverse.angle,45);
  assert.equal(forward.arrows.length,2);
  assert.ok(forward.lines[1].x<100&&forward.lines[2].x>100);
  assert.deepEqual(dimensionWitness({x:0,y:0},{x:0,y:30}),{x1:0,y1:4,x2:0,y2:35});
});
test("corner snapping uses the whole nearby element and rejects hidden or occluded vertices", () => {
  const camera=new THREE.PerspectiveCamera(45,1,.01,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  let visible=true,occluded=false,disposed=0;
  const viewer={camera,renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:800,height:800})}},toWorld:p=>p.clone().add(new THREE.Vector3(1000,0,0)),isVisible:()=>visible,hitTest:()=>({element:{id:1},point:new THREE.Vector3(1,1,0),distance:occluded?2:10,vertices:[new THREE.Vector3(1,1,0)]}),getElementGeometry(){const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(3,3,0)]);g.addEventListener("dispose",()=>disposed++);return g;}};
  const snapper=new VertexSnapper(viewer);
  assert.equal(snapper.at(405,400).kind,"vertex");assert.deepEqual(snapper.at(405,400).point.toArray(),[1000,0,0]);assert.equal(disposed,1);
  visible=false;assert.equal(snapper.at(405,400).kind,"surface");visible=true;occluded=true;assert.equal(snapper.at(405,400).kind,"surface");
});
