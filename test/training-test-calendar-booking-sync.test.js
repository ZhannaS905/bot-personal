'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {database} = require('./helpers/autopost-firestore');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');

const workout = {
  id: 'session-123',
  date: '2026-11-02',
  location: 'zarya',
  time: '20:00'
};

const uuid = '12345678-1234-1234-1234-123456789012';
const key = workoutKey(workout);

function setup() {
  const db = database();
  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true
  });
  return {db, store};
}

test('calendar vote commits once and ignores duplicate event', async () => {
  const {db, store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const event = {
    id: 'callback-1',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  };

  const render = () => ({text: 'OK'});

  assert.equal(await store.vote(key, event, render), true);
  assert.equal(await store.vote(key, event, render), false);

  const poll = await store.read(key);
  assert.equal(poll.votes['80'], 'Тест');
  assert.equal(poll.revision, 1);

  const receiptPaths = db.commits.filter(path => path.includes('/events/'));
  assert.equal(receiptPaths.length, 1);
});

test('failed calendar vote does not change poll or create receipt', async () => {
  const {db, store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const before = await store.read(key);
  const commitsBefore = db.commits.length;

  db.setFail('write');

  await assert.rejects(
    store.vote(key, {
      id: 'callback-2',
      uuid,
      mid: 'mid.test',
      uid: '80',
      at: 200,
      action: 'yes',
      name: 'Тест'
    }, () => ({text: 'OK'})),
    /WRITE_DENIED/
  );

  assert.deepEqual(await store.read(key), before);
  assert.equal(db.commits.length, commitsBefore);
});

test('booking sync remains disabled by default', async () => {
  const {db, store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  await store.vote(key, {
    id: 'callback-default-off',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, () => ({text: 'OK'}));

  assert.equal(
    [...db.data.keys()].some(path => path.includes('/calendarBookings/')),
    false
  );
});


test('missing MAX bindings do not block vote; deferred sync retries', async () => {
  const db = database();
  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => true
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  assert.equal(await store.vote(key, {
    id: 'callback-no-bindings', uuid, mid: 'mid.test',
    uid: '80', at: 200, action: 'yes', name: 'Тест'
  }, () => ({text: 'OK'})), true);

  const poll = await store.read(key);
  assert.equal(poll.votes['80'], 'Тест');
  assert.equal(poll.bookingSyncPending, true);

  await assert.rejects(
    store.syncBookings(key),
    /CALENDAR_BOOKING_BINDINGS_MISSING/
  );
  assert.equal((await store.read(key)).bookingSyncPending, true);
});


test('MAX vote does not read bindings; deferred sync reads them', async () => {
  const db = database();
  const bindingsPath =
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test';

  db.data.set(bindingsPath, {
    version: 1, botId: 131384398,
    bindings: [{
      clientId: 'demo-client-1', maxUserId: 80, maxChatId: 80,
      notificationsEnabled: true, recoverNotifications: true
    }]
  });

  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => true
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  assert.equal(await store.vote(key, {
    id: 'callback-linked-client', uuid, mid: 'mid.test',
    uid: '80', at: 200, action: 'yes', name: 'Тест'
  }, () => ({text: 'OK'})), true);

  assert.equal((await store.read(key)).votes['80'], 'Тест');
  assert.equal(db.paths.includes(bindingsPath), false);

  assert.equal(await store.syncBookings(key), true);
  assert.equal(db.paths.includes(bindingsPath), true);
});


test('deferred sync creates booking for linked FitPP client', async () => {
  const db = database();
  db.data.set(
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test',
    {
      version: 1, botId: 131384398,
      bindings: [{
        clientId: 'demo-client-1', maxUserId: 80, maxChatId: 80,
        notificationsEnabled: true, recoverNotifications: true
      }]
    }
  );

  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => true
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');
  await store.vote(key, {
    id: 'callback-booking-yes', uuid, mid: 'mid.test',
    uid: '80', at: 200, action: 'yes', name: 'Тест'
  }, () => ({text: 'OK'}));

  const {bookingId} = require('../src/fitpp-calendar-booking');
  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  assert.equal(db.data.has(bookingPath), false);
  assert.equal(await store.syncBookings(key), true);

  const booking = db.data.get(bookingPath);
  assert.ok(booking);
  assert.equal(booking.workoutId, workout.id);
  assert.equal(booking.clientId, 'demo-client-1');
  assert.equal(booking.booked, true);
  assert.equal(booking.maxUserId, '80');
  assert.equal(booking.pollRevision, 1);
  assert.equal(booking.source, 'max-training-test');
  assert.equal((await store.read(key)).votes['80'], 'Тест');
});


test('deferred sync cancels previously created FitPP booking', async () => {
  const db = database();
  db.data.set(
    'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test',
    {
      version: 1, botId: 131384398,
      bindings: [{
        clientId: 'demo-client-1', maxUserId: 80, maxChatId: 80,
        notificationsEnabled: true, recoverNotifications: true
      }]
    }
  );

  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => true
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');
  const render = () => ({text: 'OK'});

  await store.vote(key, {
    id: 'callback-yes', uuid, mid: 'mid.test',
    uid: '80', at: 200, action: 'yes', name: 'Тест'
  }, render);

  assert.equal(await store.syncBookings(key), true);

  await store.vote(key, {
    id: 'callback-cancel', uuid, mid: 'mid.test',
    uid: '80', at: 300, action: 'cancel'
  }, render);

  assert.equal(await store.syncBookings(key), true);

  const {bookingId} = require('../src/fitpp-calendar-booking');
  const bookingPath =
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/' +
    bookingId(workout.id, 'demo-client-1');

  const booking = db.data.get(bookingPath);
  assert.ok(booking);
  assert.equal(booking.booked, false);
  assert.equal(booking.maxUserId, '80');
  assert.equal(booking.pollRevision, 2);
  assert.equal(booking.workoutId, workout.id);
  assert.equal(booking.clientId, 'demo-client-1');

  const poll = await store.read(key);
  assert.equal(Object.hasOwn(poll.votes, '80'), false);
  assert.equal(poll.revision, 2);
  assert.equal(poll.bookingSyncPending, false);
});

test('failed booking write rolls back MAX vote and receipt', async () => {
  const db = database();

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

  const store = createCalendarPollStore({
    sdk: db.sdk,
    raw: db.raw,
    botId: '131384398',
    validateAuth: async () => {},
    writeEnabled: () => true,
    bookingSyncEnabled: () => true
  });

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const before = await store.read(key);
  const commitsBefore = db.commits.length;

  db.setFail('write');

  await assert.rejects(
    store.vote(key, {
      id: 'callback-failed-booking',
      uuid,
      mid: 'mid.test',
      uid: '80',
      at: 200,
      action: 'yes',
      name: 'Тест'
    }, () => ({text: 'OK'}))
  );

  const after = await store.read(key);

  assert.deepEqual(after, before, 'Голос MAX не должен измениться');
  assert.equal(db.commits.length, commitsBefore);

  const bookingPaths = [...db.data.keys()]
    .filter(path => path.includes('/calendarBookings/'));

  assert.deepEqual(bookingPaths, [], 'Запись FitPP не должна появиться');

  const receiptPaths = [...db.data.keys()]
    .filter(path => path.includes('/events/'));

  assert.deepEqual(receiptPaths, [], 'Квитанция события не должна появиться');
});

test('pending deletion blocks completion of an earlier edit', async () => {
  const {store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  // Создаём изменение, которое требует обновления сообщения.
  await store.vote(key, {
    id: 'callback-before-delete',
    uuid,
    mid: 'mid.test',
    uid: '80',
    at: 200,
    action: 'yes',
    name: 'Тест'
  }, () => ({text: 'OK'}));

  const claimed = await store.claimEdit(key);
  assert.ok(claimed);

  const token = claimed.editLease.token;

  assert.equal(await store.beginDelete(key, uuid, 'mid.test'), true);

  // Старое редактирование больше не должно завершаться.
  assert.equal(await store.finishEdit(key, token, claimed.revision), false);

  const pending = await store.read(key);
  assert.equal(pending.status, 'deletePending');
  assert.equal(pending.displayedRevision, 0);
  assert.equal(pending.editLease, undefined);

  // Голоса после начала удаления тоже не принимаются.
  assert.equal(await store.vote(key, {
    id: 'callback-after-delete',
    uuid,
    mid: 'mid.test',
    uid: '81',
    at: 300,
    action: 'yes',
    name: 'Другой тест'
  }, () => ({text: 'OK'})), false);

  assert.equal(await store.finishDelete(key, uuid, 'mid.test'), true);
  assert.equal((await store.read(key)).status, 'deleted');
});

test('new calendar poll starts with zero booking sync revision', async () => {
  const {store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});

  const poll = await store.read(key);

  assert.equal(poll.bookingSyncedRevision, 0);
  assert.equal(poll.revision, 0);
});

test('legacy calendar poll without booking sync revision remains readable', async () => {
  const {db, store} = setup();

  await store.reserve(workout, {id: uuid, createdAt: 100});
  await store.finish(key, uuid, 'mid.test');

  const path = `trainingTestCalendarPolls/131384398/polls/${key}`;
  const legacy = {...db.data.get(path)};
  delete legacy.bookingSyncedRevision;
  db.data.set(path, legacy);

  const poll = await store.read(key);

  assert.equal(poll.status, 'published');
  assert.equal(poll.bookingSyncedRevision ?? 0, 0);
});
