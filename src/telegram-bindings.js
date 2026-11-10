'use strict';

const fs = require('node:fs');
const path = require('node:path');

class TelegramBindings {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.byUser = new Map(); // tgUserId -> { clientId, phone, name, chatId, linkedAt }
    this.byClient = new Map(); // clientId -> tgUserId
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [userId, record] of Object.entries(data)) {
            if (record && record.clientId) {
              this.byUser.set(String(userId), record);
              this.byClient.set(String(record.clientId), String(userId));
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to load telegram bindings:', err?.message || err);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const obj = Object.fromEntries(this.byUser);
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('Failed to save telegram bindings:', err?.message || err);
    }
  }

  bind(userId, { clientId, phone, name, chatId }) {
    if (!userId || !clientId) return false;
    const uid = String(userId);
    const cid = String(clientId);

    const record = {
      clientId: cid,
      phone: phone || null,
      name: name || null,
      chatId: chatId ? String(chatId) : uid,
      linkedAt: Date.now()
    };

    this.byUser.set(uid, record);
    this.byClient.set(cid, uid);
    this.save();
    return true;
  }

  unbind(userId) {
    const uid = String(userId);
    const existing = this.byUser.get(uid);
    if (!existing) return false;

    this.byUser.delete(uid);
    this.byClient.delete(existing.clientId);
    this.save();
    return true;
  }

  getClientId(userId) {
    if (!userId) return null;
    return this.byUser.get(String(userId))?.clientId || null;
  }

  getRecord(userId) {
    if (!userId) return null;
    return this.byUser.get(String(userId)) || null;
  }

  getTgUserId(clientId) {
    if (!clientId) return null;
    return this.byClient.get(String(clientId)) || null;
  }

  allBindings() {
    return Array.from(this.byUser.entries()).map(([userId, rec]) => ({
      userId,
      ...rec
    }));
  }
}

let defaultInstance = null;
function getTelegramBindings(stateDir = 'data') {
  if (!defaultInstance) {
    const file = path.join(path.resolve(stateDir), 'telegram-bindings.json');
    defaultInstance = new TelegramBindings(file);
  }
  return defaultInstance;
}

module.exports = { TelegramBindings, getTelegramBindings };
