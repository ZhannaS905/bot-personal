'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TelegramBridge } = require('../src/telegram-bridge');
const { TelegramBindings } = require('../src/telegram-bindings');

test('Telegram contact linking: /start, contact sharing, ownership check and binding', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-contact-linking-'));
  const bindingsFile = path.join(dir, 'telegram-bindings.json');
  const bindings = new TelegramBindings(bindingsFile);

  const sentMessages = [];
  const mockApi = {
    getUpdates: async () => [],
    send: async (chatId, message, opts) => {
      sentMessages.push({ chatId, message, opts });
      return { message_id: 100 + sentMessages.length };
    }
  };

  const clients = [
    { id: 'client-1', name: 'Иван Петров', phone: '+7 (999) 111-22-33' },
    { id: 'client-2', name: 'Анна Сидорова', phone: '89992223344' }
  ];

  const clientFinder = async (normPhone) => {
    const { phone } = require('../src/contact-linking');
    return clients.find(c => phone(c.phone) === normPhone) || null;
  };

  const bridge = new TelegramBridge({
    token: 'test-token',
    chatId: '-100123456789',
    adminIds: ['999'],
    stateDir: dir,
    api: mockApi,
    bindings,
    clientFinder
  });

  t.after(async () => {
    await bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  bridge.start();
  const onMessage = bridge.poller.onMessage;

  // 1. User sends /start in private chat
  await onMessage({
    chat: { id: 555, type: 'private' },
    from: { id: 555, first_name: 'Ivan' },
    text: '/start'
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, '555');
  assert.match(sentMessages[0].message.text, /Поделитесь своим номером телефона/);
  assert.equal(sentMessages[0].message.reply_markup.keyboard[0][0].request_contact, true);

  // 2. Security check: User tries to share someone else's contact
  await onMessage({
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    contact: {
      user_id: 777, // different user_id!
      phone_number: '+79991112233',
      first_name: 'Hacker'
    }
  });

  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].message.text, /Пожалуйста, поделитесь своим собственным номером/);
  assert.equal(bindings.getClientId('555'), null);

  // 3. User shares unknown phone number
  await onMessage({
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    contact: {
      user_id: 555,
      phone_number: '+79990000000',
      first_name: 'Unknown'
    }
  });

  assert.equal(sentMessages.length, 3);
  assert.match(sentMessages[2].message.text, /не найден среди клиентов FitPP Personal/);
  assert.equal(bindings.getClientId('555'), null);

  // 4. User shares their legitimate registered phone number
  await onMessage({
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    contact: {
      user_id: 555,
      phone_number: '+79991112233',
      first_name: 'Ivan'
    }
  });

  assert.equal(sentMessages.length, 4);
  assert.match(sentMessages[3].message.text, /Привязка успешно сохранена/);
  assert.match(sentMessages[3].message.text, /Иван Петров/);

  // Verify binding persisted
  assert.equal(bindings.getClientId('555'), 'client-1');
  assert.equal(bindings.getTgUserId('client-1'), '555');
  assert.equal(bindings.getRecord('555').name, 'Иван Петров');

  // 5. Subsequent /start informs user they are already linked
  await onMessage({
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    text: '/start'
  });

  assert.equal(sentMessages.length, 5);
  assert.match(sentMessages[4].message.text, /Здравствуйте, <b>Иван Петров<\/b>!/);
  assert.match(sentMessages[4].message.text, /уже привязан к профилю FitPP Personal/);

  // 6. sendPersonal delivers via Telegram using clientId
  const sent = await bridge.sendPersonal('client-1', 'Ваш абонемент продлён!');
  assert.equal(sent, true);
  assert.equal(sentMessages.length, 6);
  assert.equal(sentMessages[5].chatId, '555');
  assert.equal(sentMessages[5].message.text, 'Ваш абонемент продлён!');
});
