'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Autopost} = require('../src/training-test-autopost');

const poll = {
  key: 'a'.repeat(64),
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  mid: 'mid.test',
  botId: '123',
  chat: require('../src/memory-training-test').CHAT,
  status: 'published',
  workout: {date: '2026-11-02'}
};

function fixture(time) {
  let now = new Date(time);
  let status = 'published';
  const calls = {deleted: 0, started: 0, finished: 0};
  const calendarPollStore = {
    listPublished: async () =>
      status === 'published' ? [{...poll, status}] : [],
    listPendingDeletes: async () =>
      status === 'deletePending' ? [{...poll, status}] : [],
    beginDelete: async () => {
      if (status !== 'published') return false;
      calls.started++;
      status = 'deletePending';
      return true;
    },
    finishDelete: async () => {
      calls.finished++;
      status = 'deleted';
      return true;
    }
  };
  const api = {deleteCalendarPoll: async () => { calls.deleted++; }};
  const service = new Autopost({
    store: {close: async () => {}},
    api,
    calendarMode: true,
    calendarPollStore,
    now: () => now,
    log: () => {}
  });
  return {service, calls, setTime: t => {now = new Date(t);}};
}

test('calendar poll stays before 22:00 Moscow', async () => {
  const f = fixture('2026-11-02T18:59:00Z');
  await f.service.cleanupCalendarPolls();
  assert.equal(f.calls.deleted, 0);
  assert.equal(f.calls.finished, 0);
});

test('calendar poll is deleted at 22:00 Moscow', async () => {
  const f = fixture('2026-11-02T19:00:00Z');
  await f.service.cleanupCalendarPolls();
  assert.equal(f.calls.deleted, 1);
  assert.equal(f.calls.finished, 1);
});

test('expired poll is cleaned once, including after missed deadline', async () => {
  const f = fixture('2026-11-03T08:00:00Z');
  await f.service.cleanupCalendarPolls();
  await f.service.cleanupCalendarPolls();
  assert.equal(f.calls.deleted, 1);
  assert.equal(f.calls.finished, 1);
});

test('Firebase failure after MAX deletion is handled safely', async () => {
  const f = fixture('2026-11-02T19:00:00Z');
  let attempts = 0;

  f.service.calendarPollStore.finishDelete = async () => {
    throw Error('FIRESTORE_UNAVAILABLE');
  };

  f.service.api.deleteCalendarPoll = async () => {
    attempts++;
    if (attempts > 1) {
      throw Error('MAX_MESSAGE_ALREADY_DELETED');
    }
  };

  await f.service.cleanupCalendarPolls();
  await f.service.resumeCalendarDeletes();

  assert.equal(attempts, 2);
  assert.equal(f.calls.finished, 0);
});

test('MAX 404 does not falsely complete pending deletion', async () => {
  const f = fixture('2026-11-02T19:00:00Z');

  await f.service.calendarPollStore.beginDelete(
    poll.key, poll.id, poll.mid
  );

  f.service.api.deleteCalendarPoll = async () => {
    throw Error('MAX HTTP 404');
  };

  await f.service.resumeCalendarDeletes();

  assert.equal(f.calls.finished, 0);
  assert.equal(f.calls.started, 1);

  const pending = await f.service.calendarPollStore.listPendingDeletes();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'deletePending');
});

test('MAX 404 marks deletion for manual review and stops retries', async () => {
  const f = fixture('2026-11-02T19:00:00Z');

  let attempts = 0;
  let reviewMarked = false;
  const originalListPending =
    f.service.calendarPollStore.listPendingDeletes.bind(
      f.service.calendarPollStore
    );

  f.service.calendarPollStore.listPendingDeletes = async () => {
    const records = await originalListPending();
    return records.map(record => ({
      ...record,
      deleteNeedsReview: reviewMarked
    }));
  };

  await f.service.calendarPollStore.beginDelete(
    poll.key, poll.id, poll.mid
  );

  f.service.calendarPollStore.markDeleteNeedsReview =
    async (key, id, mid) => {
      assert.equal(key, poll.key);
      assert.equal(id, poll.id);
      assert.equal(mid, poll.mid);
      reviewMarked = true;

      return true;
    };

  f.service.api.deleteCalendarPoll = async () => {
    attempts++;
    throw Error('MAX HTTP 404');
  };

  await f.service.resumeCalendarDeletes();
  assert.equal(reviewMarked, true);
  assert.equal(attempts, 1);

  await f.service.resumeCalendarDeletes();
  assert.equal(attempts, 1);

  assert.equal(f.calls.finished, 0);
});
