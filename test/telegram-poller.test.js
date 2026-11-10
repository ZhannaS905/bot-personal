'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramPoller } = require('../src/telegram-poller');

test('TelegramPoller processes messages and callbacks and advances offset', async () => {
  const updates = [
    {
      update_id: 101,
      message: { message_id: 1, chat: { id: -1001, title: 'Chat 1' }, text: '/опрос', from: { id: 777 } }
    },
    {
      update_id: 102,
      callback_query: { id: 'cb_1', from: { id: 888, first_name: 'Анна' }, data: 'poll:uuid:yes' }
    }
  ];

  let callCount = 0;
  const mockApi = {
    getUpdates: async (offset) => {
      callCount++;
      if (callCount === 1) {
        assert.equal(offset, 0);
        return updates;
      }
      return [];
    }
  };

  const messages = [];
  const callbacks = [];
  const poller = new TelegramPoller({
    api: mockApi,
    onMessage: async (msg) => { messages.push(msg); },
    onCallback: async (cb) => { callbacks.push(cb); },
    interval: 5
  });

  poller.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await poller.stop();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '/опрос');
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].data, 'poll:uuid:yes');
  assert.equal(poller.offset, 103);
});
