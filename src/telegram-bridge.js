'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TelegramApi } = require('./telegram-api');
const { TelegramPoller } = require('./telegram-poller');

class TelegramBridge {
  constructor({
    token,
    chatId,
    adminIds = [],
    stateDir = 'data',
    api = null,
    log = console.log,
    onError = console.error
  } = {}) {
    this.token = token ? String(token).trim() : null;
    this.chatId = chatId ? String(chatId).trim() : null;
    this.adminIds = Array.isArray(adminIds) ? adminIds.map(String) : [];
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, 'telegram-polls.json');
    this.log = log;
    this.onError = onError;

    this.api = api || (this.token ? new TelegramApi(this.token) : null);
    this.poller = null;

    // In-memory mappings (also persisted to stateFile)
    // key -> { tgMessageId, pollId, date }
    // pollId -> key
    this.pollsByKey = new Map();
    this.keyByPollId = new Map();

    this.loadState();
  }

  get enabled() {
    return Boolean(this.token && this.api);
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [key, item] of Object.entries(data)) {
            if (item && item.tgMessageId) {
              this.pollsByKey.set(key, item);
              if (item.pollId) {
                this.keyByPollId.set(item.pollId, key);
              }
            }
          }
        }
      }
    } catch (err) {
      this.onError('Failed to load Telegram poll state: ' + (err?.message || err));
    }
  }

  saveState() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const data = Object.fromEntries(this.pollsByKey);
      const tmp = path.join(this.stateDir, 'telegram-polls.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.onError('Failed to save Telegram poll state: ' + (err?.message || err));
    }
  }

  // Maps long cal:<key>:<pollId>:<action> payloads into compact c:<pollId>:<action> (<= 64 bytes)
  transformPayloadForTelegram(payload) {
    if (typeof payload !== 'string') return payload;
    if (payload.startsWith('cal:')) {
      const parts = payload.split(':');
      if (parts.length === 4) {
        const [, key, pollId, action] = parts;
        this.keyByPollId.set(pollId, key);
        return `c:${pollId}:${action}`;
      }
    }
    return payload;
  }

  // Reconstructs full payload from compact Telegram callback data
  expandTelegramPayload(tgPayload) {
    if (typeof tgPayload !== 'string') return tgPayload;
    if (tgPayload.startsWith('c:')) {
      const parts = tgPayload.split(':');
      if (parts.length === 3) {
        const [, pollId, action] = parts;
        const key = this.keyByPollId.get(pollId);
        if (key) {
          return `cal:${key}:${pollId}:${action}`;
        }
      }
    }
    return tgPayload;
  }

  async sendCalendar(poll, message) {
    if (!this.enabled || !this.chatId) return null;
    const transformer = p => this.transformPayloadForTelegram(p);
    const tgMessageId = await this.api.send(this.chatId, message, {
      payloadTransformer: transformer
    });

    if (tgMessageId) {
      const key = poll.key || poll.workout?.id || poll.id;
      this.pollsByKey.set(key, {
        tgMessageId,
        pollId: poll.id,
        date: poll.workout?.date || poll.date
      });
      if (poll.id) {
        this.keyByPollId.set(poll.id, key);
      }
      this.saveState();
      this.log(`[Telegram] Опрос опубликован в чат ${this.chatId}, message_id: ${tgMessageId}`);
    }
    return tgMessageId;
  }

  async editCalendar(poll, message) {
    if (!this.enabled || !this.chatId) return false;
    const key = poll.key || poll.workout?.id || poll.id;
    const item = this.pollsByKey.get(key);
    if (!item?.tgMessageId) return false;

    const transformer = p => this.transformPayloadForTelegram(p);
    try {
      await this.api.edit(this.chatId, item.tgMessageId, message, {
        payloadTransformer: transformer
      });
      return true;
    } catch (err) {
      this.onError(`[Telegram] Ошибка редактирования опроса message_id ${item.tgMessageId}: ${err?.message || err}`);
      return false;
    }
  }

  async cancelCalendar(poll, message) {
    return this.editCalendar(poll, message);
  }

  start({ onAdminPoll, onCallback, getActivePoll } = {}) {
    if (!this.enabled) {
      this.log('[Telegram] TelegramBot не сконфигурирован (пропущен токен или отключен).');
      return;
    }

    this.poller = new TelegramPoller({
      api: this.api,
      log: this.log,
      onError: this.onError,
      onMessage: async (msg) => {
        const chatId = String(msg.chat.id);
        const chatTitle = msg.chat.title || msg.chat.username || 'Личный диалог';
        const senderId = String(msg.from?.id);
        const text = msg.text?.trim() || '';

        // Helpful discovery log: prints chat ID on any incoming message
        this.log(`[Telegram] Сообщение из чата "${chatTitle}" (ID: ${chatId}) от пользователя ${senderId}: "${text}"`);

        if (text === '/опрос') {
          if (this.chatId && chatId !== this.chatId) {
            this.log(`[Telegram] Команда /опрос отклонена: чат ${chatId} не совпадает с TELEGRAM_CHAT_ID (${this.chatId})`);
            return;
          }

          if (this.adminIds.length > 0 && !this.adminIds.includes(senderId)) {
            this.log(`[Telegram] Команда /опрос отклонена: пользователь ${senderId} не в TELEGRAM_ADMIN_IDS`);
            return;
          }

          this.log(`[Telegram] Получена команда /опрос от администратора ${senderId}`);
          if (typeof onAdminPoll === 'function') {
            await onAdminPoll(msg);
          }

          // Delete the admin's /опрос command message to keep the group tidy
          try {
            await this.api.deleteMessage(chatId, msg.message_id);
          } catch {
            // Non-fatal if bot lacks delete permissions
          }
        }
      },
      onCallback: async (cq) => {
        const data = cq.data || '';
        const fullPayload = this.expandTelegramPayload(data);
        const sender = cq.from;
        if (!sender || sender.is_bot) return;

        // Immediately acknowledge button click so spinner stops in Telegram
        try {
          await this.api.answerCallback(cq.id, 'Нажатие обработано');
        } catch {
          // Ignore network errors on acknowledgement
        }

        if (typeof onCallback === 'function') {
          // Retrieve the current poll to bind mid and recipient chat
          const poll = typeof getActivePoll === 'function' ? await getActivePoll(fullPayload) : null;

          const name = [sender.first_name, sender.last_name]
            .filter(Boolean)
            .join(' ')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 100) || (sender.username ? `@${sender.username}` : `Участник ${sender.id}`);

          const syntheticUpdate = {
            update_type: 'message_callback',
            callback: {
              callback_id: `tg_${cq.id}`,
              user: {
                user_id: sender.id,
                first_name: sender.first_name,
                last_name: sender.last_name,
                username: sender.username,
                is_bot: false
              },
              payload: fullPayload,
              timestamp: Date.now()
            },
            telegram_vote: {
              uid: String(sender.id),
              name,
              payload: fullPayload
            },
            message: poll?.mid ? {
              recipient: {
                chat_id: poll.chat,
                chat_type: 'channel'
              },
              body: {
                mid: poll.mid
              }
            } : undefined
          };

          await onCallback(syntheticUpdate, cq);
        }
      }
    });

    this.poller.start();
    this.log(`[Telegram] Long Polling запущен успешно. Ожидание событий...`);
  }

  async stop() {
    if (this.poller) {
      await this.poller.stop();
      this.poller = null;
    }
  }
}

module.exports = { TelegramBridge };
