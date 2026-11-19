import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { SimulationClient } from '../public/simulation-client.js';
import { validateExperiment } from '../server/validation.js';
import { randomUUID } from 'node:crypto';

// Exercise the unchanged browser worker module in a real Node worker thread.
// Only the self/parentPort transport is adapted; this is not browser layout QA.
function transportFactory(workers) {
  return () => {
    const url=new URL('../public/simulation-worker.js',import.meta.url).href;
    const script=`const {parentPort}=require('node:worker_threads');
      const listeners=new Map(), pending=[];
      globalThis.self={postMessage:message=>parentPort.postMessage(message),addEventListener:(type,fn)=>listeners.set(type,fn)};
      parentPort.on('message',data=>{const fn=listeners.get('message');if(fn)fn({data});else pending.push(data);});
      import(${JSON.stringify(url)}).then(()=>{for(const data of pending)listeners.get('message')({data});}).catch(error=>{throw error;});`;
    const thread=new Worker(script,{eval:true});
    const adapter={onmessage:null,onerror:null,onmessageerror:null,postMessage:message=>thread.postMessage(message),terminate:()=>{adapter.termination=thread.terminate();}};
    thread.on('message',data=>adapter.onmessage?.({data}));
    thread.on('error',error=>adapter.onerror?.({message:error.message,preventDefault(){}}));
    workers.push(adapter);
    return adapter;
  };
}
async function waitUntil(predicate,timeout=3000) {
  const until=Date.now()+timeout;
  while(!predicate()) { if(Date.now()>until)throw new Error('Worker progress timed out'); await new Promise(resolve=>setTimeout(resolve,20)); }
}

test('real worker transport acknowledges controls, advances fixed ticks and exports a valid result',async t=>{
  const workers=[]; const client=new SimulationClient({workerFactory:transportFactory(workers),timeoutMs:3000});
  t.after(async()=>{client.terminate();await Promise.all(workers.map(worker=>worker.termination));});
  await client.initialize({seed:42,initialHerbivores:40,initialCarnivores:6,rainfall:'normal'});
  assert.equal(client.state.status,'ready');
  await client.command('start');
  await waitUntil(()=>client.state.tick>=4);
  await client.command('pause'); const tick=client.state.tick;
  await new Promise(resolve=>setTimeout(resolve,80)); assert.equal(client.state.tick,tick);
  await client.command('rainfall',{value:'dry'});
  assert.equal(client.state.pendingEvents.length,1);
  await client.command('resume'); await waitUntil(()=>client.state.tick>tick);
  await client.command('end');
  const record=client.exportExperiment({id:randomUUID(),name:'Real transport fixture',notes:''});
  assert.equal(validateExperiment(record),null);
  assert.equal(record.interventions.at(-1).rainfall,'dry');
  await client.reset({seed:42});
  assert.equal(workers.length,2); assert.equal(client.state.tick,0); assert.equal(client.state.status,'ready');
});
