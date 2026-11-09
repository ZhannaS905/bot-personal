'use strict';

const {MaxApi} = require('../api');
const {validateRegistry} = require('../contact-linking');
const {checkTestBotIdentity, identityAccepted} = require('../test-bot-identity');
const {ownerUid, projectId, validClientId, root, main, bindings, bookings, trainer} = require('./runtime-config');
const {workouts} = require('./calendar');

const collections = ['operations', 'paymentReceipts'];
const pageSize = 25;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const displayDate = s => s.split('-').reverse().join('.');
const own = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;

function receiptEvents({id, data}) {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || !['subscription', 'attendance'].includes(data.type) ||
      typeof data.signature !== 'string') return [];
  let request;
  try { request = JSON.parse(data.signature); } catch { return []; }
  const {action, personalNotificationsV1: events} = request || {};
  if (action?.operationId !== id || action.type !== data.type || !validClientId(String(action.clientId ?? '')) ||
      (data.clientId !== undefined && data.clientId !== action.clientId) ||
      !Array.isArray(events) || events.length > 2 ||
      new Set(events.map(e => e?.kind)).size !== events.length) return [];
  return events.filter(e => {
    if (e?.kind === 'purchase') {
      return action.type === 'subscription' && e.subscriptionId === 'subscription-' + id &&
        nonnegative(e.sessions) && e.sessions > 0 && nonnegative(e.remaining) &&
        e.remaining <= e.sessions && date(e.expires);
    }
    const visit = action.type === 'subscription' ? action.visit : action;
    const status = action.type === 'subscription' ? 'attended' : action.status;
    return ['attended', 'missed'].includes(e?.kind) && e.kind === status && visit &&
      typeof e.workoutId === 'string' && e.workoutId === visit.workoutId &&
      typeof e.visitId === 'string' && e.visitId.length > 0 &&
      date(e.date) && e.date === visit.date &&
      (typeof e.subscriptionId === 'string' && nonnegative(e.remaining) ||
       e.kind === 'attended' && e.subscriptionId === undefined && Number.isFinite(e.price) && e.price >= 0);
  }).map(e => ({...e, clientId: String(action.clientId)}));
}

function isCurrent(state, event) {
  const clients = state.clients.filter(c => String(c.id) === event.clientId);
  if (clients.length !== 1 || clients[0].archivedAt) return false;
  if (event.subscriptionId !== undefined) {
    const subs = (clients[0].subscriptions || []).filter(s => s.id === event.subscriptionId);
    if (subs.length !== 1 || subs[0].cancelledAt) return false;
  }
  if (event.kind === 'purchase') return true;
  const workout = own(state.workouts, event.workoutId);
  const op = own(own(state.visitOps, event.workoutId), event.clientId);
  return workout?.id === event.workoutId && !workout.cancelled && workout.date === event.date &&
    own(own(state.visits, event.workoutId), event.clientId) === event.kind &&
    op?.operationId === event.visitId && op.status === event.kind &&
    op.subscriptionId === event.subscriptionId && (event.subscriptionId !== undefined || !!op.moneyChargeId);
}

function format(event) {
  const remaining = `Осталось занятий: ${event.remaining}`;
  if (event.kind === 'purchase') {
    const n = event.sessions;
    const label = n % 100 >= 11 && n % 100 <= 14 ? 'занятий'
      : n % 10 === 1 ? 'занятие' : n % 10 >= 2 && n % 10 <= 4 ? 'занятия' : 'занятий';
    return `💳 Покупка абонемента\n\n🎟 ${n} ${label}\n📅 Действует до ${displayDate(event.expires)}\n\n${remaining}`;
  }
  const attended = event.kind === 'attended';
  const title = attended ? '✅ Посещение' : '❌ Занятие сгорело';
  const farewell = attended ? 'До встречи на следующей тренировке!' : 'Ждём на следующей тренировке!';
  const warning = event.remaining === 1 ? '\n\n⚠️ Осталось последнее занятие!'
    : event.remaining === 0 ? '\n\n⚠️ Занятия по абонементу закончились.' : '';
  const details = event.subscriptionId === undefined
    ? `Разовое занятие. Стоимость: ${event.price.toLocaleString('ru-RU')} ₽.`
    : `С абонемента списано 1 занятие.\n\n${remaining}${warning}`;
  return `${title}\n\n📅 ${displayDate(event.date)}\n${details}\n\n🫶 ${farewell}`;
}

function createSource({sdk, raw, validateAuth}) {
  if (raw.app.options.projectId !== projectId) throw Error('PERSONAL_PROJECT_REQUIRED');
  const mainRef = sdk.doc(raw, main);
  const bindingRef = sdk.doc(raw, bindings);
  const bookingsRef = sdk.doc(raw, bookings);
  const trainerRef = sdk.doc(raw, trainer);
  const confirmed = snap => {
    if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) throw Error('PERSONAL_UNCONFIRMED_READ');
    return snap;
  };
  const read = async ref => confirmed(await sdk.getDocFromServer(ref)).data();
  async function state() {
    const value = await read(mainRef);
    if (value?.ownerUid !== ownerUid || value.datasetId !== 'personal-v1' || value.schemaVersion !== 1 ||
        !nonnegative(value._fitppRevision) || !Array.isArray(value.clients)) throw Error('PERSONAL_STATE_REFUSED');
    return value;
  }
  return {
    async receipts(cursor) {
      await validateAuth();
      const watermark = (await state())._fitppRevision;
      if (cursor > watermark) throw Error('PERSONAL_CURSOR_AHEAD');
      if (cursor === watermark) return {rows: [], through: cursor};
      // Fix one server watermark before reading either collection.
      const batches = await Promise.all(collections.map(async name => {
        const query = sdk.query(sdk.collection(raw, root + '/' + name),
          sdk.where('type', 'in', ['subscription', 'attendance']),
          sdk.where('revision', '>', cursor), sdk.where('revision', '<=', watermark),
          sdk.orderBy('revision'), sdk.limit(pageSize));
        return confirmed(await sdk.getDocsFromServer(query)).docs.map(snap => ({
          id: snap.id, data: confirmed(snap).data()
        }));
      }));
      await validateAuth();
      const rows = batches.flat().sort((a,b) => a.data.revision - b.data.revision);
      if (rows.some(({data}, i) => !nonnegative(data.revision) || data.revision <= cursor ||
          data.revision > watermark || data.revision === rows[i-1]?.data.revision))
        throw Error('PERSONAL_RECEIPT_ORDER_REFUSED');
      const page = rows.slice(0, pageSize);
      return {rows: page, through: page.length < pageSize ? watermark : page.at(-1).data.revision};
    },
    async context() {
      await validateAuth();
      const [current, registry] = await Promise.all([state(), read(bindingRef)]);
      await validateAuth();
      return {state: current, registry};
    },
    async summaryData(targetDate) {
      await validateAuth();
      const [stateDoc, trainerDoc, bookingsDoc] = await Promise.all([
        state(),
        read(trainerRef),
        read(bookingsRef)
      ]);
      await validateAuth();
      const schedule = workouts(stateDoc, trainerDoc);
      const dayWorkouts = schedule.filter(w => w.date === targetDate && !w.cancelled);
      return {
        workouts: dayWorkouts,
        clients: stateDoc.clients || [],
        bookings: bookingsDoc || {entries: {}}
      };
    }
  };
}

function createWorker({source, ledger, token, botId, raw = new MaxApi(token), report = () => {}}) {
  let running = false;
  return async function tick() {
    if (running) return;
    running = true;
    try {
      const {rows, through} = await source.receipts(ledger.cursor());
      if (rows.some(row => receiptEvents(row).length)) {
        const identity = await raw.request('GET', '/me');
        if (!identityAccepted(checkTestBotIdentity(identity, String(botId)))) throw Error('PERSONAL_MAX_IDENTITY_REFUSED');
      }
      for (const row of rows) {
        for (const event of receiptEvents(row)) {
          const key = row.id + ':' + event.kind;
          const prior = ledger.status(key);
          if (prior) {
            if (prior === 'attempted') report('uncertain');
            continue;
          }
          const {state, registry} = await source.context();
          if (state._fitppRevision < row.data.revision) throw Error('PERSONAL_CONTEXT_BEHIND');
          const target = validateRegistry(registry, botId, validClientId)
            .bindings.find(b => b.clientId === event.clientId && b.notificationsEnabled);
          if (!target || !isCurrent(state, event)) {
            // Record skips too, so a crash or a new binding cannot revive this event.
            if (ledger.claim(key)) ledger.finish(key, target ? 'stale' : 'unlinked');
            report(target ? 'stale' : 'unlinked');
            continue;
          }
          const body = {text: format(event), notify: true};
          if (!ledger.claim(key)) continue;
          let status = 'uncertain';
          try {
            const result = await raw.request('POST', '/messages', {user_id: target.maxUserId}, body);
            if (typeof result.message?.body?.mid === 'string' && result.message.body.mid) status = 'sent';
          } catch (error) {
            if (/^MAX HTTP (400|401|403|404|429)$/.test(error?.message)) status = 'rejected';
          }
          ledger.finish(key, status);
          report(status);
        }
        ledger.advance(row.data.revision);
      }
      ledger.advance(through);
    } finally {
      running = false;
    }
  };
}

module.exports = {createSource, createWorker, format};
