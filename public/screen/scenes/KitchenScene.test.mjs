import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KitchenScene } from './KitchenScene.js';
import { PROPS } from '../../../shared/scene.js';

function fixture() {
  const scene = Object.create(KitchenScene.prototype);
  Object.assign(scene, { props: PROPS, effects: new Map(), nearby: new Set(), status: {}, zoom: .5, ox: 30, oy: 20 });
  return scene;
}
test('projection maps feet into the stage in CSS pixels with proportional height', () => {
  const scene=fixture();
  assert.deepEqual(scene.projectToScreen(0,0),{x:199,y:155});
  assert.deepEqual(scene.projectToScreen(1920,1080),{x:1159,y:695});
  assert.equal(scene.scaleAt(960,540,2.1),59.85);
  assert.equal(scene.scaleAt(NaN,540,2.1),0);
});
test('proximity triggers on entry, never changes participant state, allows re-entry', () => {
  const scene=fixture(), p=PROPS[0], calls=[];
  scene.activate=prop=>calls.push(prop.id);
  const a=Object.freeze({id:'test',x:p.x+p.r+20,y:p.y,mode:'ACTIVE'});
  scene.updateAgents([a]);scene.updateAgents([a]);
  assert.deepEqual(calls,[p.id]);
  scene.updateAgents([]);scene.updateAgents([a]);
  assert.deepEqual(calls,[p.id,p.id]);
});
test('offline and staged participants do not trigger kitchen actions', () => {
  const scene=fixture(), p=PROPS[0];
  scene.activate=()=>assert.fail('Unexpected activation');
  scene.updateAgents([{id:'offline',x:p.x,y:p.y,offline:true},{id:'photo',x:p.x,y:p.y,mode:'STAGED'}]);
  assert.equal(scene.nearby.size,0);
});
test('interaction cooldown and every shared prop has an explicit or fallback appearance', () => {
  const scene=fixture(), p=PROPS[0];
  scene.activate(p,1000);scene.activate(p,1200);
  assert.equal(scene.effects.get(p.id),1000);
  scene.activate(p,1900);assert.equal(scene.effects.get(p.id),1900);
  for(const prop of [...PROPS,{id:'future',type:'unknown'}]) assert.equal(scene.item(prop).length,3);
});
