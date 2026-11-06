'use strict';

const {randomUUID} = require('node:crypto');
const {moscow} = require('../schedule');
const {assertWorkspace, workouts} = require('./calendar');
const {main, trainer, bookings, root, ownerUid, validClientId} = require('./runtime-config');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

// FitPP Personal 1245d39, docs/operations.js, exact journal booking operation.
// Run inside the poll transaction so votes, booking versions and its receipt
// cannot diverge after a retry. Only protocol metadata changes in states/main.
async function applyBooking({sdk, raw, transaction, workout, clientId, desired, now}) {
  if (!validClientId(clientId)) throw Error('PERSONAL_CLIENT_REFUSED');
  const refs = [main, trainer, bookings].map(path => sdk.doc(raw, path));
  const [state, history, stored] = (await Promise.all(refs.map(ref =>
    transaction.get(ref)
  ))).map(snap => snap.data());
  assertWorkspace(state);
  if (stored?.ownerUid !== ownerUid || stored.datasetId !== 'personal-v1' ||
      !stored.entries || !Array.isArray(state.clients)) throw Error('PERSONAL_BOOKINGS_REFUSED');

  const schedule = workouts(state, history);
  const current = schedule.find(item => item.id === workout.id);
  const client = state.clients.filter(item => String(item.id) === clientId);
  if (desired && (!current || current.cancelled || current.date !== workout.date ||
      current.location !== workout.location || current.time !== workout.time ||
      client.length !== 1 || client[0].archivedAt || !client[0].locations?.includes(current.location))) {
    throw Error('WORKOUT_UNAVAILABLE');
  }

  const exactKey = JSON.stringify([clientId, workout.id]);
  const target = current || workout;
  const {id, date, location} = target;
  const legacyKey = JSON.stringify([clientId, date, location]);
  const sameDay = schedule.filter(item => item.date === date && item.location === location);
  const active = sameDay.filter(item => !item.cancelled);
  const matching = active.length ? active : sameDay;
  const entries = {...stored.entries};
  const versions = {...stored.versions};

  // The journal attributes an old date/location entry only when unambiguous.
  const hasLegacy = matching.length === 1 && matching[0].id === id &&
    entries[legacyKey] === true;
  const key = !desired && hasLegacy ? legacyKey : exactKey;
  if ((entries[key] === true) === desired || (desired && hasLegacy)) return {more: false};

  const expectedVersion = versions[key] ?? 0;
  const revision = state._fitppRevision ?? 0;
  const bookingRevision = stored.revision ?? 0;
  if (![expectedVersion, revision, bookingRevision].every(value =>
    Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
  )) throw Error('PERSONAL_BOOKING_REVISION_REFUSED');

  if (desired) entries[key] = true;
  else delete entries[key];
  if (Object.keys(entries).length > 500) throw Error('PERSONAL_BOOKING_LIMIT');

  const at = now();
  const operationId = randomUUID();
  const collection = 'operations';
  const action = {type: 'booking', key, desired, expectedVersion, operationId, workout: {id, date, location}};
  const signature = JSON.stringify(stable({action, operationDay: moscow(new Date(at)).date}));
  transaction.update(refs[0], {_fitppRevision: revision + 1, lastOperation: {id: operationId, collection}});
  transaction.set(sdk.doc(raw, root + '/' + collection + '/' + operationId),
    {signature, type: 'booking', at, revision: revision + 1});
  transaction.update(refs[2], {entries, versions: {...versions, [key]: expectedVersion + 1}, revision: bookingRevision + 1});
  return {more: key === legacyKey && entries[exactKey] === true};
}

module.exports = {applyBooking};
