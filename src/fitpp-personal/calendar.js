'use strict';

const {merge} = require('./group-period-model');
const {projectId, ownerUid, main, trainer, bookings} = require('./runtime-config');
const {validDate} = require('../fitpp-calendar-reader');
const locations = new Set(['zarya', 'pole', 'online']);

function assertWorkspace(state) {
  if (state?.ownerUid !== ownerUid || state.datasetId !== 'personal-v1' ||
      state.schemaVersion !== 1) throw Error('PERSONAL_WORKSPACE_REFUSED');
}

function workouts(state, history) {
  assertWorkspace(state);
  if (!history?.groupScheduleV1) throw Error('PERSONAL_SCHEDULE_MISSING');
  // FitPP Personal 1245d39 uses this same merge in its journal and booking writer.
  return Object.values(merge({workouts: state.workouts}, history.groupScheduleV1, ownerUid).workouts)
    .filter(workout => locations.has(workout.location))
    .map(({id, date, time, location, cancelled}) => {
      if (typeof id !== 'string' || !id || !validDate(date) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof cancelled !== 'boolean') {
        throw Error('PERSONAL_WORKOUT_REFUSED');
      }
      return {id, date, time, location, cancelled};
    });
}

function createPersonalCalendar({sdk, raw, validateAuth}) {
  if (raw?.app?.options?.projectId !== projectId) throw Error('PERSONAL_PROJECT_REQUIRED');
  async function read() {
    await validateAuth();
    const [state, history] = await Promise.all([main, trainer].map(path =>
      sdk.getDocFromServer(sdk.doc(raw, path))
    ));
    await validateAuth();
    return workouts(state.data(), history.data());
  }

  return {
    async day(date) {
      if (!validDate(date)) throw Error('CALENDAR_DATE_REFUSED');
      return (await read())
        .filter(workout => workout.date === date && !workout.cancelled)
        .sort((a, b) => a.time.localeCompare(b.time) ||
          a.location.localeCompare(b.location) || a.id.localeCompare(b.id));
    },
    async findById(id) {
      if (typeof id !== 'string' || !id) throw Error('CALENDAR_ID_REFUSED');
      return (await read()).find(workout => workout.id === id) || null;
    },
    async findClientByPhone(phoneNumber) {
      const { phone } = require('../contact-linking');
      const norm = phone(phoneNumber);
      if (!norm) return null;
      await validateAuth();
      const stateSnap = await sdk.getDocFromServer(sdk.doc(raw, main));
      await validateAuth();
      const clients = (stateSnap.data()?.clients || []).filter(c => !c.archivedAt);
      const matches = clients.filter(c => phone(c.phone) === norm);
      return matches.length === 1 ? matches[0] : null;
    },
    async bookedClients(workout) {
      if (!workout?.id) return [];
      await validateAuth();
      const [stateSnap, historySnap, bookingsSnap] = await Promise.all([
        sdk.getDocFromServer(sdk.doc(raw, main)),
        sdk.getDocFromServer(sdk.doc(raw, trainer)),
        sdk.getDocFromServer(sdk.doc(raw, bookings))
      ]);
      await validateAuth();

      const stateData = stateSnap.data() || {};
      const historyData = historySnap.data() || {};
      const bookingsData = bookingsSnap.data() || {};

      const allWorkouts = workouts(stateData, historyData);
      const activeClients = (stateData.clients || []).filter(c => !c.archivedAt);
      const clientMap = new Map(activeClients.map(c => [String(c.id), c]));
      const entries = bookingsData.entries || {};

      const matching = allWorkouts.filter(x => x.date === workout.date && x.location === workout.location);
      const active = matching.filter(x => !x.cancelled);
      const legacyWorkouts = active.length ? active : matching;

      const booked = [];
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
            const client = clientMap.get(clientId);
            booked.push({
              clientId,
              name: client?.name || `Клиент #${clientId}`
            });
          }
        } catch {}
      }
      return booked;
    },
    async syncTelegramBindings(allBindings) {
      if (!Array.isArray(allBindings)) return false;
      await validateAuth();
      const tgBindingsRef = sdk.doc(raw, 'fitppWorkspaces/personal-v1/notificationBindings/telegram');
      const data = {
        version: 1,
        updatedAt: Date.now(),
        bindings: allBindings.map(b => ({
          clientId: String(b.clientId),
          telegramUserId: Number(b.userId || b.telegramUserId),
          linkedAt: b.linkedAt || Date.now()
        }))
      };
      await sdk.setDoc(tgBindingsRef, data);
      return true;
    }
  };
}

module.exports = {assertWorkspace, workouts, createPersonalCalendar};
