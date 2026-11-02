'use strict';

const {createWebhook} = require('./memory-test-webhook');
const {config, guardedApi} = require('./memory-training-test');

async function start({
  autopost,
  contact,
  owner,
  secret,
  port = 3000,
  host = '0.0.0.0',
  log = console.log,
  env = process.env,
  verify = guardedApi
}) {
  if (!autopost || typeof autopost.receive !== 'function') {
    throw Error('CALENDAR_HANDLER_REQUIRED');
  }

  const identity = config(env);
  if (secret !== identity.secret) throw Error('WEBHOOK_SECRET_MISMATCH');
  await verify(identity);

  const incoming = {
    async receive(update) {
      if (await autopost.receive(update)) return;
      if (contact &&
          (update?.update_type === 'bot_started' ||
           update?.message?.recipient?.chat_type === 'dialog')) {
        await contact.receive(update);
        return;
      }
      if (owner) await owner.receive(update);
    }
  };

  const server = createWebhook(incoming, secret, {
    log: entry => log(JSON.stringify(entry))
  });

  const webhookHandler = server.listeners('request')[0];
  server.removeAllListeners('request');

  server.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        ready: true,
        mode: 'training-test-calendar',
        autopostEnabled: true
      }));
      return;
    }
    void webhookHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  let stopAutopost;
  try {
    stopAutopost = require('./training-test-autopost').attach(autopost);
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  server.stopAutopost = stopAutopost;

  return server;
}

module.exports = {start};
