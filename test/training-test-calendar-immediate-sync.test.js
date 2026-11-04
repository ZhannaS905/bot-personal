'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Autopost} = require('../src/training-test-autopost');
const {database} = require('./helpers/autopost-firestore');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');
const {bookingId} = require('../src/fitpp-calendar-booking');
const {CHAT} = require('../src/training-test-firestore');

async function fixture() {
  const db = database();
  const workout = {id:'immediate-local',date:'2026-11-04',time:'18:30',location:'zarya'};
  const key = workoutKey(workout), uuid = '12345678-1234-1234-1234-123456789012';
  let clock = Date.parse('2026-11-04T12:00:00Z');
  db.data.set('fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test', {
    version:1, botId:131384398, bindings:[{clientId:'demo-client-1',maxUserId:80,
      maxChatId:80,notificationsEnabled:true,recoverNotifications:true}]
  });
  const store = createCalendarPollStore({sdk:db.sdk,raw:db.raw,botId:'131384398',
    validateAuth:async()=>{},writeEnabled:()=>true,bookingSyncEnabled:()=>true,now:()=>clock});
  await store.reserve(workout,{id:uuid,createdAt:clock-1000});
  await store.finish(key,uuid,'mid.local');
  const calls=[], logs=[];
  const service = new Autopost({store:{},calendarPollStore:store,calendarMode:true,
    calendar:{day:async()=>[workout]}, now:()=>new Date(clock),log:s=>logs.push(s),
    api:{answer:async()=>calls.push('answer'),editCalendar:async(p,{beforePut})=>{
      calls.push('edit');await beforePut();}}
  });
  const event=(action,id)=>({update_type:'message_callback',timestamp:++clock,
    message:{recipient:{chat_id:CHAT,chat_type:'chat'},body:{mid:'mid.local'}},
    callback:{callback_id:id,payload:`cal:${key}:${uuid}:${action}`,
      user:{user_id:80,is_bot:false,first_name:'Local'}}});
  return {db,store,service,calls,logs,event,key,path:
    'fitppTestWorkspaces/synthetic-v1/calendarBookings/'+bookingId(workout.id,'demo-client-1')};
}

test('real callback yes/cancel immediately commits booking and ack before edit; duplicate is idempotent',async()=>{
  const f=await fixture();
  for(const [action,booked] of [['yes',true],['cancel',false]]){
    const u=f.event(action,action);
    assert.equal(await f.service.receive(u),true);
    assert.equal(f.db.data.get(f.path).booked,booked);
    const p=await f.store.read(f.key);
    assert.equal(p.bookingSyncedRevision,p.revision);
    assert.equal(p.bookingSyncPending,false);
    assert.equal(p.displayedRevision,p.revision);
    const commits=f.db.commits.length;
    await f.service.receive(u);
    assert.equal(f.db.commits.length,commits);
  }
  assert.deepEqual(f.calls,['answer','edit','answer','answer','edit','answer']);
});

test('sync failure preserves vote and pending; duplicate retries sync despite existing receipt; answer failure is diagnosed',async()=>{
  const f=await fixture(), sync=f.store.syncBookings;
  f.store.syncBookings=async()=>{throw Object.assign(Error('private text'),{code:'permission-denied'})};
  f.service.api.answer=async()=>{throw Error('MAX HTTP 400')};
  const u=f.event('yes','recover');
  await f.service.receive(u);
  let p=await f.store.read(f.key);
  assert.equal(p.bookingSyncPending,true);
  assert.equal(p.votes['80'],'Local');
  assert.equal(f.db.data.has(f.path),false);
  assert.ok(f.logs.some(s=>s.includes('MAX_HTTP_400')));
  assert.ok(f.logs.some(s=>s.includes('permission-denied')));
  assert.ok(f.logs.every(s=>!s.includes('private text')));
  f.store.syncBookings=sync;
  await f.service.receive(u);
  assert.equal(f.db.data.get(f.path).booked,true);
  p=await f.store.read(f.key);
  assert.equal(p.revision,1);
  assert.equal(p.bookingSyncPending,false);
});

test('transient sync error retries locally; edit failure cannot block committed cancellation',async()=>{
  const f=await fixture();
  await f.service.receive(f.event('yes','first'));
  const sync=f.store.syncBookings; let attempts=0;
  f.store.syncBookings=async key=>{
    if(++attempts===1)throw Object.assign(Error('offline'),{code:'unavailable'});
    return sync(key);
  };
  f.service.api.editCalendar=async()=>{throw Error('MAX HTTP 503')};
  await f.service.receive(f.event('cancel','second'));
  assert.equal(attempts,2);
  assert.equal(f.db.data.get(f.path).booked,false);
  const p=await f.store.read(f.key);
  assert.equal(p.bookingSyncPending,false);
  assert.equal(p.editLease,undefined);
  assert.ok(p.displayedRevision<p.revision);
});
