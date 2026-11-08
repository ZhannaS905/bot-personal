'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {database} = require('./helpers/autopost-firestore');
const {createCalendarPollStore} = require('../src/training-test-calendar-firestore');
const {Autopost, capability} = require('../src/training-test-autopost');
const {calendarPollBody} = require('../src/training-test-calendar-body');
const {workoutKey} = require('../src/fitpp-calendar-poll-plan');
const {CHAT} = require('../src/training-test-firestore');

async function fixture(start = '2026-11-05T12:00:00+03:00') {
  let now = Date.parse(start);
  let workout = {id:'workout-1', date:'2026-11-05', time:'20:00', location:'zarya', cancelled:false};
  const db = database();
  const store = createCalendarPollStore({sdk:db.sdk, raw:db.raw, botId:'123', validateAuth:async()=>{}, writeEnabled:()=>true, now:()=>now});
  const key = workoutKey(workout), id = randomUUID();
  await store.reserve(workout, {id, createdAt:now});
  await store.finish(key, id, 'mid.existing');
  const me = {user_id:123, username:'id623401053090_1_bot', is_bot:true};
  let message = {sender:me, recipient:{chat_id:CHAT}, body:{mid:'mid.existing', ...calendarPollBody(await store.read(key))}};
  const puts = [], deletes = [];
  let fail = false;
  const api = await capability({expectedId:'123'}, {raw:{
    async request(method, path) {
      if (path === '/me') return me;
      if (path.endsWith('/members/me')) return me;
      if (path.startsWith('/chats/')) return {chat_id:CHAT, title:'ТАБАТА запись'};
      if (method === 'GET') return message;
      if (method === 'DELETE') {deletes.push(message.body.mid); return {success:true};}
      throw Error('Unexpected request');
    },
    async edit(mid, body) {
      assert.equal(mid, 'mid.existing');
      if (fail) throw Error('MAX HTTP 503');
      puts.push(body);
      message.body = {...message.body, ...body};
    },
    async send() {assert.fail('must not publish a duplicate');}
  }});
  store.listPublished = async () => {const p=await store.read(key); return p.status==='published'?[p]:[];};
  store.listPendingDeletes = async () => [];
  store.listPendingBookingSync = async () => [];
  const calendar = require('../src/fitpp-training-calendar').createTrainingCalendar({
    store:{read:async()=>({schemaVersion:1,projectId:'fitpp-test',workouts:[{...workout}]})}
  });
  const service = new Autopost({store:{}, api, calendar, calendarPollStore:store, calendarMode:true, now:()=>new Date(now), log:()=>{}});
  return {service, store, key, id, puts, deletes, get message(){return message;},
    move:changes=>{workout={...workout,...changes};}, time:at=>{now=Date.parse(at);}, fail:value=>{fail=value;}};
}


test('calendar PUT accepts absent sender and rejects foreign bot', async () => {
  for (const [label, sender, allowed] of [
    ['missing sender', undefined, true],
    ['own bot', {user_id:123, is_bot:true}, true],
    ['foreign bot', {user_id:999, is_bot:true}, false]
  ]) {
    const f = await fixture();
    const p = await f.store.read(f.key);

    if (sender === undefined) {
      delete f.message.sender;
    } else {
      f.message.sender = sender;
    }

    if (allowed) {
      await f.service.api.editCalendar(p);
      assert.equal(f.puts.length, 1, label);
      assert.equal(f.puts[0].format, 'html', label);
      assert.equal('notify' in f.puts[0], false, label);
      assert.equal('attachments' in f.puts[0], false, label);
    } else {
      await assert.rejects(
        f.service.api.editCalendar(p),
        /CALENDAR_EDIT_SCOPE_REFUSED/,
        label
      );
      assert.equal(f.puts.length, 0, label);
    }
  }
});

test('tick moves the existing MID within five minutes and retains the two buttons', async () => {
  const f=await fixture();
  await f.service.tick();
  const buttons=structuredClone(f.message.body.attachments);
  f.move({date:'2026-11-06', time:'21:30'});
  f.time('2026-11-05T12:05:00+03:00');
  await f.service.tick();
  assert.equal(f.puts.length,1);
  assert.match(f.message.body.text,/6 ноября/i);
  assert.match(f.message.body.text,/21:30/);
  assert.deepEqual(f.message.body.attachments,buttons);
  const saved=await f.store.read(f.key);
  assert.equal(saved.mid,'mid.existing');
  assert.equal(saved.id,f.id);
  assert.equal(saved.displayedRevision,saved.revision);
  await f.service.tick();
  assert.equal(f.puts.length,1);
});

test('tick cancels the existing MID, removes buttons and refuses a late vote', async () => {
  const f=await fixture();
  await f.service.tick();
  f.move({cancelled:true});
  f.time('2026-11-05T12:05:00+03:00');
  await f.service.tick();
  assert.equal(f.puts.length,1);
  assert.match(f.message.body.text,/Тренировка отменена/);
  assert.deepEqual(f.message.body.attachments,[]);
  const saved=await f.store.read(f.key);
  assert.equal(saved.mid,'mid.existing');
  assert.equal(await f.store.vote(f.key,{id:'late-vote',action:'yes',name:'Тест',uuid:f.id,mid:saved.mid,uid:'1',at:Date.parse('2026-11-05T12:06:00+03:00')},calendarPollBody),false);
});

test('move at the old deletion deadline is resolved before cleanup', async () => {
  const f=await fixture('2026-11-05T21:55:00+03:00');
  await f.service.tick();
  f.move({date:'2026-11-06',time:'21:30'});
  f.time('2026-11-05T22:00:00+03:00');
  await f.service.tick();
  assert.equal(f.puts.length,1);
  assert.deepEqual(f.deletes,[]);
  assert.equal((await f.store.read(f.key)).status,'published');
});

test('failed MAX edit remains dirty and retries on the next five minute tick', async () => {
  const f=await fixture();
  await f.service.tick();
  f.move({cancelled:true}); f.fail(true);
  f.time('2026-11-05T12:05:00+03:00'); await f.service.tick();
  let p=await f.store.read(f.key);
  assert.ok(p.revision>p.displayedRevision);
  assert.equal(p.editLease,undefined);
  f.fail(false); f.time('2026-11-05T12:10:00+03:00'); await f.service.tick();
  p=await f.store.read(f.key);
  assert.equal(p.revision,p.displayedRevision);
  assert.equal(f.puts.length,1);
});

test('new schedule refresh preserves votes and MID across a move without another POST', async () => {
  const f=await fixture();
  await f.store.vote(f.key,{id:'fixture-vote',uuid:f.id,mid:'mid.existing',uid:'1',name:'Участник',action:'yes',at:Date.parse('2026-11-05T12:00:00+03:00')},calendarPollBody);
  await f.service.tick();
  const before=await f.store.read(f.key);
  f.move({date:'2026-11-06',time:'21:30'});
  f.time('2026-11-05T12:05:00+03:00');await f.service.tick();
  const after=await f.store.read(f.key);
  assert.deepEqual(after.votes,before.votes);assert.deepEqual(after.order,before.order);
  assert.equal(after.mid,before.mid);assert.equal(after.id,before.id);
  assert.equal(f.message.body.attachments[0].payload.buttons.flat().length,2);
});
