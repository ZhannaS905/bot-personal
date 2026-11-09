'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {
  formatCoachSummary,
  resolveBookedClients,
  isWorkoutDueForSummary,
  createCoachSummaryWorker
} = require('../src/fitpp-personal/coach-summary');
const {openLedger} = require('../src/fitpp-personal/notification-ledger');

test('formatCoachSummary correctly formats 8 clients, 2 clients, 1 client, and 0 clients', () => {
  const workout = {date: '2026-11-09', time: '20:00', location: 'zarya'};
  const names8 = [
    'Анна', 'Борис', 'Вера', 'Галина',
    'Дмитрий', 'Елена', 'Жанна', 'Зоя'
  ];
  const text8 = formatCoachSummary({workout, clientNames: names8});
  assert.equal(
    text8,
    'Сегодня в 20:00 (Заря): записано 8 человек.\n\n' +
    '1. Анна\n2. Борис\n3. Вера\n4. Галина\n5. Дмитрий\n6. Елена\n7. Жанна\n8. Зоя'
  );

  const text2 = formatCoachSummary({
    workout: {date: '2026-11-10', time: '18:30', location: 'pole'},
    clientNames: ['Алиса', 'Михаил']
  });
  assert.equal(
    text2,
    'Сегодня в 18:30 (Поле чудес): записано 2 человека.\n\n' +
    '1. Алиса\n2. Михаил'
  );

  const text1 = formatCoachSummary({
    workout: {date: '2026-11-14', time: '18:00', location: 'online'},
    clientNames: ['Ольга']
  });
  assert.equal(
    text1,
    'Сегодня в 18:00 (Онлайн): записан 1 человек.\n\n' +
    '1. Ольга'
  );

  const text0 = formatCoachSummary({workout, clientNames: []});
  assert.equal(text0, 'Сегодня в 20:00 (Заря): пока никто не записался.');
});

test('resolveBookedClients correctly resolves exact and legacy bookings, ignoring archived clients', () => {
  const workout = {id: 'workout-zarya-1', date: '2026-11-09', time: '20:00', location: 'zarya'};
  const clients = [
    {id: '1', name: 'Анна Иванова'},
    {id: '2', name: 'Борис Петров'},
    {id: '3', name: 'Елена Смирнова', archivedAt: '2026-11-01'}, // archived, should be ignored
    {id: '4', name: 'Светлана Васильева'}
  ];
  const bookings = {
    entries: {
      [JSON.stringify(['1', 'workout-zarya-1'])]: true, // exact booking for Анна
      [JSON.stringify(['2', '2026-11-09', 'zarya'])]: true, // legacy booking for Борис
      [JSON.stringify(['3', 'workout-zarya-1'])]: true, // exact booking for archived Елена
      [JSON.stringify(['4', 'other-workout'])]: true, // different workout
      [JSON.stringify(['1', 'cancelled-key'])]: false // false entry
    }
  };

  const booked = resolveBookedClients({workout, clients, bookings});
  assert.deepEqual(booked, ['Анна Иванова', 'Борис Петров']);
});

test('isWorkoutDueForSummary respects 2-hour window and excludes cancelled workouts', () => {
  const workout = {id: 'w1', date: '2026-11-09', time: '20:00', location: 'zarya', cancelled: false};
  const workoutStartMs = Date.parse('2026-11-09T20:00:00+03:00');
  const twoHoursBeforeMs = workoutStartMs - 2 * 60 * 60 * 1000; // 18:00:00

  // 17:59:59 (before 2 hours): NOT due
  assert.equal(isWorkoutDueForSummary({workout, nowMs: twoHoursBeforeMs - 1000}), false);

  // Exactly 18:00:00: IS due
  assert.equal(isWorkoutDueForSummary({workout, nowMs: twoHoursBeforeMs}), true);

  // 19:15:00: IS due
  assert.equal(isWorkoutDueForSummary({workout, nowMs: twoHoursBeforeMs + 75 * 60 * 1000}), true);

  // 20:00:00 (workout started): NOT due
  assert.equal(isWorkoutDueForSummary({workout, nowMs: workoutStartMs}), false);

  // 20:05:00 (past workout): NOT due
  assert.equal(isWorkoutDueForSummary({workout, nowMs: workoutStartMs + 300000}), false);

  // Cancelled workout: NOT due even in window
  const cancelledWorkout = {...workout, cancelled: true};
  assert.equal(isWorkoutDueForSummary({workout: cancelledWorkout, nowMs: twoHoursBeforeMs}), false);
});

test('createCoachSummaryWorker sends summary to coach 2h before workout and prevents duplicates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-summary-ledger-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));

  const ledger = openLedger(dir, {start: 0, scope: 'coach-summary-test'});
  const workout = {id: 'w-today-zarya', date: '2026-11-09', time: '20:00', location: 'zarya', cancelled: false};
  const clients = [
    {id: '10', name: 'Ольга Кузнецова'},
    {id: '11', name: 'Дмитрий Орлов'}
  ];
  const bookings = {
    entries: {
      [JSON.stringify(['10', 'w-today-zarya'])]: true,
      [JSON.stringify(['11', 'w-today-zarya'])]: true
    }
  };

  const source = {
    forDate: async () => ({
      workouts: [workout],
      clients,
      bookings
    })
  };

  const sent = [];
  const raw = {
    async request(method, endpoint, query, body) {
      assert.equal(method, 'POST');
      assert.equal(endpoint, '/messages');
      sent.push({query, body});
      return {message: {body: {mid: 'mid.summary.123'}}};
    }
  };

  const nowMs = Date.parse('2026-11-09T18:00:00+03:00'); // exactly 2h before 20:00
  const worker = createCoachSummaryWorker({
    source,
    ledger,
    raw,
    coachUserId: '5819064',
    now: () => nowMs
  });

  // First run: should send
  await worker();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].query, {user_id: 5819064});
  assert.equal(
    sent[0].body.text,
    'Сегодня в 20:00 (Заря): записано 2 человека.\n\n1. Дмитрий Орлов\n2. Ольга Кузнецова'
  );
  assert.equal(ledger.status('coach-summary:w-today-zarya'), 'sent');

  // Second run: should NOT send again (deduplication)
  await worker();
  assert.equal(sent.length, 1);
});

test('createCoachSummaryWorker handles HTTP 400 rejection and skips sending before lead time', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-summary-ledger-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));

  const ledger = openLedger(dir, {start: 0, scope: 'coach-summary-test-2'});
  const workout = {id: 'w-rejected', date: '2026-11-09', time: '20:00', location: 'zarya'};
  const source = {
    forDate: async () => ({
      workouts: [workout],
      clients: [{id: '1', name: 'Иван'}],
      bookings: {entries: {[JSON.stringify(['1', 'w-rejected'])]: true}}
    })
  };

  // Check 1: 17:59 (before 2 hours) -> does NOT send
  const beforeMs = Date.parse('2026-11-09T17:59:00+03:00');
  let called = false;
  const raw = {
    async request() {
      called = true;
      throw new Error('MAX HTTP 400');
    }
  };

  const workerEarly = createCoachSummaryWorker({
    source, ledger, raw, coachUserId: '5819064', now: () => beforeMs
  });
  await workerEarly();
  assert.equal(called, false);
  assert.equal(ledger.status('coach-summary:w-rejected'), undefined);

  // Check 2: 18:00 (due) -> tries to send, gets 400, finishes as 'rejected'
  const inWindowMs = Date.parse('2026-11-09T18:00:00+03:00');
  const workerDue = createCoachSummaryWorker({
    source, ledger, raw, coachUserId: '5819064', now: () => inWindowMs
  });
  await workerDue();
  assert.equal(called, true);
  assert.equal(ledger.status('coach-summary:w-rejected'), 'rejected');
});

test('createCoachSummaryWorker supports coachChatId destination', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-summary-ledger-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));

  const ledger = openLedger(dir, {start: 0, scope: 'coach-summary-test-3'});
  const workout = {id: 'w-chat', date: '2026-11-09', time: '20:00', location: 'zarya'};
  const source = {
    forDate: async () => ({
      workouts: [workout],
      clients: [{id: '1', name: 'Иван'}],
      bookings: {entries: {[JSON.stringify(['1', 'w-chat'])]: true}}
    })
  };

  const sent = [];
  const raw = {
    async request(method, endpoint, query, body) {
      sent.push({query, body});
      return {message: {body: {mid: 'mid.chat.1'}}};
    }
  };

  const inWindowMs = Date.parse('2026-11-09T18:00:00+03:00');
  const worker = createCoachSummaryWorker({
    source, ledger, raw, coachChatId: '-100123456789', now: () => inWindowMs
  });
  await worker();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].query, {chat_id: '-100123456789'});
  assert.equal(ledger.status('coach-summary:w-chat'), 'sent');
});

test('source.summaryData correctly integrates with Personal source and returns day workouts and clients', async () => {
  const {createSource} = require('../src/fitpp-personal/notifications');
  const {empty} = require('../src/fitpp-personal/group-period-model');
  const config = require('../src/fitpp-personal/runtime-config');

  const snapshot = (data = {}, id = 'doc-id') => ({
    id, data: () => data, metadata: {fromCache: false, hasPendingWrites: false}
  });

  const stateDoc = {
    ownerUid: config.ownerUid,
    datasetId: 'personal-v1',
    schemaVersion: 1,
    _fitppRevision: 10,
    clients: [
      {id: '1', name: 'Мария'},
      {id: '2', name: 'Анна'}
    ],
    workouts: {}
  };

  const schedule = empty(config.ownerUid);
  schedule.periods.push({
    id: 'p1',
    group: 'zarya',
    start: '2026-11-01',
    end: '2026-11-30',
    slots: [{day: 1, time: '20:00'}] // Monday 20:00
  });
  schedule.workouts.push({
    id: 'w-1',
    location: 'zarya',
    periodId: 'p1',
    date: '2026-11-09',
    originDate: '2026-11-09',
    time: '20:00',
    cancelled: false
  });

  const trainerDoc = {groupScheduleV1: schedule};

  const bookingsDoc = {
    ownerUid: config.ownerUid,
    datasetId: 'personal-v1',
    entries: {
      [JSON.stringify(['1', '2026-11-09', 'zarya'])]: true,
      [JSON.stringify(['2', '2026-11-09', 'zarya'])]: true
    }
  };

  const raw = {
    app: {options: {projectId: config.projectId}}
  };

  const sdk = {
    doc: (db, path) => path,
    getDocFromServer: async path => {
      if (path === config.main) return snapshot(stateDoc);
      if (path === config.trainer) return snapshot(trainerDoc);
      if (path === config.bookings) return snapshot(bookingsDoc);
      return snapshot({});
    }
  };

  const source = createSource({sdk, raw, validateAuth: async () => {}});
  const data = await source.summaryData('2026-11-09'); // 2026-11-09 is Monday

  assert.equal(data.workouts.length, 1);
  assert.equal(data.workouts[0].time, '20:00');
  assert.equal(data.workouts[0].location, 'zarya');
  assert.equal(data.clients.length, 2);

  const bookedNames = resolveBookedClients({
    workout: data.workouts[0],
    clients: data.clients,
    bookings: data.bookings
  });

  assert.deepEqual(bookedNames, ['Анна', 'Мария']);
  const text = formatCoachSummary({workout: data.workouts[0], clientNames: bookedNames});
  assert.equal(text, 'Сегодня в 20:00 (Заря): записано 2 человека.\n\n1. Анна\n2. Мария');
});


