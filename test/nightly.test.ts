import assert from 'node:assert/strict';
import test from 'node:test';
import { isoAt, localDate, nextOccurrence, previousOccurrence } from '../src/server/nightly.ts';

const at = (iso: string) => Date.parse(iso);

test('the nightly time is found in the owner\'s time zone', () => {
  // 19:00 in Tokyo: the next 04:00 is tomorrow morning, the previous one this morning.
  const evening = at('2026-09-15T10:00:00Z');
  assert.equal(nextOccurrence(evening, '04:00', 'Asia/Tokyo'), at('2026-09-15T19:00:00Z'));
  assert.equal(previousOccurrence(evening, '04:00', 'Asia/Tokyo'), at('2026-09-14T19:00:00Z'));
  // Exactly at the time: it is the previous occurrence, and the next one is a day later.
  const exact = at('2026-09-15T19:00:00Z');
  assert.equal(previousOccurrence(exact, '04:00', 'Asia/Tokyo'), exact);
  assert.equal(nextOccurrence(exact, '04:00', 'Asia/Tokyo'), at('2026-09-16T19:00:00Z'));
  assert.equal(nextOccurrence(at('2026-09-15T03:59:00Z'), '04:00', 'UTC'), at('2026-09-15T04:00:00Z'));
});

test('a time zone with daylight saving time still lands on the local time', () => {
  // New York is UTC-4 in summer and UTC-5 in winter.
  assert.equal(nextOccurrence(at('2026-07-01T12:00:00Z'), '04:00', 'America/New_York'), at('2026-07-02T08:00:00Z'));
  assert.equal(nextOccurrence(at('2026-12-01T12:00:00Z'), '04:00', 'America/New_York'), at('2026-12-02T09:00:00Z'));
});

test('dates are the calendar date in the time zone', () => {
  assert.equal(localDate(at('2026-09-15T20:30:00Z'), 'Asia/Tokyo'), '2026-09-16');
  assert.equal(localDate(at('2026-09-15T20:30:00Z'), 'UTC'), '2026-09-15');
});

test('an instant is written as the UTC instant the database stores', () => {
  assert.equal(isoAt(at('2026-09-15T20:30:00Z')), '2026-09-15T20:30:00.000Z');
  assert.equal(isoAt(0), '1970-01-01T00:00:00.000Z');
  // The time zone never enters into it: the stored form is UTC whatever the owner's zone is.
  assert.equal(isoAt(at('2026-09-15T20:30:00+09:00')), '2026-09-15T11:30:00.000Z');
});
