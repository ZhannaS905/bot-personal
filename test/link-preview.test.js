const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHAT, body, guardedApi } = require('../src/memory-training-test');
const { MaxApi } = require('../src/api');

test('Training Test sends online preview suppression in query, keeps HTML/buttons on edit and leaves in-person sends unchanged', async () => {
  const calls = [];
  const api = await guardedApi({ token: 'offline', expectedId: '123', send: true, edit: true }, async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    const data = url.pathname === '/me' ? { user_id: 123, username: 'id623401053090_1_bot', is_bot: true }
      : url.pathname.endsWith('/members/me') ? { user_id: 123, is_bot: true }
      : url.pathname.startsWith('/chats/') ? { chat_id: Number(CHAT), title: 'ТАБАТА запись' }
      : { message: { body: { mid: 'owned' } } };
    return { ok: true, json: async () => data };
  });
  const poll = { id: 'test', date: '2026-10-24', votes: new Map() };
  await api.send(CHAT, body(poll), { disableLinkPreview: true });
  poll.votes.set(1, 'Елена');
  await api.edit('owned', body(poll));
  await api.send(CHAT, body({ ...poll, date: '2026-10-26' }));
  const [sent, edited, offline] = calls.slice(3);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url.searchParams.get('disable_link_preview'), 'true');
  assert.equal(sent.url.searchParams.get('chat_id'), CHAT);
  assert.equal(sent.body.format, 'html');
  assert.equal(Object.hasOwn(sent.body, 'disable_link_preview'), false);
  assert.equal(edited.method, 'PUT');
  // PUT /messages has no documented preview parameter. Keep its supported payload.
  assert.deepEqual([...edited.url.searchParams], [['message_id', 'owned']]);
  assert.deepEqual(edited.body, body(poll));
  assert.deepEqual(edited.body.attachments, sent.body.attachments);
  assert.equal(offline.url.searchParams.has('disable_link_preview'), false);
  assert.doesNotMatch(offline.body.text, /Ссылка|telemost/);
});

test('shared MAX client preserves default request for other callers', async () => {
  let query;
  const api = new MaxApi('offline', async (url) => {
    query = [...url.searchParams];
    return { ok: true, json: async () => ({ message: { body: { mid: 'id' } } }) };
  }, async () => {});
  await api.send('42', { text: 'unchanged' });
  assert.deepEqual(query, [['chat_id', '42']]);
});
