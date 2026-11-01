'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {database} = require('./helpers/autopost-firestore');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');
const {bookingId} = require('../src/fitpp-calendar-booking');

test('deferred sync writes booking once and skips unchanged revision', async () => {
  const db = database();
  const workout = {
    id: 'session-deferred-1',
    date: '2026-11-02',
    location: 'zarya',
    time: '20:00'
  };
  const key = workoutKey(workout);
  const uuid = '12345678-1234-1234-1234-123456789012';

  db.data.set(
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test',
    {
      version: 1,
      botId: 131384398,
      bindings: [{
        clientId: 'demo-client-1',
        maxUserId: 80,
        maxChatId: 80,
        notificationsEnabled: true,
        recoverNotifications: true
      }]
    }
  );

  let syncEnabled = false;

  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => syncEnabled
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  await store.vote(key, {
    id: 'callback-deferred-yes',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, () => ({text: 'OK'}));

  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.has(bookingPath), false);

  syncEnabled = true;

  assert.equal(await store.syncBookings(key), true);

  const booking = db.data.get(bookingPath);
  assert.equal(booking.booked, true);
  assert.equal(booking.pollRevision, 1);

  const poll = await store.read(key);
  assert.equal(poll.bookingSyncedRevision, 1);
  assert.deepEqual(poll.bookingSyncedClients, {'80': 'demo-client-1'});

  const commitsBefore = db.commits.length;

  assert.equal(await store.syncBookings(key), false);
  assert.equal(db.commits.length, commitsBefore);
});

test('deferred sync cancels previously synced booking', async () => {
  const db = database();
  const workout = {
    id: 'session-deferred-cancel',
    date: '2026-11-02',
    location: 'zarya',
    time: '20:00'
  };
  const key = workoutKey(workout);
  const uuid = '12345678-1234-1234-1234-123456789012';

  db.data.set(
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test',
    {
      version: 1,
      botId: 131384398,
      bindings: [{
        clientId: 'demo-client-1',
        maxUserId: 80,
        maxChatId: 80,
        notificationsEnabled: true,
        recoverNotifications: true
      }]
    }
  );

  let syncEnabled = false;

  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => syncEnabled
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const render = () => ({text: 'OK'});

  await store.vote(key, {
    id: 'callback-yes',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, render);

  syncEnabled = true;
  await store.syncBookings(key);

  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.get(bookingPath).booked, true);

  syncEnabled = false;

  await store.vote(key, {
    id: 'callback-cancel',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 300,
    action: 'cancel'
  }, render);

  syncEnabled = true;

  assert.equal(await store.syncBookings(key), true);
  assert.equal(db.data.get(bookingPath).booked, false);
  assert.equal(db.data.get(bookingPath).pollRevision, 2);

  const poll = await store.read(key);

  assert.equal(poll.bookingSyncedRevision, 2);
  assert.deepEqual(poll.bookingSyncedClients, {});
  assert.deepEqual(poll.votes, {});
});

test('failed deferred sync preserves vote and retries successfully', async () => {
  const db = database();
  const workout = {
    id: 'session-deferred-retry',
    date: '2026-11-02',
    location: 'zarya',
    time: '20:00'
  };
  const key = workoutKey(workout);
  const uuid = '12345678-1234-1234-1234-123456789012';

  db.data.set(
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test',
    {
      version: 1,
      botId: 131384398,
      bindings: [{
        clientId: 'demo-client-1',
        maxUserId: 80,
        maxChatId: 80,
        notificationsEnabled: true,
        recoverNotifications: true
      }]
    }
  );

  let syncEnabled = false;

  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => syncEnabled
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  await store.vote(key, {
    id: 'callback-retry-yes',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, () => ({text: 'OK'}));

  syncEnabled = true;
  db.setFail('write');

  await assert.rejects(
    store.syncBookings(key),
    /WRITE_DENIED/
  );

  const failedPoll = await store.read(key);

  assert.equal(failedPoll.votes['80'], 'Тест');
  assert.equal(failedPoll.revision, 1);
  assert.equal(failedPoll.bookingSyncedRevision, 0);

  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.has(bookingPath), false);

  db.setFail(null);

  assert.equal(await store.syncBookings(key), true);
  assert.equal(db.data.get(bookingPath).booked, true);
  assert.equal((await store.read(key)).bookingSyncedRevision, 1);
});

test('concurrent cancellation retries sync against latest vote', async () => {
  const db = database();
  const workout = {
    id: 'session-deferred-race',
    date: '2026-11-02',
    location: 'zarya',
    time: '20:00'
  };
  const key = workoutKey(workout);
  const uuid = '12345678-1234-1234-1234-123456789012';

  const bindingsPath =
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test';

  db.data.set(bindingsPath, {
    version: 1,
    botId: 131384398,
    bindings: [{
      clientId: 'demo-client-1',
      maxUserId: 80,
      maxChatId: 80,
      notificationsEnabled: true,
      recoverNotifications: true
    }]
  });

  let syncEnabled = false;
  let releaseRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const proceed = new Promise(resolve => { releaseRead = resolve; });
  let pauseOnce = true;

  const sdk = {
    ...db.sdk,
    async runTransaction(raw, fn, options) {
      return db.sdk.runTransaction(raw, async transaction => {
        const wrapped = {
          ...transaction,
          async get(ref) {
            const result = await transaction.get(ref);
            if (syncEnabled && pauseOnce && ref.path === bindingsPath) {
              pauseOnce = false;
              readStarted();
              await proceed;
            }
            return result;
          }
        };
        return fn(wrapped);
      }, options);
    }
  };

  const store = createCalendarPollStore({
    sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => syncEnabled
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const render = () => ({text: 'OK'});

  await store.vote(key, {
    id: 'race-yes', uuid, mid: 'mid.test',
    uid: '80', at: 200, action: 'yes', name: 'Тест'
  }, render);

  syncEnabled = true;
  const syncing = store.syncBookings(key);

  await started;

  syncEnabled = false;
  try {
    await store.vote(key, {
      id: 'race-cancel', uuid, mid: 'mid.test',
      uid: '80', at: 300, action: 'cancel'
    }, render);
  } finally {
    syncEnabled = true;
    releaseRead();
  }

  await syncing;

  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.has(bookingPath), false);

  const poll = await store.read(key);
  assert.equal(poll.revision, 2);
  assert.equal(poll.bookingSyncedRevision, 2);
  assert.deepEqual(poll.bookingSyncedClients, {});
});

test('unlinked attendee stays pending until client binding appears', async () => {
  const db = database();
  const workout = {
    id: 'session-deferred-unlinked',
    date: '2026-11-02',
    location: 'zarya',
    time: '20:00'
  };
  const key = workoutKey(workout);
  const uuid = '12345678-1234-1234-1234-123456789012';
  const bindingsPath =
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test';

  const registry = {
    version: 1,
    botId: 131384398,
    bindings: []
  };

  db.data.set(bindingsPath, registry);

  let syncEnabled = false;

  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => syncEnabled
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  await store.vote(key, {
    id: 'unlinked-yes',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, () => ({text: 'OK'}));

  syncEnabled = true;

  assert.equal(await store.syncBookings(key), true);

  let poll = await store.read(key);
  assert.equal(poll.bookingSyncPending, true);
  assert.equal(poll.bookingSyncedRevision, 0);
  assert.equal(poll.votes['80'], 'Тест');

  registry.bindings.push({
    clientId: 'demo-client-1',
    maxUserId: 80,
    maxChatId: 80,
    notificationsEnabled: true,
    recoverNotifications: true
  });

  db.data.set(bindingsPath, registry);

  assert.equal(await store.syncBookings(key), true);

  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.get(bookingPath).booked, true);

  poll = await store.read(key);
  assert.equal(poll.bookingSyncPending, false);
  assert.equal(poll.bookingSyncedRevision, 1);
});
