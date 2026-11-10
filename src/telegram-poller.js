'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

class TelegramPoller {
  constructor({
    api,
    onMessage,
    onCallback,
    log = console.log,
    onError = console.error,
    wait = sleep,
    interval = 100
  }) {
    if (!api) throw new Error('TelegramApi instance required');
    this.api = api;
    this.onMessage = onMessage || (() => {});
    this.onCallback = onCallback || (() => {});
    this.log = log;
    this.onError = onError;
    this.wait = wait;
    this.interval = interval;
    this.running = false;
    this.offset = 0;
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this._loop();
    return this.loopPromise;
  }

  async stop() {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
  }

  async _loop() {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, 25);
        if (!this.running) break;

        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (!this.running) break;
            if (typeof update.update_id === 'number') {
              this.offset = Math.max(this.offset, update.update_id + 1);
            }

            if (update.message) {
              try {
                await this.onMessage(update.message);
              } catch (err) {
                this.onError('Telegram message handler error: ' + (err?.message || err));
              }
            }

            if (update.callback_query) {
              try {
                await this.onCallback(update.callback_query);
              } catch (err) {
                this.onError('Telegram callback handler error: ' + (err?.message || err));
              }
            }
          }
        }
        if (this.interval > 0) {
          await this.wait(this.interval);
        }
      } catch (error) {
        if (!this.running) break;
        this.onError('Telegram polling error: ' + (error?.message || error));
        await this.wait(3000);
      }
    }
  }
}

module.exports = { TelegramPoller };
