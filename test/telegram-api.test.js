'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramApi } = require('../src/telegram-api');

test('TelegramApi validates token', () => {
  assert.throws(() => new TelegramApi(''), /Telegram token required/);
  assert.throws(() => new TelegramApi(null), /Telegram token required/);
});

test('TelegramApi send converts attachments to Telegram inline keyboard and sends HTML', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } })
    };
  };

  const api = new TelegramApi('123:ABC', fakeFetch, async () => {});
  const message = {
    text: '<b>Заголовок</b>\nСписок участников',
    format: 'html',
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: '✅ Приду', payload: 'poll:123:yes' },
          { type: 'callback', text: '↩️ Отменить', payload: 'poll:123:cancel' }
        ]]
      }
    }]
  };

  const mid = await api.send('-100123456789', message);
  assert.equal(mid, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(calls[0].body.chat_id, '-100123456789');
  assert.equal(calls[0].body.text, '<b>Заголовок</b>\nСписок участников');
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.deepEqual(calls[0].body.reply_markup, {
    inline_keyboard: [[
      { text: '✅ Приду', callback_data: 'poll:123:yes' },
      { text: '↩️ Отменить', callback_data: 'poll:123:cancel' }
    ]]
  });
});

test('TelegramApi edit ignores "message is not modified" error gracefully', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' })
  });

  const api = new TelegramApi('123:ABC', fakeFetch, async () => {});
  const res = await api.edit('-100123456789', 42, { text: 'Тот же текст' });
  assert.equal(res.notModified, true);
});

test('TelegramApi answerCallback calls answerCallbackQuery', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };

  const api = new TelegramApi('123:ABC', fakeFetch, async () => {});
  await api.answerCallback('cb_12345', 'Обработано');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:ABC/answerCallbackQuery');
  assert.equal(calls[0].body.callback_query_id, 'cb_12345');
  assert.equal(calls[0].body.text, 'Обработано');
});

test('TelegramApi payload mapping prevents >64 byte callback_data', async () => {
  const api = new TelegramApi('123:ABC', async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }), async () => {});
  const longPayload = 'cal:' + 'a'.repeat(64) + ':' + 'b'.repeat(36) + ':yes';
  
  // Custom transformer
  const map = new Map();
  const transformer = (p) => {
    if (p.length > 64) {
      const short = 'c:' + p.slice(-40);
      map.set(short, p);
      return short;
    }
    return p;
  };

  const attachments = [{
    type: 'inline_keyboard',
    payload: {
      buttons: [[
        { type: 'callback', text: 'Кнопка', payload: longPayload }
      ]]
    }
  }];

  const markup = api.formatKeyboard(attachments, transformer);
  assert.ok(markup.inline_keyboard[0][0].callback_data.length <= 64);
});
