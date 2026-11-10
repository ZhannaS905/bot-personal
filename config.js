const path = require('node:path');
function ids(value) {
  const result = (value || '').split(',').map(x => x.trim()).filter(Boolean);
  if (result.some(x => !/^-?[1-9]\d*$/.test(x) || !Number.isSafeInteger(Number(x)))) throw new Error('Invalid ID list');
  return [...new Set(result)];
}
function loadConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must be enabled');
  if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET || '')) throw new Error('BOT_TOKEN and WEBHOOK_SECRET required');
  const adminIds = ids(env.ADMIN_IDS), chatIds = ids(env.CHAT_IDS);
  if (!adminIds.length || !chatIds.length) throw new Error('ADMIN_IDS and CHAT_IDS required');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

  const telegramToken = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.trim() : null;
  const telegramChatId = env.TELEGRAM_CHAT_ID ? env.TELEGRAM_CHAT_ID.trim() : null;
  const telegramAdminIds = env.TELEGRAM_ADMIN_IDS ? ids(env.TELEGRAM_ADMIN_IDS) : [];

  return {
    token: env.BOT_TOKEN,
    secret: env.WEBHOOK_SECRET,
    adminIds,
    chatIds,
    port,
    stateDir: path.resolve(env.STATE_DIR || 'data'),
    telegram: telegramToken ? {
      token: telegramToken,
      chatId: telegramChatId,
      adminIds: telegramAdminIds
    } : null
  };
}
module.exports = { loadConfig, ids };
