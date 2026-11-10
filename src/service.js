const { randomUUID, createHash } = require('node:crypto');
const { moscow, times, scheduleText } = require('./schedule');
function id(value) { return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null; }
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function body(poll) {
  const date = new Date(`${poll.date}T12:00:00Z`);
  const day = date.getUTCDay();
  const place = day === 1 || day === 3 ? 'мкр. Заря' : day === 2 || day === 4 ? 'Поле чудес' : 'Яндекс Телемост';
  const formattedDate = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long'
  }).format(date);
  let text = `📅 <b>${formattedDate}</b>\n`;
  text += `📍 Место: <b>${place}</b>\n⏰ Время: <b>${times[day]}</b>\n\n`;
  const users = Object.entries(poll.votes).filter(([, choice]) => choice === 'yes');
  text += `<b>✅ Идут (${users.length}):</b>\n`;
  text += users.length
    ? users.map(([user], i) => `${i + 1}. ${escapeHtml(poll.names?.[user] || `Участник ${user}`)}`).join('\n')
    : 'Пока никто не записался.';
  if (day === 0 || day === 6) text += '\n\n🔗 <a href="https://telemost.yandex.ru/j/35289250295816">Ссылка для подключения</a>';
  const button = (text, choice) => ({ type: 'callback', text, payload: `poll:${poll.id}:${choice}` });
  return { text, format: 'html', attachments: [{ type: 'inline_keyboard', payload: { buttons: [
    [button('✅ Приду', 'yes'), button('↩️ Отменить', 'cancel')]
  ] } }] };
}
class Service {
  constructor(store, api, config, now = () => new Date(), telegramBridge = null) {
    this.store = store; this.api = api; this.config = config; this.now = now; this.queue = Promise.resolve();
    this.telegramBridge = telegramBridge;
  }
  run(job) { const next = this.queue.then(job); this.queue = next.catch(() => {}); return next; }
  async publish(chat) {
    const today = moscow(this.now());
    if (!times[today.day] || today.clock >= times[today.day]) return;
    const key = `${chat}/${today.date}`;
    if (this.store.state.polls[key]) return;
    const poll = { id: randomUUID(), chat, date: today.date, status: 'pending', votes: {}, mid: null, dirty: false };
    this.store.state.polls[key] = poll;
    this.store.save(); // Durable reservation BEFORE the external side effect. Never resend pending publications.
    try {
      poll.mid = await this.api.send(chat, body(poll));
      poll.status = 'published';
      if (this.telegramBridge) {
        try {
          await this.telegramBridge.sendCalendar(poll, body(poll));
        } catch (err) {
          console.error('[Telegram] Failed to send poll:', err?.message || err);
        }
      }
    } catch { poll.status = 'uncertain'; }
    this.store.save();
  }
  async tick() {
    const today = moscow(this.now());
    if (times[today.day] && today.clock >= '10:00' && today.clock < times[today.day]) {
      for (const chat of this.config.chatIds) await this.publish(chat);
    }
    await this.drain();
    await this.refresh();
  }
  receive(update) {
    if (this.store.failed) throw new Error('Storage unavailable');
    if (!update || !['message_created', 'message_callback'].includes(update.update_type)) return;
    const identity = update.update_type === 'message_callback' && update.callback?.callback_id
      ? `callback:${update.callback.callback_id}`
      : update.update_type === 'message_created' && update.message?.body?.mid
        ? `message:${update.message.recipient?.chat_id}:${update.message.body.mid}` : JSON.stringify(update);
    const key = createHash('sha256').update(identity).digest('hex');
    if (this.store.state.done[key] || this.store.state.inbox[key]) return;
    this.store.state.inbox[key] = update;
    this.store.save();
  }
  async drain() {
    for (const [key, update] of Object.entries(this.store.state.inbox)) {
      await this.handle(update, key);
    }
  }
  async handle(update, key) {
    const state = this.store.state;
    const message = update.message;
    const chat = id(message?.recipient?.chat_id);
    if (this.config.chatIds.includes(chat)) {
      if (update.update_type === 'message_callback') {
        const user = id(update.callback?.user?.user_id);
        const match = /^poll:([a-f0-9-]{36}):(yes|no|maybe|cancel)$/.exec(update.callback?.payload || '');
        const today = moscow(this.now()).date;
        const poll = state.polls[`${chat}/${today}`];
        if (user && match && poll?.status === 'published' && poll.id === match[1] && poll.mid === message?.body?.mid) {
          if (match[2] === 'cancel') {
            delete poll.votes[user];
            if (poll.names) delete poll.names[user];
          } else {
            poll.votes[user] = match[2];
            const profile = update.callback.user;
            const name = [profile.first_name, profile.last_name].filter(x => typeof x === 'string').join(' ').replace(/[\r\n\t]+/g, ' ').trim();
            poll.names ||= {};
            poll.names[user] = name || `Участник ${user}`;
          }
          poll.dirty = true;
        }
      } else if (update.update_type === 'message_created') {
        const command = message?.body?.text?.trim();
        if (command === '/опрос' && this.config.adminIds.includes(id(message?.sender?.user_id))) await this.publish(chat);
        if (command === '/расписание') {
          // Reserve the command before sending: replay must never repeat an uncertain send.
          state.done[key] = true; delete state.inbox[key]; this.store.save();
          await this.api.send(chat, { text: scheduleText });
        }
      }
    }
    state.done[key] = true;
    delete state.inbox[key];
    this.store.save(); // Vote and event receipt become durable together.
  }
  async refresh() {
    for (const poll of Object.values(this.store.state.polls)) {
      if (!poll.dirty || poll.status !== 'published') continue;
      try {
        await this.api.edit(poll.mid, body(poll));
        if (this.telegramBridge) {
          try {
            await this.telegramBridge.editCalendar(poll, body(poll));
          } catch (tgErr) {
            console.error('[Telegram] Failed to edit poll:', tgErr?.message || tgErr);
          }
        }
        poll.dirty = false;
        this.store.save();
      }
      catch { /* Retain durable dirty flag; retry edit only, never create a replacement. */ }
    }
  }
}
module.exports = { Service, body, id };
