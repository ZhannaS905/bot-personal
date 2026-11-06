'use strict';

// Project metadata used by the FitPP Personal group model. Credentials come from runtime config.
const projectId = 'fitpp-personal';
const ownerUid = 'qWX93IRLn2Ww22KoevmtoI3ffXF2';
const root = 'fitppWorkspaces/personal-v1';
const main = root + '/states/main';
const bookings = root + '/states/bookings';
const bindings = root + '/notificationBindings/training-test';
const trainer = 'trainers/' + ownerUid;

function validClientId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) &&
    !['__proto__', 'prototype', 'constructor'].includes(id);
}

module.exports = {
  projectId, ownerUid, root, main, bookings, bindings, trainer, validClientId,
  firebase: {projectId}
};
