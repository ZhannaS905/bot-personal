'use strict';

const {moscow} = require('../schedule');
const {workouts, assertWorkspace} = require('./calendar');
const {projectId, root, main, bookings, trainer, validClientId, ownerUid} = require('./runtime-config');

const LOCATION_NAMES = Object.freeze({
  zarya: 'Заря',
  pole: 'Поле чудес',
  online: 'Онлайн'
});

function formatCoachSummary({workout, clientNames}) {
  const time = workout.time;
  const location = LOCATION_NAMES[workout.location] || workout.location;
  const count = clientNames.length;

  if (count === 0) {
    return `Сегодня в ${time} (${location}): пока никто не записался.`;
  }

  const mod100 = count % 100;
  const mod10 = count % 10;
  const peopleWord = (mod100 >= 11 && mod100 <= 14) ? 'человек'
    : (mod10 >= 2 && mod10 <= 4) ? 'человека'
    : 'человек';
  const verb = (mod10 === 1 && mod100 !== 11) ? 'записан' : 'записано';

  const list = clientNames.map((name, i) => `${i + 1}. ${name}`).join('\n');
  return `Сегодня в ${time} (${location}): ${verb} ${count} ${peopleWord}.\n\n${list}`;
}

function resolveBookedClients({workout, clients = [], bookings = {}, allWorkouts = [workout]}) {
  const activeClients = clients.filter(c => !c.archivedAt);
  const clientMap = new Map(activeClients.map(c => [String(c.id), c]));
  const bookedClientIds = new Set();

  const entries = bookings?.entries || {};
  const matching = allWorkouts.filter(x => x.date === workout.date && x.location === workout.location);
  const active = matching.filter(x => !x.cancelled);
  const legacyWorkouts = active.length ? active : matching;

  for (const [key, value] of Object.entries(entries)) {
    if (value !== true) continue;
    try {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts)) continue;
      const [id, scope, location] = parts;
      const clientId = String(id);
      if (!clientMap.has(clientId)) continue;

      const exact = parts.length === 2 && scope === workout.id;
      const legacy = parts.length === 3 && scope === workout.date && location === workout.location &&
        legacyWorkouts.some(x => x.id === workout.id);

      if (exact || legacy) {
        bookedClientIds.add(clientId);
      }
    } catch {}
  }

  return [...bookedClientIds]
    .map(id => clientMap.get(id)?.name || `Клиент #${id}`)
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function isWorkoutDueForSummary({workout, nowMs, leadTimeMs = 2 * 60 * 60 * 1000}) {
  if (!workout || workout.cancelled) return false;
  const workoutStartMs = Date.parse(`${workout.date}T${workout.time}:00+03:00`);
  if (!Number.isFinite(workoutStartMs)) return false;
  const triggerMs = workoutStartMs - leadTimeMs;
  return nowMs >= triggerMs && nowMs < workoutStartMs;
}

function createCoachSummarySource({sdk, raw, validateAuth}) {
  if (raw?.app?.options?.projectId !== projectId) throw Error('PERSONAL_PROJECT_REQUIRED');
  const mainRef = sdk.doc(raw, main);
  const trainerRef = sdk.doc(raw, trainer);
  const bookingsRef = sdk.doc(raw, bookings);

  const confirmed = snap => {
    if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) throw Error('PERSONAL_UNCONFIRMED_READ');
    return snap;
  };
  const read = async ref => confirmed(await sdk.getDocFromServer(ref)).data();

  return {
    async forDate(targetDate) {
      await validateAuth();
      const [stateDoc, trainerDoc, bookingsDoc] = await Promise.all([
        read(mainRef),
        read(trainerRef),
        read(bookingsRef)
      ]);
      await validateAuth();

      assertWorkspace(stateDoc);
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

function createCoachSummaryWorker({
  source,
  ledger,
  raw,
  coachUserId,
  coachChatId,
  leadTimeMinutes = 120,
  now = () => Date.now(),
  report = () => {}
}) {
  if (!coachUserId && !coachChatId) throw Error('COACH_TARGET_REQUIRED');
  const leadTimeMs = leadTimeMinutes * 60 * 1000;
  let running = false;

  return async function tick() {
    if (running) return;
    running = true;
    try {
      const nowMs = now();
      const m = moscow(new Date(nowMs));
      const todayDate = m.date;

      const data = await source.forDate(todayDate);
      if (!data || !Array.isArray(data.workouts) || data.workouts.length === 0) return;

      for (const workout of data.workouts) {
        if (!isWorkoutDueForSummary({workout, nowMs, leadTimeMs})) continue;

        const key = 'coach-summary:' + workout.id;
        const prior = ledger.status(key);
        if (prior) continue;

        const clientNames = resolveBookedClients({
          workout,
          clients: data.clients,
          bookings: data.bookings,
          allWorkouts: data.workouts
        });

        const text = formatCoachSummary({workout, clientNames});
        if (!ledger.claim(key)) continue;

        let status = 'uncertain';
        try {
          const body = {text, notify: true};
          const query = coachUserId ? {user_id: Number(coachUserId)} : {chat_id: coachChatId};
          const result = await raw.request('POST', '/messages', query, body);
          if (typeof result?.message?.body?.mid === 'string' && result.message.body.mid) {
            status = 'sent';
          }
        } catch (error) {
          if (/^MAX HTTP (400|401|403|404|429)$/.test(error?.message)) {
            status = 'rejected';
          }
        }
        ledger.finish(key, status);
        report(status);
      }
    } finally {
      running = false;
    }
  };
}

module.exports = {
  LOCATION_NAMES,
  formatCoachSummary,
  resolveBookedClients,
  isWorkoutDueForSummary,
  createCoachSummarySource,
  createCoachSummaryWorker
};
