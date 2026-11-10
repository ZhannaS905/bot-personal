const { loadConfig } = require('./config');
const { Store } = require('./src/store');
const { MaxApi } = require('./src/api');
const { Service } = require('./src/service');
const { createWebhook } = require('./src/webhook');
const { TelegramBridge } = require('./src/telegram-bridge');

function main() {
  const config = loadConfig();
  const store = new Store(config.stateDir);

  let telegramBridge = null;
  if (config.telegram) {
    telegramBridge = new TelegramBridge({
      token: config.telegram.token,
      chatId: config.telegram.chatId,
      adminIds: config.telegram.adminIds,
      stateDir: config.stateDir
    });
  }

  const service = new Service(store, new MaxApi(config.token), config, undefined, telegramBridge);
  const server = createWebhook(service, config.secret);
  let stopping = false;

  if (telegramBridge) {
    telegramBridge.start({
      onAdminPoll: async () => {
        for (const chat of config.chatIds) {
          await service.run(() => service.publish(chat));
        }
      },
      onCallback: async (syntheticUpdate) => {
        service.receive(syntheticUpdate);
        await service.run(() => service.tick());
      },
      getActivePoll: async () => {
        const today = require('./src/schedule').moscow(new Date()).date;
        for (const chat of config.chatIds) {
          const p = store.state.polls[`${chat}/${today}`];
          if (p) return p;
        }
        return null;
      }
    });
  }

  const tick = async () => {
    if (stopping) return;
    try { await service.run(() => service.tick()); }
    catch { console.error('Processing failed; inspect local state without exposing secrets.'); if (store.failed) stop(); }
    if (!stopping) timer = setTimeout(tick, 1000);
  };
  let timer;
  server.listen(config.port, '127.0.0.1', tick);
  const stop = () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    if (telegramBridge) telegramBridge.stop();
    server.close(async () => { await service.queue; store.close(); });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.on('error', () => { console.error('Webhook listener failed'); stop(); });
}
if (require.main === module) main();
module.exports = { main };
