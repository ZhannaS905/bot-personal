'use strict';

const {createRequire} = require('node:module');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const {connect, settings: sessionSettings} = require('../fitpp-direct-session');
const {MaxApi} = require('../api');
const {projectId, root} = require('./runtime-config');
const {createWorker} = require('./notifications');
const {createCoachSummaryWorker} = require('./coach-summary');
const {openLedger} = require('./notification-ledger');

function settings(env) {
  const token = env.TEST_BOT_TOKEN || env.BOT_TOKEN;
  const botId = Number(env.TEST_EXPECTED_BOT_ID);
  const start = Number(env.FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION);
  if (env.FITPP_PERSONAL_NOTIFICATIONS_ENABLED !== 'true' || env.FIREBASE_PROJECT_ID !== projectId ||
      env.FITPP_NOTIFICATION_SUPERVISED === 'true' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      typeof token !== 'string' || !token || /\s/.test(token) ||
      (env.TEST_BOT_TOKEN && env.BOT_TOKEN && env.TEST_BOT_TOKEN !== env.BOT_TOKEN) ||
      !Number.isSafeInteger(botId) || botId <= 0 || String(botId) !== env.TEST_EXPECTED_BOT_ID ||
      !Number.isSafeInteger(start) || start < 0 || String(start) !== env.FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION ||
      !env.FITPP_PERSONAL_NOTIFICATION_STATE_DIR) throw Error('PERSONAL_NOTIFICATION_SETTINGS_REFUSED');
  sessionSettings(env, {notificationsOnly: true});
  const scope = createHash('sha256').update(JSON.stringify([projectId, root, botId])).digest('hex');
  const coachSummaryEnabled = env.FITPP_COACH_SUMMARY_ENABLED === 'true';
  const coachUserId = env.COACH_MAX_USER_ID || env.TEST_ADMIN_IDS || '5819064';
  const coachChatId = env.COACH_CHAT_ID;
  const leadTimeMinutes = Number(env.COACH_SUMMARY_LEAD_MINUTES || '120');
  return {
    token, botId, start, scope, directory: env.FITPP_PERSONAL_NOTIFICATION_STATE_DIR,
    coachSummaryEnabled, coachUserId, coachChatId, leadTimeMinutes
  };
}

async function main(env = process.env) {
  const config = settings(env);
  const ledger = openLedger(config.directory, config);
  const load = createRequire(join(__dirname, '../../direct-sdk/package.json'));
  const sdk = {...load('firebase/app'), ...load('firebase/auth'), ...load('firebase/firestore')};
  sdk.setLogLevel('silent');
  const {source, close} = await connect({env, sdk, notificationsOnly: true});
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const raw = new MaxApi(config.token);
  let telegramApi = null;
  if (env.TELEGRAM_BOT_TOKEN) {
    const { TelegramApi } = require('../telegram-api');
    telegramApi = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  }
  const { getTelegramBindings } = require('../telegram-bindings');
  const telegramBindings = getTelegramBindings(config.directory || env.STATE_DIR || 'data');
  const tick = createWorker({
    ...config,
    source,
    ledger,
    raw,
    telegramApi,
    telegramBindings,
    report: status => console.log('PERSONAL_NOTIFICATION ' + status)
  });
  const tickCoachSummary = config.coachSummaryEnabled
    ? createCoachSummaryWorker({
        ...config,
        raw,
        source: {forDate: d => source.summaryData(d)},
        ledger,
        report: status => console.log('COACH_SUMMARY ' + status)
      })
    : null;
  try {
    while (!stop.signal.aborted) {
      try { await tick(); }
      catch { console.error('PERSONAL_NOTIFICATION_TICK_FAILED'); }
      if (tickCoachSummary) {
        try { await tickCoachSummary(); }
        catch { console.error('COACH_SUMMARY_TICK_FAILED'); }
      }
      await sleep(10000, undefined, {signal: stop.signal}).catch(() => {});
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await close();
  }
}

if (require.main === module) main().catch(() => {
  console.error('PERSONAL_NOTIFICATION_STARTUP_FAILED');
  process.exitCode = 1;
});
module.exports = {settings};
