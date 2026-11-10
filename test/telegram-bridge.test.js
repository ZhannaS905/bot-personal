'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TelegramBridge } = require('../src/telegram-bridge');

test('TelegramBridge payload compacting and expansion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-'));
  const bridge = new TelegramBridge({
    token: 'test:token',
    chatId: '-100999',
    stateDir: dir
  });

  const fullPayload = 'cal:3f982189d81643ab87140f823e20e8b23f982189d81643ab87140f823e20e8b2:11223344-5566-7788-9900-aabbccddeeff:yes';
  const compacted = bridge.transformPayloadForTelegram(fullPayload);

  assert.equal(compacted, 'c:11223344-5566-7788-9900-aabbccddeeff:yes');
  assert.ok(compacted.length <= 64);

  const restored = bridge.expandTelegramPayload(compacted);
  assert.equal(restored, fullPayload);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('TelegramBridge sendCalendar and editCalendar track message ID and call TelegramApi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-'));
  const calls = { send: [], edit: [] };
  const mockApi = {
    send: async (chatId, msg, opts) => {
      calls.send.push({ chatId, msg, opts });
      return 555;
    },
    edit: async (chatId, mid, msg, opts) => {
      calls.edit.push({ chatId, mid, msg, opts });
      return { ok: true };
    }
  };

  const bridge = new TelegramBridge({
    token: 'test:token',
    chatId: '-100999',
    stateDir: dir,
    api: mockApi
  });

  const poll = {
    id: 'poll-uuid-1',
    key: 'workout-key-1',
    workout: { date: '2026-11-10', time: '20:00' }
  };
  const message = {
    text: 'Опрос на тренировку',
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons: [[{ text: '✅ Приду', payload: 'cal:key1:poll-uuid-1:yes' }]] }
    }]
  };

  const msgId = await bridge.sendCalendar(poll, message);
  assert.equal(msgId, 555);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].chatId, '-100999');

  // Edit poll
  const updatedMessage = {
    text: 'Опрос обновлен',
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons: [[{ text: '✅ Приду', payload: 'cal:key1:poll-uuid-1:yes' }]] }
    }]
  };
  const edited = await bridge.editCalendar(poll, updatedMessage);
  assert.equal(edited, true);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].mid, 555);

  fs.rmSync(dir, { recursive: true, force: true });
});
