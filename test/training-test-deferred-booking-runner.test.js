'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Autopost} = require('../src/training-test-autopost');

test('background runner processes pending bookings', async () => {
  const calls = [];
  const service = new Autopost({
    store: {},
    api: {},
    calendar: null,
    calendarMode: true,
    calendarPollStore: {
      async listPendingBookingSync() {
        calls.push('list');
        return [{key: 'poll-a'}, {key: 'poll-b'}];
      },
      async syncBookings(key) {
        calls.push(key);
        return true;
      }
    },
    now: () => new Date('2026-11-02T12:00:00Z'),
    log: () => {}
  });

  assert.equal(await service.syncPendingBookings(), 2);
  assert.deepEqual(calls, ['list', 'poll-a', 'poll-b']);
});

test('background runner continues after individual sync failure', async () => {
  const calls = [];
  const service = new Autopost({
    store: {},
    api: {},
    calendar: null,
    calendarMode: true,
    calendarPollStore: {
      async listPendingBookingSync() {
        return [{key: 'poll-a'}, {key: 'poll-b'}];
      },
      async syncBookings(key) {
        calls.push(key);
        if (key === 'poll-a') throw Error('WRITE_DENIED');
        return true;
      }
    },
    now: () => new Date('2026-11-02T12:00:00Z'),
    log: () => {}
  });

  assert.equal(await service.syncPendingBookings(), 1);
  assert.deepEqual(calls, ['poll-a', 'poll-b']);
});
