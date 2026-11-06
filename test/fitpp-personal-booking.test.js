'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {existsSync} = require('node:fs');
const {database} = require('./helpers/autopost-firestore');
const {Autopost} = require('../src/training-test-autopost');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {createPersonalCalendar} = require('../src/fitpp-personal/calendar');
const {applyBooking} = require('../src/fitpp-personal/booking');
const {firebaseStore} = require('../src/contact-linking');
const {empty, merge} = require('../src/fitpp-personal/group-period-model');
const config = require('../src/fitpp-personal/runtime-config');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');
const {CHAT} = require('../src/training-test-firestore');

const day = '2026-11-04';
const uuid = '12345678-1234-1234-1234-123456789012';
const workout = {
  id: 'group-session-local-2026-11-04-1830', date: day, originDate: day,
  location: 'zarya', groupId: 'zarya', periodId: 'local', time: '18:30',
  cancelled: false, extra: false
};
const entry = JSON.stringify(['42', workout.id]);
const legacy = JSON.stringify(['42', day, 'zarya']);
const personalSource = process.env.FITPP_PERSONAL_SOURCE || path.resolve(__dirname, '../../FitPP-Personal/docs');
const journalSource = path.join(personalSource, 'calendar-model.js');

async function fixture() {
  const db = database(config.projectId);
  const validateAuth = async () => {};
  const metadata = {ownerUid: config.ownerUid, datasetId: 'personal-v1', schemaVersion: 1};
  const state = {...metadata, _fitppRevision: 1, workouts: {},
    clients: [{id: 42, phone: '+7 999 000-00-00', locations: ['zarya'],
      subscriptions: [{remaining: 4}]}], finances: {november: 3000}, visits: {}};
  const schedule = empty(config.ownerUid);
  schedule.periods.push({id: 'local', group: 'zarya', start: day, end: day,
    slots: [{day: 3, time: workout.time}]});
  schedule.workouts.push(structuredClone(workout));
  db.data.set(config.main, structuredClone(state));
  db.data.set(config.trainer, {groupScheduleV1: schedule});
  db.data.set(config.bookings, {...metadata, entries: {}, versions: {}, revision: 0});

  const contacts = firebaseStore({sdk: db.sdk, db: db.raw, botId: 123});
  assert.equal(await contacts.find('79990000000'), '42');
  assert.deepEqual(await contacts.bind('79990000000', {clientId: '42', maxUserId: 80, maxChatId: 80}), {status: 'linked'});

  let clock = Date.parse(day + 'T12:00:00Z');
  const now = () => clock;
  const calendar = createPersonalCalendar({sdk: db.sdk, raw: db.raw, validateAuth});
  const store = createCalendarPollStore({sdk: db.sdk, raw: db.raw, validateAuth, now,
    botId: '123', writeEnabled: () => true, bookingSyncEnabled: () => true});
  const key = workoutKey(workout);
  await store.reserve(workout, {id: uuid, createdAt: clock - 1000});
  await store.finish(key, uuid, 'mid.personal');
  const service = new Autopost({store: {}, calendarPollStore: store, calendar, calendarMode: true,
    now: () => new Date(clock), log() {}, api: {answer: async () => {}, editCalendar: async () => {}}});
  const event = (action, id = action) => ({
    update_type: 'message_callback', timestamp: ++clock,
    message: {recipient: {chat_id: CHAT, chat_type: 'chat'}, body: {mid: 'mid.personal'}},
    callback: {callback_id: id, payload: `cal:${key}:${uuid}:${action}`,
      user: {user_id: 80, is_bot: false, first_name: 'Local'}}
  });
  const bookings = () => db.data.get(config.bookings);
  return {...db, state, schedule, calendar, store, service, event, now, bookings};
}

test('reads the saved Personal schedule and excludes cancelled sessions', async () => {
  const f = await fixture();
  assert.deepEqual(await f.calendar.day(day), [{id: workout.id, date: day, location: 'zarya', time: '18:30', cancelled: false}]);
  f.schedule.workouts[0].cancelled = true;
  assert.deepEqual(await f.calendar.day(day), []);
  assert.equal((await f.calendar.findById(workout.id)).cancelled, true);
});

test('Приду writes the exact journal key and operation receipt without touching accounting', async () => {
  const f = await fixture();
  assert.equal(await f.service.receive(f.event('yes')), true);
  assert.deepEqual(f.bookings().entries, {[entry]: true});
  assert.equal(f.bookings().versions[entry], 1);
  const {_fitppRevision, lastOperation, ...data} = f.data.get(config.main);
  const {_fitppRevision: ignored, ...original} = f.state;
  assert.deepEqual(data, original);
  assert.equal(_fitppRevision, 2);
  const receipt = f.data.get(config.root + '/operations/' + lastOperation.id);
  assert.equal(receipt.revision, 2);
  assert.deepEqual(JSON.parse(receipt.signature).action, {
    type: 'booking', key: entry, desired: true, operationId: lastOperation.id,
    expectedVersion: 0, workout: {id: workout.id, date: day, location: 'zarya'}
  });
  assert.ok(f.paths.every(p => !p.startsWith('fitppTestWorkspaces')));
});

test('Не приду cancels the exact and unambiguous legacy bookings', async () => {
  const f = await fixture();
  await f.service.receive(f.event('yes'));
  f.bookings().entries[legacy] = true;
  await f.service.receive(f.event('cancel'));
  assert.deepEqual(f.bookings().entries, {});
  assert.equal(f.bookings().versions[entry], 2);
  assert.equal(f.bookings().versions[legacy], 1);
  assert.deepEqual(f.data.get(config.main).clients, f.state.clients);
  assert.deepEqual(f.data.get(config.main).finances, f.state.finances);
});

test('replayed and repeated yes votes create one entry and one booking revision', async () => {
  const f = await fixture();
  const yes = f.event('yes');
  await f.service.receive(yes);
  await f.service.receive(yes);
  await f.service.receive(f.event('yes', 'another-click'));
  assert.deepEqual(f.bookings().entries, {[entry]: true});
  assert.equal(f.bookings().revision, 1);
  assert.equal(f.data.get(config.main).clients.length, 1);
  const another = await fixture();
  another.bookings().entries[legacy] = true;
  await another.service.receive(another.event('yes'));
  assert.deepEqual(another.bookings().entries, {[legacy]: true});
});

test('cancelled workout rejects both callback and a vote that raced with cancellation', async () => {
  const f = await fixture();
  f.schedule.workouts[0].cancelled = true;
  await assert.rejects(f.service.receive(f.event('yes')), /CALENDAR_CALLBACK_WORKOUT_CHANGED/);
  await assert.rejects(f.sdk.runTransaction(f.raw, transaction => applyBooking({
    sdk: f.sdk, raw: f.raw, transaction, workout, clientId: '42', desired: true, now: f.now
  }), {maxAttempts: 1}), /WORKOUT_UNAVAILABLE/);
  assert.deepEqual(f.bookings().entries, {});
});

test('FitPP Personal journal shows the booked client once and removes the booking after cancellation', {
  skip: !existsSync(journalSource) && !process.env.FITPP_PERSONAL_SOURCE && 'Set FITPP_PERSONAL_SOURCE to the docs directory at 1245d39'
}, async () => {
  const journal = require(journalSource);
  const f = await fixture();
  const raw = merge(f.state, f.schedule);
  const clients = () => journal.view(raw, f.bookings(), day).rows[0].clients;
  await f.service.receive(f.event('yes'));
  assert.deepEqual(clients().map(({id, booked}) => ({id, booked})), [{id: '42', booked: true}]);
  await f.service.receive(f.event('cancel'));
  assert.deepEqual(clients(), []);
});
