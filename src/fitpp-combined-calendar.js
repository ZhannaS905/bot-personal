'use strict';

const {at}=require('./fitpp-direct-diagnostic');
const {createCalendar,createGroupCalendar}=require('./fitpp-calendar-reader');

function createCombinedCalendar({calendarStore,calendarDb}) {
  if (typeof calendarStore!=='function' || !calendarDb) {
    throw Error('COMBINED_CALENDAR_CONFIG');
  }

  const regular=createGroupCalendar({
    store:calendarStore(),
    mainDb:calendarDb
  });
  const additional=createCalendar({db:calendarDb});

  return {
    async day(date) {
      const [groupWorkouts,extraWorkouts]=await Promise.all([
        at('CALENDAR_GROUP_READ',()=>regular.day(date)),
        at('CALENDAR_EXTRA_READ',()=>additional.day(date))
      ]);

      const result=new Map();

      for (const workout of [...groupWorkouts,...extraWorkouts]) {
        const existing=result.get(workout.id);

        if (existing) {
          if (existing.date!==workout.date ||
              existing.time!==workout.time ||
              existing.location!==workout.location) {
            throw Error('COMBINED_CALENDAR_CONFLICT');
          }
          continue;
        }

        result.set(workout.id,workout);
      }

      return [...result.values()].sort(
        (a,b)=>a.time.localeCompare(b.time) ||
               a.location.localeCompare(b.location) ||
               a.id.localeCompare(b.id)
      );
    },

    async findById(id) {
      const regularWorkout=await at('CALENDAR_GROUP_READ',()=>regular.findById(id));
      const extraWorkout=await at('CALENDAR_EXTRA_READ',()=>additional.findById(id));

      if (regularWorkout && extraWorkout) {
        if (regularWorkout.date!==extraWorkout.date ||
            regularWorkout.time!==extraWorkout.time ||
            regularWorkout.location!==extraWorkout.location ||
            regularWorkout.cancelled!==extraWorkout.cancelled) {
          throw Error('COMBINED_CALENDAR_CONFLICT');
        }
      }

      return regularWorkout || extraWorkout;
    }
  };
}

module.exports={createCombinedCalendar};
