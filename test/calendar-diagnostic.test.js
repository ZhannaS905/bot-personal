'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {at,mark,format}=require('../src/fitpp-direct-diagnostic');
const {createCombinedCalendar}=require('../src/fitpp-combined-calendar');
const {Autopost}=require('../src/training-test-autopost');
const date='2026-11-04';
const schedule=()=>({schemaVersion:1,projectId:'fitpp-test',groups:[],periods:[],workouts:[],links:[]});
const main=()=>({datasetId:'synthetic-v1',schemaVersion:1,workouts:{}});
function calendar({group=schedule(),extra=main(),groupError,extraError,exists=true}={}){
 return createCombinedCalendar({calendarStore:()=>({async read(){if(groupError)throw groupError;return group;}}),
 calendarDb:{doc(){return {async get(){if(extraError)throw extraError;return {exists,data:()=>extra};}};}}});
}
const cases=[
 ['invalid group',()=>calendar({group:{}}),'CALENDAR_GROUP_READ','GROUP_CALENDAR_REFUSED'],
 ['missing trainer calendar',()=>calendar({groupError:Error('TRAINER_CALENDAR_MISSING')}),'CALENDAR_GROUP_READ','TRAINER_CALENDAR_MISSING'],
 ['missing linked workout',()=>calendar({group:{...schedule(),groups:[{id:'zarya',location:'zarya'}],periods:[{id:'p',group:'zarya'}],links:[{source:'main',periodId:'p',workoutId:'missing'}]}}),'CALENDAR_GROUP_READ','GROUP_CALENDAR_LINK_MISSING'],
 ['missing main',()=>calendar({exists:false}),'CALENDAR_EXTRA_READ','CALENDAR_MAIN_MISSING'],
 ['invalid main',()=>calendar({extra:{}}),'CALENDAR_EXTRA_READ','CALENDAR_MAIN_REFUSED'],
 ['Firestore permission',()=>calendar({extraError:Object.assign(Error('PRIVATE_DOCUMENT'),{code:'permission-denied'})}),'CALENDAR_EXTRA_READ','permission-denied'],
 ['conflicting sources',()=>calendar({group:{...schedule(),groups:[{id:'zarya',location:'zarya'}],periods:[{id:'p',group:'zarya'}],workouts:[{id:'w',date,time:'20:00',location:'zarya',groupId:'zarya',periodId:'p',cancelled:false}]},extra:{...main(),workouts:{w:{id:'w',date,time:'21:00',location:'zarya',cancelled:false}}}}),'CALENDAR_PLAN','COMBINED_CALENDAR_CONFLICT']
];
for(const [name,make,stage,reason] of cases)test('safe calendar diagnostic: '+name,async()=>{
 await assert.rejects(at('CALENDAR_PLAN',()=>make().day(date)),e=>format(e)===`stage=${stage} reason=${reason}`);
});

test('only exact fixed reasons are logged; payloads and forged fields stay hidden',async()=>{
 const secret='PRIVATE_TOKEN PRIVATE_PERSON https://private.invalid\nFORGED_LOG';
 for(const error of [Error(secret),Error('GROUP_CALENDAR_REFUSED '+secret),Object.assign(Error(secret),{stage:'CALENDAR_GROUP_READ',reason:'GROUP_CALENDAR_REFUSED',code:secret,stack:secret})]){
  await assert.rejects(at('CALENDAR_PLAN',()=>calendar({groupError:error}).day(date)),e=>{
   assert.equal(format(mark(e,'RUNTIME_PREPARE')),'stage=CALENDAR_GROUP_READ reason=UNKNOWN');
   assert.ok(!format(e).includes(secret));return true;
  });
 }
});

function service({planFails=false,pollsFail=false}={}){
 let time=Date.parse(date+'T12:00:00+03:00'),plans=0,lists=0,refreshes=0;
 const bot=new Autopost({store:{},calendarMode:true,calendar:{async day(){plans++;if(planFails)throw Error('GROUP_CALENDAR_REFUSED');return [];}},
  calendarPollStore:{async listPublished(){lists++;if(pollsFail)throw Error('CALENDAR_POLL_DOCUMENT_REFUSED');return [];},async listPendingDeletes(){return [];},async listPendingBookingSync(){return [];}},
  now:()=>new Date(time),log:()=>{}});
 bot.refreshCalendarPolls=async polls=>{refreshes++;return polls;};
 return {bot,advance:()=>{time+=300000;},counts:()=>({plans,lists,refreshes})};
}
test('failed plan skips this refresh but next five minute tick still runs',async()=>{
 const f=service({planFails:true});
 await assert.rejects(f.bot.tick(),e=>format(e)==='stage=CALENDAR_PLAN reason=GROUP_CALENDAR_REFUSED');
 assert.deepEqual(f.counts(),{plans:1,lists:0,refreshes:0});
 f.advance();await f.bot.tick();
 assert.deepEqual(f.counts(),{plans:1,lists:1,refreshes:1});
});
test('persistent published-poll list failure blocks every refresh, not the scheduler',async()=>{
 const f=service({pollsFail:true});
 for(let i=0;i<2;i++){
  await assert.rejects(f.bot.tick(),e=>format(e)==='stage=CALENDAR_POLL_LIST reason=CALENDAR_POLL_DOCUMENT_REFUSED');f.advance();
 }
 assert.deepEqual(f.counts(),{plans:1,lists:2,refreshes:0});
});
