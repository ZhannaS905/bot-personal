'use strict';

function bookingChanges(poll, syncedClients, resolve) {
  if (!poll || !poll.votes || !poll.last ||
      !syncedClients || typeof resolve !== 'function') {
    throw Error('BOOKING_RECONCILE_REFUSED');
  }

  const changes = [];
  const nextClients = {...syncedClients};
  const users = new Set([
    ...Object.keys(poll.last),
    ...Object.keys(syncedClients)
  ]);

  for (const uid of users) {
    const previous = syncedClients[uid] || null;
    const current = resolve(uid);
    const attending = Object.hasOwn(poll.votes, uid);

    if (previous && (!attending || previous !== current)) {
      changes.push({uid, clientId: previous, booked: false});
      delete nextClients[uid];
    }

    if (attending && current && previous !== current) {
      changes.push({uid, clientId: current, booked: true});
      nextClients[uid] = current;
    }
  }

  return {changes, nextClients};
}

module.exports = {bookingChanges};
