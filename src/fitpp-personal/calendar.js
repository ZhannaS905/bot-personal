'use strict';

const {merge} = require('./group-period-model');
const {projectId, ownerUid, main, trainer} = require('./runtime-config');
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
    }
  };
}

module.exports = {assertWorkspace, workouts, createPersonalCalendar};
