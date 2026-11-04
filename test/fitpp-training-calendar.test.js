'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createTrainingCalendar}=require('../src/fitpp-training-calendar');
const {prepare}=require('../src/training-test-autopost');
const {format}=require('../src/fitpp-direct-diagnostic');
const w=(id='regular')=>({id,date:'2026-11-05',time:'20:00',location:'zarya',cancelled:false});
function fixture(){
 const schedule={schemaVersion:1,projectId:'fitpp-test',workouts:[w()],links:[{source:'main',workoutId:'legacy-only'},{source:'trainers',workoutId:'trainer-only'}]};
 const store={read:async()=>structuredClone(schedule),readTrainerWorkouts(){assert.fail('legacy trainer workouts must not be read');}};
 return {schedule,store,calendar:createTrainingCalendar({store})};
}
test('new calendar owns regular and additional workouts; links and legacy-only IDs are excluded',async()=>{
 const f=fixture();f.schedule.workouts.push({...w('additional'),extra:true,time:'21:00'});
 assert.deepEqual((await f.calendar.day('2026-11-05')).map(w=>w.id),['regular','additional']);
 assert.equal(await f.calendar.findById('legacy-only'),null);
 assert.equal(await f.calendar.findById('trainer-only'),null);
 assert.deepEqual(await f.calendar.day('2026-11-06'),[]);
});
test('move, cancellation and resume preserve the ID and follow only the new schedule',async()=>{
 const f=fixture(),workout=f.schedule.workouts[0];
 Object.assign(workout,{date:'2026-11-06',time:'21:30'});
 assert.deepEqual(await f.calendar.day('2026-11-05'),[]);
 assert.equal((await f.calendar.day('2026-11-06'))[0].time,'21:30');
 workout.cancelled=true;
 assert.deepEqual(await f.calendar.day('2026-11-06'),[]);
 assert.equal((await f.calendar.findById(workout.id)).cancelled,true);
 workout.cancelled=false;
 assert.equal((await f.calendar.day('2026-11-06'))[0].id,workout.id);
});
test('missing or malformed new schedule fails closed without legacy fallback',async()=>{
 for(const schedule of [null,{}, {schemaVersion:1,projectId:'fitpp-test',workouts:[{...w(),time:'bad'}]}, {schemaVersion:1,projectId:'fitpp-test',workouts:[w(),w()]}]){
  const cal=createTrainingCalendar({store:{read:async()=>schedule}});
  await assert.rejects(cal.day('2026-11-05'),e=>/^stage=CALENDAR_GROUP_READ reason=GROUP_/.test(format(e)));
 }
});
test('actual prepare and calendarPlan never read legacy main or trainer workouts even when IDs diverge',async()=>{
 const f=fixture(),chat='-80345864298680';
 f.schedule.workouts.push({...w('additional'),extra:true,time:'22:00'});
 const env={BOT_MODE:'test',CHAT_IDS:chat,TEST_BOT_TOKEN:'offline',TEST_EXPECTED_BOT_ID:'123',WEBHOOK_SECRET:'offline_secret_123',FIREBASE_PROJECT_ID:'fitpp-test',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',TRAINING_TEST_AUTOPOST_ENABLED:'true',TRAINING_TEST_CALENDAR_POLLS_ENABLED:'true'};
 const raw={async request(method,url){assert.equal(method,'GET');return url==='/me'?{user_id:123,is_bot:true,username:'id623401053090_1_bot'}:url.endsWith('/members/me')?{user_id:123,is_bot:true}:{chat_id:chat,title:'Тест тренировок'};}};
 const legacy={workouts:{regular:{...w(),date:'2026-11-07',time:'10:00',cancelled:true}}},before=structuredClone(legacy);
 let legacyReads=0;
 const bot=await prepare({env,raw,storeFactory:()=>({read:async()=>null}),calendarPollStoreFactory:()=>({}),calendarStore:()=>f.store,
  calendarDb:{doc(){legacyReads++;assert.fail('calendar polls must not read states/main');}},now:()=>new Date('2026-11-05T12:00:00+03:00')});
 assert.equal(bot.calendarMode,true);
 assert.deepEqual((await bot.calendarPlan()).map(w=>w.id),['regular','additional']);
 assert.equal((await bot.calendar.findById('regular')).time,'20:00');
 assert.equal(legacyReads,0);assert.deepEqual(legacy,before);
 const noLegacyDb=await prepare({env,raw,storeFactory:()=>({read:async()=>null}),calendarPollStoreFactory:()=>({}),calendarStore:()=>f.store});
 assert.equal((await noLegacyDb.calendar.findById('regular')).time,'20:00');
 await assert.rejects(prepare({env,raw,storeFactory:()=>({read:async()=>null}),calendarPollStoreFactory:()=>({}),calendarDb:{}}),e=>format(e)==='stage=CALENDAR_GROUP_READ reason=GROUP_CALENDAR_STORE_REQUIRED');
});
