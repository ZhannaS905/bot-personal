'use strict';
// Dedicated test-workspace capability. Does not change the general bot write flags.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {MaxApi} = require('./api');
const {checkTestBotIdentity, identityAccepted} = require('./test-bot-identity');
const {validBinding} = require('./fitpp-notification-dry-run.cjs');
const BOT = '131384398';
function settings(env) {
  const token = env.TEST_BOT_TOKEN || env.BOT_TOKEN;
  if (env.BOT_MODE !== 'test' || env.FIREBASE_PROJECT_ID !== 'fitpp-test' ||
      env.TEST_EXPECTED_BOT_ID !== BOT || !token || /\s/.test(token) ||
      (env.TEST_BOT_TOKEN && env.BOT_TOKEN && env.TEST_BOT_TOKEN !== env.BOT_TOKEN) ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      ['AUTO_PUBLISH','TEST_ALLOW_SEND','TEST_ALLOW_EDIT','TEST_ALLOW_DELETE'].some(k => env[k] !== 'false'))
    throw Error('NOTIFICATION_SCOPE_REFUSED');
  return token;
}
async function verify(raw, binding, clientId) {
  if (clientId === undefined) {
    if(!binding||binding.version!==1||binding.botId!==Number(BOT)||!Array.isArray(binding.bindings)||
       binding.bindings.some(row=>row.notificationsEnabled&&(!/^demo-client-[1-4]$/.test(row.clientId)||!validBinding(binding,row.clientId))))throw Error('NOTIFICATION_BINDING_REFUSED');
    const enabled=binding.bindings.filter(row=>row.notificationsEnabled);
    if(!enabled.length&&!identityAccepted(checkTestBotIdentity(await raw.request('GET','/me'),BOT)))throw Error('NOTIFICATION_IDENTITY_REFUSED');
    for(const row of enabled)await verify(raw,binding,row.clientId);
    return;
  }
  if (!validBinding(binding,clientId) || !/^demo-client-[1-4]$/.test(clientId) ||
      binding.bindings.some(row => row.notificationsEnabled && !/^demo-client-[1-4]$/.test(row.clientId))) throw Error('NOTIFICATION_BINDING_REFUSED');
  if (!identityAccepted(checkTestBotIdentity(await raw.request('GET','/me'),BOT))) throw Error('NOTIFICATION_IDENTITY_REFUSED');
  const {maxChatId: CHAT, maxUserId: USER} = binding.bindings.find(row => row.clientId === clientId);
  const chat = await raw.request('GET','/chats/' + CHAT);
  if (chat.chat_id !== CHAT || chat.type !== 'dialog' || chat.status !== 'active' ||
      chat.dialog_with_user?.user_id !== USER || chat.dialog_with_user?.is_bot !== false)
    throw Error('NOTIFICATION_RECIPIENT_REFUSED');
}
// A separate file per operation is an exclusive, durable claim across processes/restarts.
// Claims are NEVER deleted/retried automatically, including timeout or uncertain success.
function reserve(directory, operationId) {
  const name = createHash('sha256').update('fitpp-test:synthetic-v1:' + operationId).digest('hex');
  const fd = (() => {try {return fs.openSync(path.join(directory,name),'wx',0o600)} catch(e) {if(e.code==='EEXIST')return null;throw e}})();
  if (fd === null) return false;
  try {fs.writeSync(fd,'attempted\n');fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
  const dir = fs.openSync(directory,'r');try {fs.fsyncSync(dir)} finally {fs.closeSync(dir)}
  return true;
}
function formatNotification(item) {
  const title = item.status === 'attended' ? '✅ Посещение' : '🔥 Занятие сгорело';
  const farewell = item.status === 'attended' ? '🫶 До встречи на следующей тренировке!' : '🫶 Ждём на следующей тренировке!';
  const warning = item.remaining === 1 ? '\n\n⚠️ Осталось последнее занятие!' : item.remaining === 0 ? '\n\n⚠️ Занятия по абонементу закончились.' : '';
  return `${title}\n\n📅 ${item.date.split('-').reverse().join('.')}\nС абонемента списано 1 занятие.\n\nОсталось занятий: ${item.remaining}${warning}\n\n${farewell}`;
}
function createSender({env, directory, raw}) {
  const token = settings(env);
  raw ||= new MaxApi(token);
  let tail = Promise.resolve();
  return {verify: binding => verify(raw,binding), send(item,binding) {
    const job = tail.then(async () => {
      if (!validBinding(binding,item?.clientId) || item.maxChatId !== binding.bindings.find(row => row.clientId === item.clientId).maxChatId ||
          !['attended','missed'].includes(item.status) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ||
          typeof item.workoutId !== 'string' || !item.workoutId ||
          !/^[a-zA-Z0-9-]{8,128}$/.test(item.operationId || '') ||
          !Number.isSafeInteger(item.remaining) || item.remaining < 0 || item.previous !== item.remaining + 1)
        throw Error('NOTIFICATION_CANDIDATE_REFUSED');
      await verify(raw,binding,item.clientId);
      // Current UI receipts identify confirmed transitions; one workout can change status.
      const unified = typeof item.receiptId === 'string' && item.receiptId.length > 0 &&
        item.receiptId.length <= 128 && Number.isSafeInteger(item.receiptRevision) && item.receiptRevision > 0;
      const operationKey = unified ? 'attendance-ui-v1:' + item.receiptId : item.operationId;
      const visitKey = unified ? 'visit-ui-v1:' + JSON.stringify([item.clientId,item.workoutId,item.receiptId])
        : 'visit:' + JSON.stringify([item.clientId,item.workoutId]);
      if (!reserve(directory,operationKey)) return 'duplicate';
      if (!reserve(directory,visitKey)) return 'duplicate';
      try {
        await raw.send(String(item.maxChatId),{text:formatNotification(item),notify:false});
        return 'sent';
      } catch {return 'uncertain'}
    });
    tail = job.catch(()=>{});return job;
  }};
}
// Separate capability: existing attendance formatting/validation stays unchanged.
function createExpirySender({env,directory,raw}) {
  const token=settings(env); raw ||= new MaxApi(token);
  const {expiryTime,formatExpiry}=require('./fitpp-subscription-notifications.cjs');
  return {async send(item,binding,now=Date.now()) {
    if(item?.kind!=='expiry' || !/^demo-client-[1-4]$/.test(item.clientId) ||
       typeof item.subscriptionId!=='string' || !item.subscriptionId ||
       !validBinding(binding,item.clientId) ||
       item.maxChatId!==binding.bindings.find(b=>b.clientId===item.clientId).maxChatId ||
       !Number.isFinite(expiryTime(item.expires)) || now<expiryTime(item.expires) ||
       now-expiryTime(item.expires)>45000) throw Error('EXPIRY_CANDIDATE_REFUSED');
    const text=formatExpiry(item);
    await verify(raw,binding,item.clientId);
    // Date-based claim intentionally suppresses any return to a previous expiry date.
    if(!reserve(directory,'expiry-v1:'+JSON.stringify([item.clientId,item.subscriptionId,item.expires])))return 'duplicate';
    try {await raw.send(String(item.maxChatId),{text,notify:false});return 'sent'}
    catch {return 'uncertain'}
  }};
}
module.exports = {settings,verify,reserve,createSender,createExpirySender,formatNotification};
