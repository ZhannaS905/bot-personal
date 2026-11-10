'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Service, body } = require('../src/service');
const { TelegramBridge } = require('../src/telegram-bridge');

function setupTest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiplatform-sync-'));
  const store = new Store(dir);
  const now = new Date('2026-10-19T07:00:00Z'); // Monday 10:00 MSK

  const maxCalls = { send: [], edit: [] };
  const mockMaxApi = {
    send: async (chat, body) => {
      maxCalls.send.push({ chat, body });
      return `max-mid-${maxCalls.send.length}`;
    },
    edit: async (mid, body) => {
      maxCalls.edit.push({ mid, body });
      return { success: true };
    }
  };

  const tgCalls = { send: [], edit: [], deleteMessage: [], answerCallback: [] };
  const mockTgApi = {
    send: async (chatId, message, opts) => {
      tgCalls.send.push({ chatId, message, opts });
      return 1001 + tgCalls.send.length;
    },
    edit: async (chatId, messageId, message, opts) => {
      tgCalls.edit.push({ chatId, messageId, message, opts });
      return { ok: true };
    },
    deleteMessage: async (chatId, messageId) => {
      tgCalls.deleteMessage.push({ chatId, messageId });
      return true;
    },
    answerCallback: async (id, text) => {
      tgCalls.answerCallback.push({ id, text });
      return true;
    }
  };

  const bridge = new TelegramBridge({
    token: 'test:token',
    chatId: '-100999888',
    adminIds: ['777'],
    stateDir: dir,
    api: mockTgApi
  });

  const config = {
    chatIds: ['-1'],
    adminIds: ['9']
  };

  const service = new Service(store, mockMaxApi, config, () => now, bridge);

  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { store, service, bridge, maxCalls, tgCalls, now };
}

test('Multiplatform sync: MAX and Telegram publish and synchronize votes in real-time', async t => {
  const { service, maxCalls, tgCalls } = setupTest(t);

  // 1. Initial tick publishes to MAX and Telegram
  await service.tick();

  assert.equal(maxCalls.send.length, 1);
  assert.equal(maxCalls.send[0].chat, '-1');
  assert.equal(tgCalls.send.length, 1);
  assert.equal(tgCalls.send[0].chatId, '-100999888');

  // Both start with empty participant list
  assert.match(maxCalls.send[0].body.text, /Пока никто не записался/);
  assert.match(tgCalls.send[0].message.text, /Пока никто не записался/);

  // 2. User votes in Telegram (Алексей Иванов)
  const tgPoll = Object.values(service.store.state.polls)[0];
  const tgUpdate = {
    update_type: 'message_callback',
    callback: {
      callback_id: 'tg_cb_1',
      user: { user_id: 12345, first_name: 'Алексей', last_name: 'Иванов' },
      payload: `poll:${tgPoll.id}:yes`
    },
    message: {
      recipient: { chat_id: -1 },
      body: { mid: tgPoll.mid }
    }
  };

  service.receive(tgUpdate);
  await service.drain();
  await service.refresh();

  // Both platforms edited with Алексей Иванов
  assert.equal(maxCalls.edit.length, 1);
  assert.match(maxCalls.edit[0].body.text, /1\. Алексей Иванов/);
  assert.equal(tgCalls.edit.length, 1);
  assert.match(tgCalls.edit[0].message.text, /1\. Алексей Иванов/);

  // 3. Another user votes in MAX (Мария Смирнова)
  const maxUpdate = {
    update_type: 'message_callback',
    callback: {
      callback_id: 'max_cb_1',
      user: { user_id: 67890, first_name: 'Мария', last_name: 'Смирнова' },
      payload: `poll:${tgPoll.id}:yes`
    },
    message: {
      recipient: { chat_id: -1 },
      body: { mid: tgPoll.mid }
    }
  };

  service.receive(maxUpdate);
  await service.drain();
  await service.refresh();

  // Both platforms updated with unified list of 2 participants!
  assert.equal(maxCalls.edit.length, 2);
  assert.match(maxCalls.edit[1].body.text, /1\. Алексей Иванов\n2\. Мария Смирнова/);
  assert.equal(tgCalls.edit.length, 2);
  assert.match(tgCalls.edit[1].message.text, /1\. Алексей Иванов\n2\. Мария Смирнова/);

  // 4. Telegram user cancels vote
  const cancelUpdate = {
    update_type: 'message_callback',
    callback: {
      callback_id: 'tg_cb_2',
      user: { user_id: 12345, first_name: 'Алексей', last_name: 'Иванов' },
      payload: `poll:${tgPoll.id}:cancel`
    },
    message: {
      recipient: { chat_id: -1 },
      body: { mid: tgPoll.mid }
    }
  };

  service.receive(cancelUpdate);
  await service.drain();
  await service.refresh();

  // Both platforms updated: only Мария Смирнова remains
  assert.equal(maxCalls.edit.length, 3);
  assert.match(maxCalls.edit[2].body.text, /1\. Мария Смирнова/);
  assert.doesNotMatch(maxCalls.edit[2].body.text, /Алексей Иванов/);
  assert.equal(tgCalls.edit.length, 3);
  assert.match(tgCalls.edit[2].message.text, /1\. Мария Смирнова/);
  assert.doesNotMatch(tgCalls.edit[2].message.text, /Алексей Иванов/);
});
