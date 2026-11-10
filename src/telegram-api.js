'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

class TelegramApi {
  constructor(token, fetchImpl = fetch, wait = sleep) {
    if (!token || typeof token !== 'string') throw new Error('Telegram token required');
    this.token = token.trim();
    this.fetch = fetchImpl;
    this.wait = wait;
    this.next = 0;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async request(method, endpoint, body) {
    // Basic rate limit protection (stay under ~30 req/sec limit)
    await this.wait(Math.max(0, this.next - Date.now()));
    this.next = Date.now() + 50;

    const url = `${this.baseUrl}/${endpoint}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(35000)
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await this.fetch(url, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      const description = data?.description || `HTTP ${response.status}`;
      // Telegram returns 400 when message content has not changed during edit
      if (description.includes('message is not modified')) {
        return { ok: true, result: null, notModified: true };
      }
      const error = new Error(`Telegram API error [${endpoint}]: ${description}`);
      error.description = description;
      error.errorCode = data?.error_code || response.status;
      throw error;
    }

    return data.result;
  }

  formatKeyboard(attachments, transformer = p => p) {
    if (!attachments || !Array.isArray(attachments)) return undefined;
    for (const att of attachments) {
      if (att.type === 'inline_keyboard' && att.payload?.buttons) {
        return {
          inline_keyboard: att.payload.buttons.map(row =>
            row.map(btn => ({
              text: btn.text,
              callback_data: transformer(btn.payload)
            }))
          )
        };
      }
    }
    return undefined;
  }

  async send(chatId, message, { disableLinkPreview = false, payloadTransformer } = {}) {
    const text = typeof message === 'string' ? message : message.text;
    const replyMarkup = typeof message === 'object' && message.attachments
      ? this.formatKeyboard(message.attachments, payloadTransformer)
      : message.reply_markup;

    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: disableLinkPreview
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const result = await this.request('POST', 'sendMessage', payload);
    return result?.message_id;
  }

  async edit(chatId, messageId, message, { payloadTransformer } = {}) {
    const text = typeof message === 'string' ? message : message.text;
    const replyMarkup = typeof message === 'object' && message.attachments
      ? this.formatKeyboard(message.attachments, payloadTransformer)
      : message.reply_markup;

    const payload = {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    return this.request('POST', 'editMessageText', payload);
  }

  async answerCallback(callbackQueryId, text = 'Нажатие обработано') {
    if (!callbackQueryId) return false;
    return this.request('POST', 'answerCallbackQuery', {
      callback_query_id: String(callbackQueryId),
      text
    });
  }

  async deleteMessage(chatId, messageId) {
    return this.request('POST', 'deleteMessage', {
      chat_id: chatId,
      message_id: Number(messageId)
    });
  }

  async getMe() {
    return this.request('GET', 'getMe');
  }

  async getUpdates(offset = 0, timeout = 25) {
    return this.request('POST', 'getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query']
    });
  }
}

module.exports = { TelegramApi };
