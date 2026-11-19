import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, parseArchiveQuery, summarizeExperiment } from '../server/archive.js';

const id = '00000000-0000-4000-8000-000000000025';
const cursor = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const rejects400 = query => assert.throws(() => parseArchiveQuery(query), error => error.status === 400);

test('archive parser defaults to twenty summaries and accepts limit endpoints', () => {
  assert.deepEqual(parseArchiveQuery(), { limit: 20, before: null });
  assert.deepEqual(parseArchiveQuery({ limit: '1' }), { limit: 1, before: null });
  assert.deepEqual(parseArchiveQuery({ limit: '50' }), { limit: 50, before: null });
});
test('archive parser rejects invalid, repeated, and non-scalar limits', () => {
  for (const limit of ['0', '51', '-1', '1.5', 'abc', '', '01', '1e1', ' 20', '20 ', ['20', '30'], 20, {}]) {
    // Explicit null is treated as absent by nullish defaulting, so test invalid HTTP inputs only.
    if (limit !== null) rejects400({ limit });
  }
});
test('archive cursor round-trip retains ID and PostgreSQL microsecond precision', () => {
  for (const createdAt of ['2026-11-03T12:34:56.123Z', '2026-11-03T12:34:56.123456Z']) {
    const encoded = encodeCursor({ createdAt, id });
    assert.equal(typeof encoded, 'string');
    assert.deepEqual(parseArchiveQuery({ limit: '20', before: encoded }), { limit: 20, before: { createdAt, id } });
  }
});
test('archive cursor treats same-millisecond microsecond boundaries as distinct', () => {
  const older = { createdAt: '2026-11-03T12:34:56.123001Z', id };
  const newer = { createdAt: '2026-11-03T12:34:56.123999Z', id };
  assert.notEqual(encodeCursor(older), encodeCursor(newer));
  assert.equal(parseArchiveQuery({ before: encodeCursor(older) }).before.createdAt, older.createdAt);
  assert.equal(parseArchiveQuery({ before: encodeCursor(newer) }).before.createdAt, newer.createdAt);
});
test('archive rejects invalid cursor envelopes and timestamp values', () => {
  for (const before of [
    '', 'not-json', '!!!', 'a'.repeat(513), ['one', 'two'], {},
    cursor(null), cursor([]), cursor('record'), cursor({}),
    cursor({ createdAt: '2026-02-30T12:34:56.123Z', id }),
    cursor({ createdAt: '2026-11-03T12:34:56Z', id }),
    cursor({ createdAt: '2026-11-03T12:34:56.1234567Z', id }),
    cursor({ createdAt: '2026-11-03T12:34:56.123Z', id: 'invalid' }),
    cursor({ createdAt: 'invalid', id }),
  ]) rejects400({ before });
});
test('archive rejects prototype-shaped cursor data without pollution', () => {
  const before = Buffer.from('{"__proto__":{"createdAt":"2026-11-03T12:34:56.123Z","id":"00000000-0000-4000-8000-000000000025"}}').toString('base64url');
  rejects400({ before });
  assert.equal(Object.prototype.createdAt, undefined);
  assert.equal(Object.prototype.id, undefined);
});
test('summary preserves experiment metadata and excludes growing history arrays', () => {
  const full = {
    id, name: 'Food scarcity', notes: 'Fixture', version: 'evoworld-1', seed: 42,
    settings: { foodRate: 8 }, outcome: 'manual', duration: 120,
    createdAt: '2026-11-03T12:34:56.123Z', finalSummary: { population: 25 },
    measurements: [{ tick: 0 }, { tick: 2400 }], interventions: [{ tick: 100, value: 2 }],
  };
  const before = structuredClone(full);
  assert.deepEqual(summarizeExperiment(full), {
    id, name: 'Food scarcity', notes: 'Fixture', version: 'evoworld-1', seed: 42,
    settings: { foodRate: 8 }, outcome: 'manual', duration: 120,
    createdAt: '2026-11-03T12:34:56.123Z', finalSummary: { population: 25 },
  });
  assert.deepEqual(full, before, 'Summarization must preserve full detail record');
});


for (const [label, invalidID] of [
  ['UUID array', [id]], ['nested UUID array', [[id]]], ['object', { id }],
  ['null', null], ['boolean true', true], ['boolean false', false], ['number', 42],
]) {
  test(`BUG-009: archive rejects ${label} instead of a string UUID with status 400`, () => {
    rejects400({ before: encodeCursor({ createdAt: '2026-11-04T00:00:00.123456Z', id: invalidID }) });
  });
}
test('BUG-009: string UUID still round-trips with exact microsecond precision', () => {
  const before = { createdAt: '2026-11-04T00:00:00.123456Z', id };
  assert.deepEqual(parseArchiveQuery({ before: encodeCursor(before) }), { limit: 20, before });
});
