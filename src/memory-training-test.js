const { randomUUID } = require('node:crypto');
const { MaxApi } = require('./api');
const { moscow, times } = require('./schedule');
const { checkTestBotIdentity, identityAccepted } = require('./test-bot-identity');
const { TestPublicationAttempts } = require('./test-publication-attempts');
const CHAT = '-79450912874680';
function config(env) {
  if (env.BOT_MODE !== 'test' || env.CHAT_IDS !== CHAT) throw Error('TEST_CONFIG');
  const token = env.TEST_BOT_TOKEN || env.BOT_TOKEN;
  if (!token || /\s/.test(token) || (env.BOT_TOKEN && env.TEST_BOT_TOKEN && env.BOT_TOKEN !== token)) throw Error('TEST_TOKEN_REQUIRED');
  if (!/^[1-9]\d*$/.test(env.TEST_EXPECTED_BOT_ID || '')) throw Error('EXPECTED_ID_REQUIRED');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET || '')) throw Error('WEBHOOK_SECRET_REQUIRED');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('TLS_REQUIRED');
  const flag = key => { if (env[key] && !['true','false'].includes(env[key])) throw Error('TEST_CONFIG'); return env[key] === 'true'; };
  const admins = (env.TEST_ADMIN_IDS || '').split(',').map(x => x.trim());
  if (env.TEST_ADMIN_IDS && admins.some(x => !/^[1-9]\d*$/.test(x))) throw Error('TEST_ADMIN_IDS_INVALID');
  return { admins: admins.filter(Boolean), token, expectedId: env.TEST_EXPECTED_BOT_ID, secret: env.WEBHOOK_SECRET,
    send: flag('TEST_ALLOW_SEND'), edit: flag('TEST_ALLOW_EDIT'), remove: flag('TEST_ALLOW_DELETE'), auto: flag('AUTO_PUBLISH') };
}
async function guardedApi(c, fetchImpl, { pollScope } = {}) {
  const raw = new MaxApi(c.token, fetchImpl);
  const me = await raw.request('GET', '/me');
  if (!identityAccepted(checkTestBotIdentity(me, c.expectedId))) throw Error('TEST_IDENTITY_REFUSED');
  const chat = await raw.request('GET', `/chats/${CHAT}`);
  if (String(chat.chat_id) !== CHAT || chat.title !== 'ТАБАТА запись') throw Error('TEST_CHAT_REFUSED');
  const member = await raw.request('GET', `/chats/${CHAT}/members/me`);
  if (member.user_id !== me.user_id || member.is_bot !== true) throw Error('TEST_MEMBERSHIP_REFUSED');
  if (pollScope && (pollScope.chat !== CHAT || !/^mid\.[a-zA-Z0-9]+$/.test(pollScope.mid || '') || !/^[a-f0-9-]{36}$/.test(pollScope.uuid || ''))) throw Error('POLL_SCOPE_REFUSED');
  async function pollMessage() {
    if (!pollScope) throw Error('POLL_SCOPE_REFUSED');
    const message = await raw.request('GET', '/messages/' + encodeURIComponent(pollScope.mid));
    if (message?.body?.mid !== pollScope.mid || String(message?.recipient?.chat_id) !== CHAT || message?.sender?.user_id !== me.user_id || message?.sender?.is_bot !== true) throw Error('POLL_MESSAGE_REFUSED');
    const keyboards = (message.body.attachments || []).filter(a => a.type === 'inline_keyboard');
    const buttons = keyboards.flatMap(a => (a.payload?.buttons || []).flat());
    const expected = ['poll:' + pollScope.uuid + ':yes', 'poll:' + pollScope.uuid + ':cancel'];
    if (keyboards.length !== 1 || buttons.length !== 2 || buttons.some(b => b.type !== 'callback') || !expected.every(p => buttons.filter(b => b.payload === p).length === 1)) throw Error('POLL_BUTTONS_REFUSED');
    return message;
  }
  async function checkedPollEdit(text,{skipUnchanged=false,clock=()=>performance.now()}={}) {
    if (!pollScope || typeof text !== 'string' || !text || text.length > 4000) throw Error('POLL_TEXT_REFUSED');
    const started=clock(),message=await pollMessage(),verified=clock();
    // Comparison and PUT share the same freshly verified response; no second GET.
    const plain=text.replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,x)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[x]));
    if(skipUnchanged&&(message.body.text===text||message.body.text===plain))return {edited:false,maxVerifyMs:verified-started,maxPutMs:0};
    // Omitted attachments preserve the existing keyboard exactly.
    await raw.edit(pollScope.mid,{text,format:'html',notify:false});
    return {edited:true,putStartedAt:verified,maxVerifyMs:verified-started,maxPutMs:clock()-verified};
  }
  const owned = new Set();
  const requireOwned = mid => { if (!owned.has(mid)) throw Error('MESSAGE_REFUSED'); };
  return {
    pollMessage,
    editPollText: text => checkedPollEdit(text),
    syncPollText: (text,options) => checkedPollEdit(text,{...options,skipUnchanged:true}),
    async send(chatId, body, options) {
      if (!c.send || chatId !== CHAT) throw Error('SEND_REFUSED');
      const mid = await raw.send(CHAT, body, options); owned.add(mid); return mid;
    },
    async edit(mid, body) { requireOwned(mid); if (!c.edit) throw Error('EDIT_REFUSED'); return raw.edit(mid, body); },
    async remove(mid) { requireOwned(mid); if (!c.remove) throw Error('DELETE_REFUSED');
      await raw.request('DELETE', '/messages', { message_id: mid }); owned.delete(mid); }
  };
}
function trainingDate(value, now) {
  const t = moscow(now);
  let date = value || t.date;
  for (let i = 0; i < (value ? 1 : 8); i++) {
    const d = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== date) return null;
    const time = times[d.getUTCDay()];
    if (time && date >= t.date && (date > t.date || t.clock < time)) return date;
    date = new Date(d.getTime() + 86400000).toISOString().slice(0,10);
  }
  return null;
}
// Same fixed meeting URL as getTrainingLink() in main's bot.js.
function getTrainingLink() {
  return 'https://telemost.yandex.ru/j/35289250295816';
}
function isOnline(date) { return [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()); }
function body(p) {
  if (!trainingDate(p.date, new Date('2000-01-01T00:00:00Z'))) throw Error('INVALID_TRAINING_DATE');
  const day = new Date(`${p.date}T12:00:00Z`).getUTCDay();
  const date = new Intl.DateTimeFormat('ru-RU', { weekday:'long', day:'numeric', month:'long', timeZone:'Europe/Moscow' }).format(new Date(`${p.date}T12:00:00Z`));
  const online = isOnline(p.date);
  const place = [1,3].includes(day) ? 'Заря' : 'Поле чудес';
  const trainingLink = getTrainingLink();
  const details = online
    ? `🎥 Платформа: <b>Яндекс Телемост</b>\n⏰  Время: <b>${times[day]}</b>\n\n🔗 <a href="${trainingLink}">Ссылка для подключения</a>`
    : `📍 Место: <b>${place}</b>\n⏰ Время: <b>${times[day]} (МСК)</b>`;
  const names = [...p.votes.values()];
  const escape = name => name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const participants = names.length
    ? `✅ Записано (${names.length}):\n${names.map((name,i)=>`${i+1}. ${escape(name)}`).join('\n')}`
    : '🤨 Пока никто не записался!';
  return { text: `📅 <b>${date}</b>\n\n${details}\n\n${participants}`, format: 'html',
    attachments:[{type:'inline_keyboard',payload:{buttons:[[
      {type:'callback',text:'✅ Приду',payload:`poll:${p.id}:yes`},
      {type:'callback',text:'↩️ Отменить',payload:`poll:${p.id}:cancel`}
    ]]}}] };
}
class MemoryTrainingTest {
  constructor(api, c, now = () => new Date(), attempts = new TestPublicationAttempts()) { this.attempts=attempts; this.api=api; this.c=c; this.now=now; this.polls=new Map(); this.done=new Set(); this.queue=Promise.resolve(); }
  run(job) { const next=this.queue.then(job); this.queue=next.catch(()=>{}); return next; }
  async publish(date, eventId) {
    if (!this.c.send || this.polls.has(date)) return;
    if (!await this.attempts.reserve(date, eventId)) return;
    const p={id:randomUUID(),date,votes:new Map(),mid:null,closed:false};
    this.polls.set(date,p);
    try { p.mid=await this.api.send(CHAT,body(p), isOnline(date) ? { disableLinkPreview: true } : undefined); } catch { p.uncertain=true; }
  }
  tick() { return this.run(async()=>{
    const t=moscow(this.now());
    for (const [date,p] of this.polls) {
      if (date < t.date || (date===t.date && t.clock>='22:00')) {
        p.closed=true;
        if (p.mid && !p.deleted) { try { await this.api.remove(p.mid); p.deleted=true; } catch { /* Retry deletion; never recreate. */ } }
      }
    }
    if (this.c.auto && times[t.day] && t.clock>='10:00' && t.clock<'22:00' && !this.polls.has(t.date)) {
      await this.publish(t.date, `automatic:${t.date}`);
    }
    for (const p of this.polls.values()) if (p.dirty && !p.closed) {
      try { await this.api.edit(p.mid,body(p)); p.dirty=false; } catch { console.error('Training Test: PUT /messages failed; edit will retry.'); }
    }
  }); }
  receive(u) { return this.run(async()=>{
    if (u?.update_type === 'message_created') {
      const m = u.message;
      if (String(m?.recipient?.chat_id) !== CHAT || m?.sender?.is_bot !== false ||
          !Number.isSafeInteger(m?.sender?.user_id) || !this.c.admins?.includes(String(m.sender.user_id)) ||
          typeof m?.body?.mid !== 'string' || !m.body.mid || !this.c.send) return;
      const match = /^\/тестопрос(?: (\d{4}-\d{2}-\d{2}))?$/.exec(m.body.text || '');
      if (!match) return;
      const date = trainingDate(match[1], this.now());
      if (date) await this.publish(date, m.body.mid);
      return;
    }
    const t=moscow(this.now());
    const p=[...this.polls.values()].find(p => p.id === u?.callback?.payload?.split(':')[1]);
    if (u?.update_type!=='message_callback' || String(u.message?.recipient?.chat_id)!==CHAT || !p?.mid || p.closed || p.date < t.date || (p.date === t.date && t.clock>='22:00')) return;
    const cb=u.callback, match=/^poll:([a-f0-9-]{36}):(yes|cancel)$/.exec(cb?.payload || '');
    if (!cb?.callback_id || this.done.has(cb.callback_id) || !match || match[1]!==p.id || u.message?.body?.mid!==p.mid || !Number.isSafeInteger(cb.user?.user_id) || cb.user.user_id<=0) return;
    this.done.add(cb.callback_id);
    if (match[2]==='cancel') p.votes.delete(cb.user.user_id);
    else {
      const name=[cb.user.first_name,cb.user.last_name].filter(x=>typeof x==='string').join(' ').replace(/[\r\n\t\u0000-\u001f]+/g,' ').trim().slice(0,100);
      p.votes.set(cb.user.user_id,name || `Участник ${cb.user.user_id}`);
    }
    p.dirty=true;
  }); }
}
module.exports={CHAT,config,guardedApi,body,trainingDate,MemoryTrainingTest};
