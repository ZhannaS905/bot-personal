'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {start} = require('../src/training-test-http-server');

test('calendar webhook: health, security and callback routing', async () => {
  const received = [];
  const server = await start({
    autopost: {
      async receive(update) {
        received.push(update);
        return true;
      },
      async tick() {},
      async close() {},
      log() {}
    },
    secret: 'local-test-secret-123456',
    env: {
      BOT_MODE: 'test',
      CHAT_IDS: '-80345864298680',
      TEST_BOT_TOKEN: 'local-test-token',
      TEST_EXPECTED_BOT_ID: '123456',
      WEBHOOK_SECRET: 'local-test-secret-123456'
    },
    verify: async () => {},
    port: 0,
    host: '127.0.0.1',
    log: () => {}
  });

  try {
    const {port} = server.address();
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ready, true);

    const rejected = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: {'x-max-bot-api-secret': 'wrong'},
      body: '{}'
    });
    assert.equal(rejected.status, 403);

    const update = {
      update_type: 'message_callback',
      callback: {payload: 'cal:test:yes'}
    };

    const accepted = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: {'x-max-bot-api-secret': 'local-test-secret-123456'},
      body: JSON.stringify(update)
    });

    assert.equal(accepted.status, 200);
    assert.deepEqual(received, [update]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.stopAutopost();
  }
});

test('server refuses startup when MAX identity verification fails', async () => {
  const assert = require('node:assert/strict');

  await assert.rejects(
    start({
      autopost: {receive: async () => true},
      secret: 'local-test-secret-123456',
      port: 0,
      host: '127.0.0.1',
      env: {
        BOT_MODE: 'test',
        CHAT_IDS: '-80345864298680',
        TEST_BOT_TOKEN: 'local-test-token',
        TEST_EXPECTED_BOT_ID: '123456',
        WEBHOOK_SECRET: 'local-test-secret-123456'
      },
      verify: async () => {
        throw Error('TEST_IDENTITY_REFUSED');
      }
    }),
    /TEST_IDENTITY_REFUSED/
  );
});

test('calendar server closes listener if autopost attachment fails', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const serverPath = require.resolve('../src/training-test-http-server');
  let openedServer;

  Module._load = function(request, parent, isMain) {
    if (parent?.filename === serverPath &&
        request === './training-test-autopost') {
      return {attach() {throw Error('ATTACH_FAILED')}};
    }
    if (parent?.filename === serverPath &&
        request === './memory-test-webhook') {
      const http = require('node:http');
      return {createWebhook() {
        openedServer = http.createServer((_req, res) => res.end());
        return openedServer;
      }};
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    delete require.cache[serverPath];
    const {start: isolatedStart} = require(serverPath);

    await assert.rejects(isolatedStart({
      autopost: {receive: async () => true},
      secret: 'local-test-secret-123456',
      env: {
        BOT_MODE: 'test',
        CHAT_IDS: '-80345864298680',
        TEST_BOT_TOKEN: 'local-test-token',
        TEST_EXPECTED_BOT_ID: '123456',
        WEBHOOK_SECRET: 'local-test-secret-123456'
      },
      verify: async () => {},
      port: 0,
      host: '127.0.0.1'
    }), /ATTACH_FAILED/);

    assert.ok(openedServer, 'HTTP listener was created');
    assert.equal(openedServer.listening, false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[serverPath];
    if (openedServer?.listening) {
      await new Promise(resolve => openedServer.close(resolve));
    }
  }
});
