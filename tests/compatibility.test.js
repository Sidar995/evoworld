import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExperiment } from '../server/validation.js';
import { withModelType,modelTypeOf } from '../server/records.js';
import { createSimulation,start,step,end,toExperiment } from '../public/simulation.js';
const legacy=()=>JSON.parse(readFileSync(new URL('./baseline-fixture.json',import.meta.url),'utf8'));

test('frozen baseline record retains its original schema, content and validation',()=>{
  const record=legacy(); const before=JSON.stringify(record);
  assert.equal(validateExperiment(record),null); assert.equal(modelTypeOf(record),'baseline');
  const view=withModelType(record);
  assert.equal(view.modelType,'baseline'); assert.deepEqual(view.measurements,record.measurements);
  assert.equal(Object.hasOwn(view.measurements[0],'carnivores'),false);
  assert.equal(JSON.stringify(record),before);
  assert.equal(validateExperiment({...record,modelType:'baseline'}),null);
});

test('baseline and food-chain records coexist without interpreting category data as legacy',()=>{
  const sim=createSimulation(); start(sim); for(let i=0;i<23;i++)step(sim); end(sim);
  const current=toExperiment(sim,{id:'00000000-0000-4000-8000-000000000043',name:'Food chain fixture',notes:''});
  assert.equal(validateExperiment(current),null); assert.equal(modelTypeOf(current),'food-chain');
  assert.equal(typeof validateExperiment({...current,modelType:'baseline'}),'string');
  assert.equal(typeof validateExperiment({...legacy(),modelType:'food-chain'}),'string');
  assert.equal(typeof validateExperiment({...current,modelType:'unknown'}),'string');
});

test('corrupt baseline settings remain rejected after engine replacement',()=>{
  const record=legacy(); record.settings.initialEnergy=1e100;
  assert.equal(typeof validateExperiment(record),'string');
});
