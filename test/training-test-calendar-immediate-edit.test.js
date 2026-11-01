'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Autopost} = require('../src/training-test-autopost');

for (const action of ['yes', 'cancel']) {
  test(`calendar ${action}: immediate edit, duplicate ignored`, async () => {
    const calls = [];
    let applied = true;
    const key = 'a'.repeat(64);
    const token = 'test-token';

    const service = new Autopost({
      store: {},
      calendar: {day: async () => []},
      calendarPollStore: {
        async claimEdit(k) {
          assert.equal(k, key);
          calls.push('claim');
          return {revision: 2, editLease: {token}};
        },
        async checkEdit(k, t) {
          assert.equal(k, key);
          assert.equal(t, token);
        },
        async finishEdit(k, t, revision) {
          assert.equal(k, key);
          assert.equal(t, token);
          assert.equal(revision, 2);
          calls.push('finish');
        },
        async releaseEdit() {
          throw Error('Unexpected release');
        }
      },
      api: {
        async editCalendar(p, {beforePut}) {
          await beforePut();
          calls.push('edit');
        },
        async answer() {
          calls.push('answer');
        }
      },
      calendarMode: true,
      log: () => {}
    });

    service.calendarCallbacks = {
      async receive() {
        return {handled: true, applied, action};
      }
    };

    const event = {
      update_type: 'message_callback',
      callback: {
        payload: `cal:${key}:poll-id:${action}`,
        callback_id: 'event-1'
      }
    };

    assert.equal(await service.receive(event), true);
    assert.deepEqual(calls, ['claim', 'edit', 'finish', 'answer']);

    applied = false;
    calls.length = 0;

    assert.equal(await service.receive(event), true);
    assert.deepEqual(calls, ['answer']);
  });
}

test('MAX edit failure releases lease and leaves poll for retry', async () => {
  const calls = [];
  const key = 'b'.repeat(64);
  const token = 'retry-token';

  const service = new Autopost({
    store: {},
    calendar: {day: async () => []},
    calendarPollStore: {
      async claimEdit() {
        calls.push('claim');
        return {revision: 3, editLease: {token}};
      },
      async checkEdit() {
        calls.push('check');
      },
      async finishEdit() {
        calls.push('finish');
      },
      async releaseEdit(k, t) {
        assert.equal(k, key);
        assert.equal(t, token);
        calls.push('release');
      }
    },
    api: {
      async editCalendar(p, {beforePut}) {
        await beforePut();
        throw Error('MAX_TEMPORARILY_UNAVAILABLE');
      },
      async answer() {
        calls.push('answer');
      }
    },
    calendarMode: true,
    log: () => {}
  });

  service.calendarCallbacks = {
    async receive() {
      return {handled: true, applied: true, action: 'yes'};
    }
  };

  const handled = await service.receive({
    update_type: 'message_callback',
    callback: {
      payload: `cal:${key}:poll-id:yes`,
      callback_id: 'event-retry'
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, ['claim', 'check', 'release', 'answer']);
});
