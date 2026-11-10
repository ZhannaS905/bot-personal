'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createWorker } = require('../src/fitpp-personal/notifications');
const { openLedger } = require('../src/fitpp-personal/notification-ledger');
const { TelegramBindings } = require('../src/telegram-bindings');
const config = require('../src/fitpp-personal/runtime-config');

const botId = 123;
const date = '2026-11-06';
const subscriptionId = 'subscription-sale';
const purchase = { kind: 'purchase', subscriptionId, sessions: 8, remaining: 8, expires: '2026-12-04' };
const attended = { kind: 'attended', workoutId: 'one', visitId: 'mark-one', date, subscriptionId, remaining: 7 };
const missed = { kind: 'missed', workoutId: 'two', visitId: 'mark-two', date, subscriptionId, remaining: 6 };

function receipt(id, revision, event) {
  const type = event.kind === 'purchase' ? 'subscription' : 'attendance';
  const action = { type, operationId: id, clientId: 42, status: event.kind, workoutId: event.workoutId, date };
  return { id, data: { type, revision, signature: JSON.stringify({ action, personalNotificationsV1: [event] }) } };
}

test('createWorker delivers purchase, attended, and missed notifications to Telegram', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-receipt-notif-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const ledger = openLedger(dir, { start: 0, scope: 'tg-fixture' });
  const rows = [receipt('sale', 1, purchase), receipt('visit', 2, attended), receipt('miss', 3, missed)];
  const state = {
    ownerUid: config.ownerUid,
    datasetId: 'personal-v1',
    schemaVersion: 1,
    _fitppRevision: 3,
    clients: [{ id: 42, subscriptions: [{ id: subscriptionId, left: 6 }] }],
    workouts: { one: { id: 'one', date }, two: { id: 'two', date } },
    visits: { one: { 42: 'attended' }, two: { 42: 'missed' } },
    visitOps: {
      one: { 42: { operationId: 'mark-one', status: 'attended', subscriptionId } },
      two: { 42: { operationId: 'mark-two', status: 'missed', subscriptionId } }
    }
  };

  // No MAX bindings - this client is only linked in Telegram!
  const registry = { version: 1, botId, bindings: [] };
  const source = {
    receipts: async (cursor) => ({ rows: rows.filter(r => r.data.revision > cursor), through: 3 }),
    context: async () => ({ state, registry })
  };

  const raw = {
    async request(method, endpoint) {
      if (method === 'GET' && endpoint === '/me') {
        return { user_id: botId, username: 'id623401053090_1_bot', is_bot: true };
      }
      return { message: { body: { mid: 'max-test' } } };
    }
  };

  const tgBindings = new TelegramBindings(join(dir, 'telegram-bindings.json'));
  tgBindings.bind('777888', {
    clientId: '42',
    name: 'Тестовый Клиент',
    chatId: '777888'
  });

  const tgSends = [];
  const mockTelegramApi = {
    send: async (chatId, message) => {
      tgSends.push({ chatId, message });
      return { message_id: 500 + tgSends.length };
    }
  };

  const reports = [];
  const worker = createWorker({
    botId,
    source,
    ledger,
    raw,
    telegramApi: mockTelegramApi,
    telegramBindings: tgBindings,
    report: s => reports.push(s)
  });

  await worker();

  // All three events must be delivered to Telegram
  assert.equal(tgSends.length, 3);
  assert.equal(reports.filter(r => r === 'sent').length, 3);

  // 1. Purchase
  assert.equal(tgSends[0].chatId, '777888');
  assert.match(tgSends[0].message.text, /💳 Покупка абонемента/);
  assert.match(tgSends[0].message.text, /🎟 8 занятий/);
  assert.match(tgSends[0].message.text, /📅 Действует до 04\.12\.2026/);
  assert.match(tgSends[0].message.text, /Осталось занятий: 8/);

  // 2. Attendance
  assert.equal(tgSends[1].chatId, '777888');
  assert.match(tgSends[1].message.text, /✅ Посещение/);
  assert.match(tgSends[1].message.text, /📅 06\.11\.2026/);
  assert.match(tgSends[1].message.text, /С абонемента списано 1 занятие/);
  assert.match(tgSends[1].message.text, /Осталось занятий: 7/);

  // 3. Missed
  assert.equal(tgSends[2].chatId, '777888');
  assert.match(tgSends[2].message.text, /❌ Занятие сгорело/);
  assert.match(tgSends[2].message.text, /Осталось занятий: 6/);
  assert.match(tgSends[2].message.text, /🫶 Ждём на следующей тренировке!/);
});
