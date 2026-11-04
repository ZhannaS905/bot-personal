'use strict';
// Calendar polls use only the new schedule's own workouts. Never resolve legacy links.
const {at}=require('./fitpp-direct-diagnostic');
const {validDate}=require('./fitpp-calendar-reader');
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
const LOCATIONS=new Set(['zarya','pole','online']);
function createTrainingCalendar({store}) {
 if(!store||typeof store.read!=='function')throw Error('GROUP_CALENDAR_STORE_REQUIRED');
 async function workouts(){
  return at('CALENDAR_GROUP_READ',async()=>{
   const schedule=await store.read();
   if(!schedule||schedule.schemaVersion!==1||schedule.projectId!=='fitpp-test'||!Array.isArray(schedule.workouts))throw Error('GROUP_CALENDAR_REFUSED');
   const seen=new Set();
   return schedule.workouts.map(w=>{
    if(!w||typeof w.id!=='string'||!w.id.trim()||!validDate(w.date)||!TIME.test(w.time)||!LOCATIONS.has(w.location)||typeof w.cancelled!=='boolean')throw Error('GROUP_WORKOUT_REFUSED');
    if(seen.has(w.id))throw Error('GROUP_WORKOUT_AMBIGUOUS');
    seen.add(w.id);
    return {id:w.id,date:w.date,time:w.time,location:w.location,cancelled:w.cancelled};
   });
  });
 }
 return {
  async day(date){
   if(!validDate(date))throw Error('CALENDAR_DATE_REFUSED');
   return (await workouts()).filter(w=>w.date===date&&!w.cancelled)
    .map(({cancelled,...w})=>w)
    .sort((a,b)=>a.time.localeCompare(b.time)||a.location.localeCompare(b.location)||a.id.localeCompare(b.id));
  },
  async findById(id){
   if(typeof id!=='string'||!id.trim())throw Error('GROUP_WORKOUT_ID_REFUSED');
   return (await workouts()).find(w=>w.id===id)||null;
  }
 };
}
module.exports={createTrainingCalendar};
