import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgStore } from '../server/store.js';
import { encodeCursor, parseArchiveQuery } from '../server/archive.js';

// SQL adapter tests use explicit pool doubles. They neither establish a real
// database connection nor claim PostgreSQL acceptance.
function poolDouble(respond = async () => ({ rows: [] })) {
  return { calls: [], on() {}, async query(sql, values) { this.calls.push({sql,values}); return respond(sql,values); }, async end() {} };
}
const created = new Date('2026-11-03T00:00:00.123Z');

test('store without connection configuration fails clearly without importing pg', async () => {
  const store = new PgStore();
  await assert.rejects(() => store.ready(), /Configure DATABASE_URL/);
  await store.close();
});

test('concurrent store initialization creates table and page index once', async () => {
  const pool=poolDouble(); const store=new PgStore(null,{pool});
  await Promise.all([store.ready(),store.ready(),store.ready()]);
  assert.equal(pool.calls.filter(c=>c.sql.includes('CREATE TABLE')).length,1);
  assert.equal(pool.calls.filter(c=>c.sql.includes('CREATE INDEX')).length,1);
  assert.equal(store.initialized,true);
});

test('store retries failed initialization rather than caching a rejected promise', async () => {
  let fail=true;
  const pool=poolDouble(async sql=>{ if (fail && sql.includes('CREATE TABLE')) throw new Error('temporary failure'); return {rows:[]}; });
  const store=new PgStore(null,{pool});
  await assert.rejects(()=>store.ready(),/temporary failure/); fail=false;
  await store.ready(); assert.equal(store.initialized,true);
});

test('archive query strips histories, uses bounded keyset pagination and exact timestamp cursor', async () => {
  const rows=Array.from({length:3},(_,i)=>({record:{id:`00000000-0000-4000-8000-00000000000${3-i}`,name:`Run ${i}`},created_at:created,cursor_time:`2026-11-03T00:00:00.12300${3-i}Z`}));
  const pool=poolDouble(async sql=>({rows:sql.startsWith('SELECT record -')?rows:[]}));
  const store=new PgStore(null,{pool});
  const before={createdAt:'2026-11-03T00:00:00.123009Z',id:randomUUID()};
  const page=await store.list({limit:2,before});
  const query=pool.calls.find(c=>c.sql.startsWith('SELECT record -'));
  assert.match(query.sql,/record - 'measurements' - 'interventions'/);
  assert.match(query.sql,/ORDER BY created_at DESC, id DESC LIMIT \$3/);
  assert.deepEqual(query.values,[before.createdAt,before.id,3]);
  assert.equal(page.experiments.length,2);
  assert.deepEqual(parseArchiveQuery({before:page.nextCursor}).before,{createdAt:rows[1].cursor_time,id:rows[1].record.id});
  assert.equal(page.nextCursor,encodeCursor({createdAt:rows[1].cursor_time,id:rows[1].record.id}));
});

test('save retry compares persisted contents without its server timestamp', async () => {
  const record={id:randomUUID(),name:'Fixture',settings:{foodRate:8}};
  const pool=poolDouble(async sql=>({rows:sql.startsWith('SELECT record,')?[{record,created_at:created}]:[]}));
  const store=new PgStore(null,{pool});
  const retry=await store.save(structuredClone(record));
  assert.equal(retry.duplicate,true); assert.equal(retry.experiment.createdAt,created.toISOString());
  const insert=pool.calls.find(c=>c.sql.startsWith('INSERT'));
  assert.deepEqual(insert.values,[record.id,record]);
  await assert.rejects(()=>store.save({...record,name:'Changed'}),error=>error.status===409);
});

test('delete uses a parameterized ID and reports whether exactly one record existed', async () => {
  const id=randomUUID(); let deleted=false;
  const pool=poolDouble(async sql=>sql.startsWith('DELETE ')?{rowCount:deleted?0:(deleted=true,1),rows:[]}:{rows:[]});
  const store=new PgStore(null,{pool});
  assert.equal(await store.delete(id),true);
  assert.equal(await store.delete(id),false);
  const calls=pool.calls.filter(call=>call.sql.startsWith('DELETE '));
  assert.equal(calls.length,2);
  for(const call of calls){assert.match(call.sql,/WHERE id=\$1/);assert.deepEqual(call.values,[id]);assert.ok(!call.sql.includes(id));}
});

test('delete propagates database failure without reporting success', async () => {
  const pool=poolDouble(async sql=>{if(sql.startsWith('DELETE '))throw Error('storage offline');return {rows:[]};});
  const store=new PgStore(null,{pool});
  await assert.rejects(()=>store.delete(randomUUID()),/storage offline/);
});
