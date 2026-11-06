'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createSource, createWorker} = require('../src/fitpp-personal/notifications');
const {openLedger} = require('../src/fitpp-personal/notification-ledger');
const {settings} = require('../src/fitpp-personal/notification-worker');
const config = require('../src/fitpp-personal/runtime-config');

const botId = 123;
const date = '2026-11-06';
const subscriptionId = 'subscription-sale';
const purchase = {kind: 'purchase', subscriptionId, sessions: 8, remaining: 8, expires: '2026-12-04'};
const attended = {kind: 'attended', workoutId: 'one', visitId: 'mark-one', date, subscriptionId, remaining: 7};
const missed = {kind: 'missed', workoutId: 'two', visitId: 'mark-two', date, subscriptionId, remaining: 6};

function receipt(id, revision, event) {
  const type = event.kind === 'purchase' ? 'subscription' : 'attendance';
  const action = {type, operationId: id, clientId: 42, status: event.kind, workoutId: event.workoutId, date};
  return {id, data: {type, revision, signature: JSON.stringify({action, personalNotificationsV1: [event]})}};
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-notification-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const ledger = () => openLedger(dir, {start: 0, scope: 'fixture'});
  const rows = [receipt('sale', 1, purchase), receipt('visit', 2, attended), receipt('miss', 3, missed)];
  const state = {ownerUid: config.ownerUid, datasetId: 'personal-v1', schemaVersion: 1, _fitppRevision: 3,
    clients: [{id: 42, subscriptions: [{id: subscriptionId, left: 6}]}],
    workouts: {one: {id: 'one', date}, two: {id: 'two', date}},
    visits: {one: {42: 'attended'}, two: {42: 'missed'}},
    visitOps: {one: {42: {operationId: 'mark-one', status: 'attended', subscriptionId}},
      two: {42: {operationId: 'mark-two', status: 'missed', subscriptionId}}}};
  const registry = {version: 1, botId, bindings: [{clientId: '42', maxChatId: 900,
    maxUserId: 80, notificationsEnabled: true}]};
  const source = {receipts: async cursor => ({rows: rows.filter(r => r.data.revision > cursor), through: 3}),
    context: async () => ({state, registry})};
  const posts = [], reports = [];
  const raw = {async request(method, endpoint, query, body) {
    if (method === 'GET') {
      assert.equal(endpoint, '/me');
      return {user_id: botId, username: 'id623401053090_1_bot', is_bot: true};
    }
    posts.push({method, endpoint, query, body});
    return {message: {body: {mid: 'test'}}};
  }};
  const worker = () => createWorker({botId, source, ledger: ledger(), raw, report: s => reports.push(s)});
  return {state, registry, rows, raw, source, posts, reports, ledger, worker};
}

test('sends all three messages to the verified linked user, with balances from the receipts', async t => {
  const f = fixture(t);
  const tick = f.worker();
  await Promise.all([tick(), tick()]);
  await f.worker()(); // Fresh worker, same durable ledger.
  assert.equal(f.posts.length, 3);
  for (const p of f.posts) {
    assert.equal(p.method, 'POST');
    assert.equal(p.endpoint, '/messages');
    assert.deepEqual(p.query, {user_id: 80});
    assert.equal(p.body.notify, true);
  }
  assert.match(f.posts[0].body.text, /💳 Покупка абонемента[\s\S]*04\.12\.2026[\s\S]*Осталось занятий: 8/);
  assert.match(f.posts[1].body.text, /✅ Посещение[\s\S]*06\.11\.2026[\s\S]*Осталось занятий: 7/);
  assert.match(f.posts[2].body.text, /❌ Занятие сгорело[\s\S]*С абонемента списано 1 занятие\.[\s\S]*Осталось занятий: 6/);
  assert.deepEqual(f.reports, ['sent', 'sent', 'sent']);
});

test('handles uncertain delivery, rejection and an interrupted claim without retrying a POST', async t => {
  const f = fixture(t);
  const request = f.raw.request;
  f.raw.request = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'GET') return response;
    if (f.posts.length === 1) throw Error('timeout with private details');
    throw Error('MAX HTTP 403');
  };
  assert.equal(f.ledger().claim('miss:missed'), true);
  assert.equal(f.ledger().claim('miss:missed'), false);
  await f.worker()();
  await f.worker()();
  assert.equal(f.posts.length, 2);
  assert.equal(f.ledger().status('sale:purchase'), 'uncertain');
  assert.equal(f.ledger().status('visit:attended'), 'rejected');
  assert.deepEqual(f.reports, ['uncertain', 'rejected', 'uncertain']);
});

test('a failed read or wrong MAX identity leaves the event eligible and sends nothing', async t => {
  const f = fixture(t);
  const request = f.raw.request;
  f.raw.request = async () => ({user_id: 456, is_bot: true});
  await assert.rejects(f.worker()(), /PERSONAL_MAX_IDENTITY_REFUSED/);
  f.raw.request = request;
  const context = f.source.context;
  f.source.context = async () => { throw Error('unavailable'); };
  await assert.rejects(f.worker()(), /unavailable/);
  assert.equal(f.ledger().cursor(), 0);
  assert.equal(f.posts.length, 0);
  f.source.context = context;
  await f.worker()();
  assert.equal(f.posts.length, 3);
});

test('missing or disabled bindings skip permanently, and superseded visits are suppressed', async t => {
  const f = fixture(t);
  f.registry.bindings[0].notificationsEnabled = false;
  f.rows.splice(1);
  await f.worker()();
  assert.equal(f.ledger().status('sale:purchase'), 'unlinked');
  f.registry.bindings = [];
  f.rows.push(receipt('miss', 4, missed));
  f.state._fitppRevision = 4;
  f.source.receipts = async cursor => ({rows: f.rows.filter(r => r.data.revision > cursor), through: 4});
  await f.worker()();
  assert.equal(f.ledger().status('miss:missed'), 'unlinked');
  f.registry.bindings.push({clientId: '42', maxChatId: 900, maxUserId: 80, notificationsEnabled: true});
  f.state.visitOps.one[42].operationId = 'replacement';
  f.rows.push(receipt('visit', 5, attended));
  f.state._fitppRevision = 5;
  f.source.receipts = async cursor => ({rows: f.rows.filter(r => r.data.revision > cursor), through: 5});
  await f.worker()();
  assert.equal(f.ledger().status('visit:attended'), 'stale');
  assert.equal(f.posts.length, 0);
});

test('a repeated receipt cannot resend even if the cursor was not advanced', async t => {
  const f = fixture(t);
  f.ledger().claim('sale:purchase');
  f.ledger().finish('sale:purchase', 'sent');
  assert.equal(f.ledger().cursor(), 0);
  await f.worker()();
  assert.equal(f.posts.length, 2);
});

test('booking and pre-feature receipts never generate a POST', async t => {
  const f = fixture(t);
  f.rows[0].data.type = 'booking';
  f.rows[1].data.signature = JSON.stringify({action: {operationId: 'visit', type: 'attendance'}});
  f.rows.pop();
  f.raw.request = async () => assert.fail('MAX should not be called');
  await f.worker()();
  assert.equal(f.ledger().cursor(), 3);
});

test('source only queries Personal and rejects cached or pending data', async t => {
  const f = fixture(t);
  const paths = [];
  const raw = {app: {options: {projectId: config.projectId}}};
  const snapshot = (data, id, pending = false) => ({id, data: () => data,
    metadata: {fromCache: false, hasPendingWrites: pending}});
  let pending = false;
  const sdk = {
    doc: (_, path) => path,
    collection: (_, path) => path,
    where: (...args) => args, orderBy: key => key, limit: n => n,
    query: (...args) => args,
    getDocFromServer: async path => {
      paths.push(path);
      return snapshot(path === config.main ? f.state : f.registry);
    },
    async getDocsFromServer([path, types, min, max, order, limit]) {
      paths.push(path);
      assert.deepEqual(types, ['type', 'in', ['subscription', 'attendance']]);
      assert.deepEqual(min, ['revision', '>', 0]);
      assert.deepEqual(max, ['revision', '<=', 3]);
      assert.equal(order, 'revision');
      assert.equal(limit, 25);
      const rows = path.endsWith('/operations') ? f.rows.slice(1) : f.rows.slice(0, 1);
      return {...snapshot(), docs: rows.map(row => snapshot(row.data, row.id, pending))};
    }
  };
  const source = createSource({raw, sdk, validateAuth: async () => {}});
  assert.deepEqual(await source.receipts(0), {rows: f.rows, through: 3});
  assert.deepEqual(await source.context(), {state: f.state, registry: f.registry});
  assert.deepEqual([...new Set(paths)].sort(), [config.main, config.bindings,
    config.root + '/operations', config.root + '/paymentReceipts'].sort());
  pending = true;
  await assert.rejects(source.receipts(0), /PERSONAL_UNCONFIRMED_READ/);
  assert.throws(() => createSource({sdk, raw: {app: {options: {projectId: 'fitpp-test'}}}}), /PERSONAL_PROJECT_REQUIRED/);
  assert.throws(() => settings({FIREBASE_PROJECT_ID: 'fitpp-test'}), /PERSONAL_NOTIFICATION_SETTINGS_REFUSED/);
});

test('combined purchase and visit have independent claims across competing workers', async t => {
  const f = fixture(t);
  const action = {type: 'subscription', operationId: 'sale', clientId: 42, visit: {date, workoutId: 'one'}};
  f.rows[0].data.signature = JSON.stringify({action, personalNotificationsV1: [purchase, attended]});
  f.rows.splice(1);
  const request = f.raw.request;
  f.raw.request = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'POST' && args[3].text.startsWith('💳')) return {};
    return response;
  };
  await Promise.all([f.worker()(), f.worker()()]);
  assert.equal(f.posts.length, 2);
  assert.equal(f.ledger().status('sale:purchase'), 'uncertain');
  assert.equal(f.ledger().status('sale:attended'), 'sent');
});

test('notification settings require explicit enablement and are independent of poll enablement', () => {
  const env = {
    BOT_MODE: 'test', FIREBASE_PROJECT_ID: config.projectId, FITPP_DIRECT_ENABLED: 'true',
    AUTO_PUBLISH: 'false', TEST_ALLOW_SEND: 'false', TEST_ALLOW_EDIT: 'false', TEST_ALLOW_DELETE: 'false',
    FIREBASE_API_KEY: 'test', FIREBASE_BOT_UID: 'dedicated-bot', FIREBASE_BOT_EMAIL: 'test@example.test',
    FIREBASE_BOT_PASSWORD: 'test', TEST_EXPECTED_BOT_ID: String(botId), TEST_BOT_TOKEN: 'test',
    FITPP_PERSONAL_NOTIFICATIONS_ENABLED: 'true', FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION: '17',
    FITPP_PERSONAL_NOTIFICATION_STATE_DIR: '/tmp/local'
  };
  assert.equal(settings(env).start, 17);
  assert.throws(() => settings({...env, FITPP_PERSONAL_NOTIFICATIONS_ENABLED: 'false'}), /SETTINGS_REFUSED/);
  assert.throws(() => settings({...env, FITPP_NOTIFICATION_SUPERVISED: 'true'}), /SETTINGS_REFUSED/);
});
