'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {database} = require('./helpers/autopost-firestore');
const {Autopost} = require('../src/training-test-autopost');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {createPersonalCalendar} = require('../src/fitpp-personal/calendar');
const {empty} = require('../src/fitpp-personal/group-period-model');
const config = require('../src/fitpp-personal/runtime-config');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');
const {calendarPollBody} = require('../src/training-test-calendar-body');

const day = '2026-11-04';
const uuid = '12345678-1234-1234-1234-123456789012';
const workout = {
  id: 'workout-test-1', date: day, originDate: day,
  location: 'zarya', groupId: 'zarya', periodId: 'local', time: '20:00',
  cancelled: false, extra: false
};

test('Site-to-poll sync: adding client on website adds name to poll in real-time', async () => {
  const db = database(config.projectId);
  const validateAuth = async () => {};
  const metadata = {ownerUid: config.ownerUid, datasetId: 'personal-v1', schemaVersion: 1};

  // State with 2 clients on the website
  const state = {
    ...metadata,
    _fitppRevision: 1,
    workouts: {},
    clients: [
      { id: 'client_101', name: 'Елена Васильева', phone: '+7 999 111-22-33', locations: ['zarya'] },
      { id: 'client_102', name: 'Дмитрий Соколов', phone: '+7 999 444-55-66', locations: ['zarya'] }
    ]
  };

  const schedule = empty(config.ownerUid);
  schedule.periods.push({ id: 'local', group: 'zarya', start: day, end: day, slots: [{ day: 3, time: workout.time }] });
  schedule.workouts.push(structuredClone(workout));

  // Initially, no bookings on the website
  const bookingsData = { ...metadata, entries: {}, versions: {}, revision: 0 };

  db.data.set(config.main, structuredClone(state));
  db.data.set(config.trainer, { groupScheduleV1: schedule });
  db.data.set(config.bookings, bookingsData);

  let clock = Date.parse(day + 'T12:00:00Z');
  const now = () => clock;
  const calendar = createPersonalCalendar({ sdk: db.sdk, raw: db.raw, validateAuth });
  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, validateAuth, now,
    botId: '123', writeEnabled: () => true, bookingSyncEnabled: () => true
  });

  const key = workoutKey(workout);
  await store.reserve(workout, { id: uuid, createdAt: clock - 1000 });
  await store.finish(key, uuid, 'mid.sitetest');

  const editedCalls = [];
  const tgEditedCalls = [];
  const mockApi = {
    answer: async () => {},
    editCalendar: async (p) => {
      editedCalls.push(p);
    }
  };
  const mockTgBridge = {
    start: () => {},
    stop: () => {},
    editCalendar: async (p, msg) => {
      tgEditedCalls.push({ p, msg });
    }
  };

  const autopost = new Autopost({
    store: {},
    calendarPollStore: store,
    calendar,
    calendarMode: true,
    personalMode: true,
    now: () => new Date(clock),
    log() {},
    api: mockApi,
    telegramBridge: mockTgBridge
  });

  // Check initial poll: no participants
  const initialPoll = await store.read(key);
  assert.equal(initialPoll.order.length, 0);

  // 1. Trainer adds Elena on the website
  const elenaEntryKey = JSON.stringify(['client_101', workout.id]);
  bookingsData.entries[elenaEntryKey] = true;
  bookingsData.revision++;
  db.data.set(config.bookings, structuredClone(bookingsData));

  // Run poll refresh / maintenance
  await autopost.refreshCalendarPolls([initialPoll]);

  // Elena should now be in the poll!
  const pollAfterElena = await store.read(key);
  assert.equal(pollAfterElena.order.length, 1);
  assert.equal(pollAfterElena.votes[pollAfterElena.order[0]], 'Елена Васильева');

  // Both MAX and Telegram received the edit!
  assert.equal(editedCalls.length, 1);
  assert.equal(tgEditedCalls.length, 1);
  assert.match(calendarPollBody(pollAfterElena).text, /Елена Васильева/);

  // 2. Trainer adds Dmitry on the website too
  const dmitryEntryKey = JSON.stringify(['client_102', workout.id]);
  bookingsData.entries[dmitryEntryKey] = true;
  bookingsData.revision++;
  db.data.set(config.bookings, structuredClone(bookingsData));

  await autopost.refreshCalendarPolls([pollAfterElena]);

  const pollAfterBoth = await store.read(key);
  assert.equal(pollAfterBoth.order.length, 2);
  const names = pollAfterBoth.order.map(uid => pollAfterBoth.votes[uid]);
  assert.ok(names.includes('Елена Васильева'));
  assert.ok(names.includes('Дмитрий Соколов'));

  // 3. Trainer removes Elena on the website
  delete bookingsData.entries[elenaEntryKey];
  bookingsData.revision++;
  db.data.set(config.bookings, structuredClone(bookingsData));

  await autopost.refreshCalendarPolls([pollAfterBoth]);

  const pollAfterElenaRemoved = await store.read(key);
  assert.equal(pollAfterElenaRemoved.order.length, 1);
  assert.equal(pollAfterElenaRemoved.votes[pollAfterElenaRemoved.order[0]], 'Дмитрий Соколов');
});

test('Site-to-poll sync: client booked before 10:00 is immediately included in the initial published poll', async () => {
  const db = database(config.projectId);
  const validateAuth = async () => {};
  const metadata = {ownerUid: config.ownerUid, datasetId: 'personal-v1', schemaVersion: 1};

  const state = {
    ...metadata,
    _fitppRevision: 1,
    workouts: {},
    clients: [
      { id: 'client_norika', name: 'Норика Б.', phone: '+7 930 941-23-94', locations: ['zarya'] }
    ]
  };

  const schedule = empty(config.ownerUid);
  schedule.periods.push({ id: 'local', group: 'zarya', start: day, end: day, slots: [{ day: 3, time: workout.time }] });
  schedule.workouts.push(structuredClone(workout));

  // Norika was already marked as booked on the website in advance
  const bookingsData = {
    ...metadata,
    entries: {
      [JSON.stringify(['client_norika', workout.id])]: true
    },
    versions: {},
    revision: 1
  };

  db.data.set(config.main, structuredClone(state));
  db.data.set(config.trainer, { groupScheduleV1: schedule });
  db.data.set(config.bookings, bookingsData);

  const clock = Date.parse(day + 'T07:00:00Z'); // 10:00 MSK
  const now = () => clock;
  const calendar = createPersonalCalendar({ sdk: db.sdk, raw: db.raw, validateAuth });
  const store = createCalendarPollStore({
    sdk: db.sdk, raw: db.raw, validateAuth, now,
    botId: '123', writeEnabled: () => true, bookingSyncEnabled: () => true
  });

  const sentMaxMessages = [];
  const sentTgMessages = [];
  const mockApi = {
    verify: async () => {},
    sendCalendar: async (p, msg) => {
      sentMaxMessages.push({ p, msg });
      return 'mid.norikatest';
    }
  };
  const mockTgBridge = {
    start: () => {},
    stop: () => {},
    sendCalendar: async (p, msg) => {
      sentTgMessages.push({ p, msg });
      return 1001;
    }
  };

  const autopost = new Autopost({
    store: {},
    calendarPollStore: store,
    calendar,
    calendarMode: true,
    personalMode: true,
    now: () => new Date(clock),
    log() {},
    api: mockApi,
    telegramBridge: mockTgBridge
  });

  const published = await autopost.publishCalendar(workout);
  assert.equal(published, true);

  // Both MAX and Telegram must have been sent with Norika already in the participant list!
  assert.equal(sentMaxMessages.length, 1);
  assert.equal(sentTgMessages.length, 1);
  assert.match(sentMaxMessages[0].msg.text, /Норика Б\./);
  assert.match(sentTgMessages[0].msg.text, /Норика Б\./);

  const poll = await store.read(workoutKey(workout));
  assert.equal(poll.status, 'published');
  assert.equal(poll.order.length, 1);
  assert.equal(poll.votes[poll.order[0]], 'Норика Б.');
});
