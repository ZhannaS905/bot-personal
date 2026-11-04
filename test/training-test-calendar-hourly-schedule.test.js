'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Autopost} = require('../src/training-test-autopost');

test('calendar refreshes every five minutes, plans hourly, deletes at 22:00, rests from 23:00 to 10:00 Moscow', async () => {
  let time = '2026-11-02T09:59:00+03:00';
  const calls = {plan: 0, published: 0, pending: 0, bookings: 0};

  const service = new Autopost({
    store: {},
    api: {},
    calendarMode: true,
    calendar: {
      async day() {
        calls.plan++;
        return [];
      }
    },
    calendarPollStore: {
      async listPublished() {
        calls.published++;
        return [];
      },
      async listPendingDeletes() {
        calls.pending++;
        return [];
      },
      async listPendingBookingSync() {
        calls.bookings++;
        return [];
      }
    },
    now: () => new Date(time),
    log: () => {}
  });

  async function tick(at) {
    time = at;
    await service.tick();
  }

  await tick('2026-11-02T09:59:00+03:00');
  assert.deepEqual(calls, {plan: 0, published: 0, pending: 0, bookings: 0});

  await tick('2026-11-02T10:00:00+03:00');
  assert.equal(calls.plan, 1);
  assert.equal(calls.published, 1);

  await tick('2026-11-02T10:02:00+03:00');
  assert.equal(calls.plan, 1);
  assert.equal(calls.published, 1);

  await tick('2026-11-02T10:05:00+03:00');
  assert.equal(calls.plan, 1);
  assert.equal(calls.published, 2);

  await tick('2026-11-02T11:00:00+03:00');
  assert.equal(calls.plan, 2);
  assert.equal(calls.published, 3);

  await tick('2026-11-02T21:59:00+03:00');
  const beforeDelete = calls.published;

  await tick('2026-11-02T22:00:00+03:00');
  assert.equal(calls.published, beforeDelete + 1,
    '22:00 must trigger deletion check independently of hourly interval');

  await tick('2026-11-02T23:00:00+03:00');
  const night = {...calls};

  await tick('2026-11-03T02:00:00+03:00');
  await tick('2026-11-03T09:59:00+03:00');
  assert.deepEqual(calls, night, 'no Firebase reads overnight');

  await tick('2026-11-03T10:00:00+03:00');
  assert.ok(calls.plan > night.plan);
  assert.ok(calls.published > night.published);
});

test('failed deletion at 22:00 is retried before 23:00', async () => {
  let time = '2026-11-02T21:58:00+03:00';
  let status = 'published';
  let attempts = 0;

  const poll = {
    key: 'a'.repeat(64),
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    mid: 'mid.test',
    status: 'published',
    workout: {date: '2026-11-02'}
  };

  const service = new Autopost({
    store: {},
    calendarMode: true,
    calendar: {async day() {return [];}, async findById() {return null;}},
    calendarPollStore: {
      async listPublished() {
        return status === 'published' ? [poll] : [];
      },
      async listPendingDeletes() {
        return status === 'deletePending' ? [{...poll, status}] : [];
      },
      async beginDelete() {
        status = 'deletePending';
        return true;
      },
      async finishDelete() {
        status = 'deleted';
        return true;
      },
      async listPendingBookingSync() {return [];}
    },
    api: {
      async deleteCalendarPoll() {
        attempts++;
        if (attempts === 1) throw Error('MAX_TEMPORARY_FAILURE');
      }
    },
    now: () => new Date(time),
    log: () => {}
  });

  await service.tick();
  time = '2026-11-02T22:00:00+03:00';
  await service.tick();
  assert.equal(attempts, 2, 'failed deletion must be retried');
  assert.equal(status, 'deleted', 'poll must be marked deleted');
});
