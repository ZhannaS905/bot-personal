'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {database}=require('./helpers/autopost-firestore');
const {settings,capability,pollBody,Autopost,prepare,attach}=require('../src/training-test-autopost');
const {CHAT,body}=require('../src/memory-training-test');
const {POLL}=require('../direct-core/src/pilot-policy.cjs');
const env={BOT_MODE:'test',CHAT_IDS:CHAT,TEST_BOT_TOKEN:'offline',TEST_EXPECTED_BOT_ID:'123',WEBHOOK_SECRET:'offline_secret_123',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',TRAINING_TEST_AUTOPOST_ENABLED:'true',FIREBASE_PROJECT_ID:'fitpp-test'};
function fixture(t,date='2026-11-02T06:59:59Z',db=database()){
 let now=new Date(date),s;const calls={send:[],edit:[],verify:0},logs=[];
 const api={verify:async()=>{calls.verify++},send:async p=>{calls.send.push(structuredClone(p));return 'mid.test'},edit:async(p,{beforePut})=>{await beforePut();calls.edit.push(pollBody(p))}};
 function restart(){s=new Autopost({store:db.store({now:()=>+now}),api,admins:['1'],now:()=>now,log:x=>logs.push(x)});return s}
 restart();t.after(()=>s.close());return {db,calls,api,logs,get s(){return s},time:x=>{now=new Date(x)},restart};
}
function callback(p,id='a',action='yes',at=Date.parse('2026-11-02T07:01:00Z')){return {update_type:'message_callback',timestamp:at,callback:{callback_id:id,timestamp:at,payload:`poll:${p.id}:${action}`,user:{user_id:1,is_bot:false,first_name:'Елена <&>'}},message:{recipient:{chat_id:CHAT,chat_type:'chat'},body:{mid:p.mid}}}}
function command(at=Date.parse('2026-11-02T08:00:00Z')){return {update_type:'message_created',timestamp:at,message:{timestamp:at,sender:{user_id:1,is_bot:false},recipient:{chat_id:CHAT,chat_type:'chat'},body:{mid:'mid.command',text:'/тестопрос-сегодня'}}}}
test('Firestore test scope requires no persistent disk and never widens general flags',()=>{
 assert.equal(settings({}),null);assert.equal(settings({...env,TRAINING_TEST_AUTOPOST_ENABLED:'false'}),null);assert(settings(env));
 assert(settings({...env,TRAINING_TEST_AUTOPOST_STATE_DIR:'ignored-legacy-path',TRAINING_TEST_AUTOPOST_DURABLE_VOLUME:'false'}));
 for(const patch of [{BOT_MODE:'production'},{CHAT_IDS:'-1'},{FIREBASE_PROJECT_ID:'fitpp'},{TEST_ALLOW_SEND:'true'},{TEST_ALLOW_EDIT:'true'},{TEST_ALLOW_DELETE:'true'},{AUTO_PUBLISH:'true'},{TRAINING_TEST_AUTOPOST_STORAGE:'local'},{TRAINING_TEST_AUTOPOST_ENABLED:'yes'}])assert.throws(()=>settings({...env,...patch}));
});
test('all seven days cross 10:00 Moscow only once and retain existing exact body/buttons',async t=>{
 for(let day=2;day<=8;day++){
  const date=`2026-11-0${day}`,f=fixture(t,date+'T06:59:59Z');await f.s.tick();assert.equal(f.calls.send.length,0);f.time(date+'T07:00:00Z');await Promise.all([f.s.tick(),f.s.tick()]);assert.equal(f.calls.send.length,day===6?0:1);
  if(day!==6){const p=await f.s.store.read(date),b=pollBody(p);assert.match(b.text,new RegExp(['20:00','18:30','20:00','18:30','','18:00','18:00'][day-2]));assert.match(b.text,/🤨 Пока никто не записался!/);assert.doesNotMatch(b.text,/2026|60 минут|[━─]/);assert.deepEqual(b.attachments[0].payload.buttons[0].map(b=>b.text),['✅ Приду','↩️ Отменить']);if([2,4].includes(day))assert.match(b.text,/<b>Заря<\/b>/);if([3,5].includes(day))assert.match(b.text,/<b>Поле чудес<\/b>/);if(day>=7)assert.match(b.text,/35289250295816/)}
 }
});
test('late startup, missed minute, historical date and training start never catch up',async t=>{
 for(const time of ['2026-11-02T07:00:00.001Z','2026-11-02T08:00:00Z']){const f=fixture(t,time);await f.s.tick();assert.equal(f.calls.send.length,0)}
 const f=fixture(t);f.time('2026-11-02T07:01:00Z');await f.s.tick();await f.s.publish('2026-11-01');assert.equal(f.calls.send.length,0);f.time('2026-11-02T17:00:00Z');await f.s.receive(command(Date.parse('2026-11-02T17:00:00Z')));assert.equal(f.calls.send.length,0);
});
test('two instances and new process share atomic reservation; restart needs no disk',async t=>{
 const db=database(),a=fixture(t,undefined,db),b=fixture(t,undefined,db);a.time('2026-11-02T07:00:00Z');b.time('2026-11-02T07:00:00Z');
 await Promise.all([a.s.tick(),b.s.tick()]);assert.equal(a.calls.send.length+b.calls.send.length,1);
 await a.s.close();a.restart();await a.s.tick();await a.s.publish('2026-11-02');assert.equal(a.calls.send.length+b.calls.send.length,1);
});
test('timeout, HTTP failure and malformed MAX success block all future sends durably',async t=>{
 for(const mode of ['timeout','http','malformed']){const f=fixture(t);f.api.send=async p=>{f.calls.send.push(p);if(mode==='malformed')return '';throw Error('PRIVATE_TOKEN')};f.time('2026-11-02T07:00:00Z');await f.s.tick();assert.equal((await f.s.store.read('2026-11-02')).status,'uncertain');await f.s.close();f.restart();await f.s.tick();await f.s.publish('2026-11-02');assert.equal(f.calls.send.length,1);assert.doesNotMatch(f.logs.join(' '),/PRIVATE_TOKEN/)}
});
test('lost reservation acknowledgement commits a durable block but dispatches zero MAX requests',async t=>{
 const f=fixture(t);f.db.setFail('ack');f.time('2026-11-02T07:00:00Z');await assert.rejects(f.s.tick(),/ACK/);assert.equal(f.calls.send.length,0);assert.equal((await f.s.store.read('2026-11-02')).status,'reserved');await f.s.close();f.restart();await f.s.publish('2026-11-02');assert.equal(f.calls.send.length,0);
});
test('lost successful-send persistence leaves reserved/published and never repeats POST',async t=>{
 for(const mode of ['write','ack']){const f=fixture(t);const original=f.api.send;f.api.send=async p=>{const mid=await original(p);f.db.setFail(mode);return mid};f.time('2026-11-02T07:00:00Z');await f.s.tick().catch(()=>{});f.db.setFail(null);await f.s.close();f.restart();await f.s.publish('2026-11-02');assert.equal(f.calls.send.length,1);assert(['reserved','published','uncertain'].includes((await f.s.store.read('2026-11-02')).status))}
});
test('permission failures never fall back to RAM or acknowledge unpersisted votes',async t=>{
 const f=fixture(t);f.db.setFail('write');f.time('2026-11-02T07:00:00Z');await assert.rejects(f.s.tick(),/DENIED/);assert.equal(f.calls.send.length,0);assert.equal(await f.s.store.read('2026-11-02'),null);
 f.db.setFail(null);await f.s.publish('2026-11-02');const p=await f.s.store.read('2026-11-02');f.time('2026-11-02T07:01:00Z');f.db.setFail('write');await assert.rejects(f.s.receive(callback(p)),/DENIED/);assert.deepEqual((await f.s.store.read(p.date)).votes,{});
});
test('manual command requires a fresh test-group admin and shares the durable guard',async t=>{
 const f=fixture(t,'2026-11-02T08:00:00Z');await f.s.tick();assert.equal(f.calls.send.length,0);
 for(const mutate of [u=>{u.message.sender.user_id=2},u=>{u.message.sender.is_bot=true},u=>{u.message.recipient.chat_id='-1'},u=>{u.message.timestamp-=61000},u=>{u.message.body.text='/тестопрос-сегодня 2026-11-03'}]){const u=command();mutate(u);await f.s.receive(u);assert.equal(f.calls.send.length,0)}
 await Promise.all([f.s.receive(command()),f.s.receive(command())]);await f.s.close();f.restart();await f.s.receive(command());assert.equal(f.calls.send.length,1);
});
test('yes/cancel receipts, names, stale-event protection and dirty edits survive restart',async t=>{
 const f=fixture(t);f.time('2026-11-02T07:00:00Z');await f.s.tick();const p=await f.s.store.read('2026-11-02');f.time('2026-11-02T07:01:00Z');await f.s.receive(callback(p));await f.s.receive(callback(p));assert.equal((await f.s.store.read(p.date)).revision,1);
 f.api.edit=async()=>{throw Error('PRIVATE_TOKEN')};await f.s.tick();assert.equal(f.logs.at(-1),'Training Test: PUT /messages failed; edit will retry.');
 await f.s.close();f.restart();f.api.edit=async(p,{beforePut})=>{await beforePut();f.calls.edit.push(pollBody(p))};await f.s.tick();assert.match(f.calls.edit.at(-1).text,/1. Елена &lt;&amp;&gt;/);
 await f.s.receive(callback(p,'cancel','cancel',Date.parse('2026-11-02T07:01:01Z')));await f.s.receive(callback(p,'stale','yes'));await f.s.tick();const current=await f.s.store.read(p.date);assert.deepEqual(current.votes,{});assert.equal(current.revision,2);assert.equal(current.displayedRevision,2);assert.match(f.calls.edit.at(-1).text,/🤨 Пока никто не записался!/);
});
test('simultaneous votes in separate processes retain both participants and event receipts',async t=>{
 const db=database(),a=fixture(t,undefined,db),b=fixture(t,undefined,db);a.time('2026-11-02T07:00:00Z');await a.s.tick();const p=await a.s.store.read('2026-11-02');a.time('2026-11-02T07:01:00Z');b.time('2026-11-02T07:01:00Z');const one=callback(p),two=callback(p,'b');two.callback.user={user_id:2,is_bot:false,first_name:'Анна'};
 await Promise.all([a.s.receive(one),b.s.receive(two)]);const saved=await a.s.store.read(p.date);assert.equal(saved.revision,2);assert.equal(saved.order.length,2);assert.equal(db.commits.filter(p=>p.includes('/events/')).length,2);
});
test('edit lease prevents competing PUT; a concurrent vote stays dirty until repaired',async t=>{
 const db=database(),a=fixture(t,undefined,db),b=fixture(t,undefined,db);a.time('2026-11-02T07:00:00Z');await a.s.tick();const p=await a.s.store.read('2026-11-02');a.time('2026-11-02T07:01:00Z');b.time('2026-11-02T07:01:00Z');await a.s.receive(callback(p));let release;const gate=new Promise(r=>release=r);a.api.edit=async()=>{await gate};const edit=a.s.tick();await new Promise(r=>setTimeout(r,10));await b.s.tick();assert.equal(b.calls.edit.length,0);
 await b.s.receive(callback(p,'newer','cancel',Date.parse('2026-11-02T07:01:01Z')));release();await edit;let saved=await a.s.store.read(p.date);assert.equal(saved.revision,2);assert.equal(saved.displayedRevision,1);await b.s.tick();saved=await b.s.store.read(p.date);assert.equal(saved.displayedRevision,2);
});
test('expired edit lease recovers after crash and cannot dispatch a stale PUT',async t=>{
 const f=fixture(t);f.time('2026-11-02T07:00:00Z');await f.s.tick();const p=await f.s.store.read('2026-11-02');f.time('2026-11-02T07:01:00Z');await f.s.receive(callback(p));const claimed=await f.s.store.claimEdit(p.date);await f.s.close();f.time('2026-11-02T07:04:00Z');f.restart();await assert.rejects(f.s.store.checkEdit(p.date,claimed.editLease.token),/EXPIRED/);await f.s.tick();assert.equal(f.calls.edit.length,1);
});
test('existing pilot bypasses Firestore and still blocks a duplicate today',async t=>{
 const f=fixture(t,'2026-10-26T06:59:59Z');f.time('2026-10-26T07:00:00Z');await f.s.tick();await f.s.publish(POLL.date);assert.equal(f.calls.send.length,0);assert.equal(await f.s.receive(callback({...POLL,id:POLL.uuid})),false);assert.equal(f.db.paths.length,0);
});
test('votes remain open during 60-minute training then close; foreign users/messages never mutate',async t=>{
 const f=fixture(t);f.time('2026-11-02T07:00:00Z');await f.s.tick();const p=await f.s.store.read('2026-11-02');f.time('2026-11-02T07:01:00Z');
 for(const mutate of [u=>{u.message.body.mid='mid.foreign'},u=>{u.message.recipient.chat_id='-1'},u=>{u.callback.user.is_bot=true},u=>{u.callback.timestamp-=86400001}]){const u=callback(p);mutate(u);await f.s.receive(u);assert.deepEqual((await f.s.store.read(p.date)).votes,{})}
 f.time('2026-11-02T17:30:00Z');await f.s.receive(callback(p,'during','yes',Date.parse('2026-11-02T17:30:00Z')));f.time('2026-11-02T18:00:00Z');await f.s.receive(callback(p,'closed','cancel',Date.parse('2026-11-02T18:00:00Z')));assert.equal(Object.keys((await f.s.store.read(p.date)).votes).length,1);
});
test('120000ms scheduler avoids backlog; FitPP/contact traffic bypasses publication queue',async t=>{
 const f=fixture(t);let interval,cancelled=false;const stop=attach(f.s,{schedule(fn,ms){interval={fn,ms};return 1},cancel(){cancelled=true}});assert.equal(interval.ms,120000);let release;const pending=f.s.run(()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));assert.equal(await f.s.receive({update_type:'bot_started'}),false);assert.equal(await f.s.receive(callback({...POLL,id:POLL.uuid})),false);release();await pending;await stop();assert(cancelled);
});
function rawFixture(){
 const requests=[],p={id:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+ 'a'.repeat(12),date:'2026-11-02',votes:{},order:[],mid:'mid.test',status:'published'};
 let me={user_id:123,username:'id623401053090_1_bot',is_bot:true},chat={chat_id:CHAT,title:'Тест тренировок'},member={user_id:123,is_bot:true};
 let message={sender:me,recipient:{chat_id:CHAT},body:{mid:p.mid,attachments:body({...p,votes:new Map()}).attachments}};
 return {requests,p,setMe:v=>me=v,setChat:v=>chat=v,setMember:v=>member=v,setMessage:v=>message=v,raw:{async request(method,url,params){requests.push([method,url,params]);return url==='/me'?me:url.endsWith('/members/me')?member:url.startsWith('/chats/')?chat:message},async send(chat,b,opts){requests.push(['POST',chat,b,opts]);return 'mid.test'},async edit(mid,b){requests.push(['PUT',mid,b])}}};
}
test('capability rechecks identity before every send, pins chat and verifies edit ownership/buttons',async()=>{
 const r=rawFixture(),c={token:'offline',expectedId:'123'},api=await capability(c,{raw:r.raw});
 await api.send(r.p);await api.edit(r.p);assert.equal(r.requests.find(x=>x[0]==='POST')[1],CHAT);assert.deepEqual(r.requests.find(x=>x[0]==='PUT')[2],{text:body({...r.p,votes:new Map()}).text,format:'html',notify:false});assert(!('remove'in api));
 r.setMe({user_id:123,username:'production_bot',is_bot:true});await assert.rejects(api.send(r.p),/IDENTITY/);assert.equal(r.requests.filter(x=>x[0]==='POST').length,1);
});
test('wrong bot, chat, membership, edit sender/recipient/keyboards cannot write',async()=>{
 for(const patch of [r=>r.setMe({user_id:124,username:'id623401053090_1_bot',is_bot:true}),r=>r.setMe({user_id:123,username:'id623401053090_1_bot',is_bot:false}),r=>r.setChat({chat_id:'-1',title:'Тест тренировок'}),r=>r.setChat({chat_id:CHAT,title:'Рабочая группа'}),r=>r.setMember({user_id:124,is_bot:true})]){const r=rawFixture();patch(r);await assert.rejects(capability({expectedId:'123'},{raw:r.raw}));assert(!r.requests.some(x=>['POST','PUT','DELETE'].includes(x[0])))}
 for(const m of [{},{sender:{user_id:123,is_bot:true},recipient:{chat_id:'-1'},body:{mid:'mid.test'}},{sender:{user_id:124,is_bot:true},recipient:{chat_id:CHAT},body:{mid:'mid.test',attachments:[]}}]){const r=rawFixture(),a=await capability({expectedId:'123'},{raw:r.raw});r.setMessage(m);await assert.rejects(a.edit(r.p),/SCOPE/);assert(!r.requests.some(x=>x[0]==='PUT'))}
});

test('command deletion requires a newly published poll',async t=>{
 const f=fixture(t);
 f.s.calendarMode=true;
 f.s.admins=['5819064'];
 let deleted=0;
 f.s.api.deleteAdminCommand=async()=>{deleted++};
 f.s.publishTodayCalendar=async()=>0;
 f.time('2026-11-02T08:00:00Z');
 await f.s.receive({...command(),message:{...command().message,sender:{user_id:5819064,is_bot:false},body:{mid:'mid.command',text:'/опрос'}}});
 assert.equal(deleted,0);
 f.s.publishTodayCalendar=async()=>1;
 await f.s.receive({...command(),message:{...command().message,sender:{user_id:5819064,is_bot:false},body:{mid:'mid.command',text:'/опрос'}}});
 assert.equal(deleted,1);
});

test('deleteAdminCommand validates command scope before deleting',async()=>{
 const r=rawFixture();
 const api=await capability({token:'offline',expectedId:'123'},{raw:r.raw});
 const m={
  sender:{user_id:5819064,is_bot:false},
  recipient:{chat_id:CHAT,chat_type:'chat'},
  body:{mid:'mid.command',text:'/опрос'}
 };
 r.setMessage(m);
 await api.deleteAdminCommand(m,['5819064']);
 assert.equal(r.requests.filter(x=>x[0]==='DELETE').length,1);

 for(const changed of [
  {...m,body:{...m.body,text:'Привет'}},
  {...m,recipient:{...m.recipient,chat_id:'-1'}},
  {...m,sender:{user_id:999,is_bot:false}}
 ]){
  const before=r.requests.filter(x=>x[0]==='DELETE').length;
  await assert.rejects(api.deleteAdminCommand(changed,['5819064']));
  assert.equal(r.requests.filter(x=>x[0]==='DELETE').length,before);
 }
});

test('authenticated shared webhook routes new polls, old FitPP pilot and contacts independently',async t=>{
 const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
 const {main}=require('../src/fitpp-test-bridge');
 const f=fixture(t),scope={chat:POLL.chat,mid:POLL.mid,uuid:POLL.uuid,user:'5819064'};
 const c={...env,FITPP_BRIDGE_ENABLED:'true',FITPP_BRIDGE_URL:'https://offline.invalid/bot/update',FITPP_BRIDGE_HMAC_KEY:'a'.repeat(64),FITPP_BRIDGE_SCOPE:JSON.stringify(scope),FITPP_POLL_SYNC_ENABLED:'false',OWNER_DIALOG_ENABLED:'false'};
 let handler,contacts=0,commits=0;const server=new EventEmitter();server.listen=(_p,_h,fn)=>fn();server.close=()=>server.emit('close');
 const before=Object.fromEntries(['SIGINT','SIGTERM'].map(k=>[k,process.listeners(k)]));
 t.after(()=>{server.close();for(const sig of ['SIGINT','SIGTERM'])for(const fn of process.listeners(sig))if(!before[sig].includes(fn))process.removeListener(sig,fn)});
 await main({env:c,verify:async()=>({}),makeServer:fn=>{handler=fn;return server},reconcile:()=>({stop(){}}),autopost:f.s,contact:{receive:async()=>{contacts++}},callbackTransport:async()=>{commits++;return {ok:true,json:async()=>({applied:true})}}});
 async function request(u,secret=c.WEBHOOK_SECRET){
  let status;const req=Readable.from([Buffer.from(JSON.stringify(u))]);Object.assign(req,{method:'POST',url:'/webhook',headers:{'x-max-bot-api-secret':secret}});
  await new Promise(resolve=>handler(req,{writeHead(code){status=code;return this},end(){resolve()}}));return status;
 }
 f.time('2026-11-02T08:00:00Z');assert.equal(await request(command(),'wrong_secret'),403);assert.equal(f.calls.send.length,0);
 assert.equal(await request(command()),200);assert.equal(f.calls.send.length,1);
 const p=await f.s.store.read('2026-11-02');const vote=callback(p,'join','yes',Date.parse('2026-11-02T08:00:00Z'));assert.equal(await request(vote),200);
 assert.equal(Object.keys((await f.s.store.read(p.date)).votes).length,1);assert.equal(commits,0);
 const old=callback({...POLL,id:POLL.uuid},'pilot','yes',Date.now());old.callback.user.user_id=5819064;
 assert.equal(await request(old),200);assert.equal(commits,1);
 assert.equal(await request({update_type:'bot_started'}),200);assert.equal(contacts,1);
});

test('calendar deletion allows only bot-owned messages in test chat', async () => {
  const makePoll = () => ({
    key: 'a'.repeat(64),
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    mid: 'mid.test',
    botId: '123',
    chat: CHAT,
    status: 'deletePending'
  });

  const r = rawFixture();
  const api = await capability(
    {token: 'offline', expectedId: '123'},
    {raw: r.raw}
  );

  await api.deleteCalendarPoll(makePoll());

  assert.equal(
    r.requests.filter(x => x[0] === 'DELETE').length,
    1
  );
  assert.deepEqual(
    r.requests.find(x => x[0] === 'DELETE'),
    ['DELETE', '/messages', {message_id: 'mid.test'}]
  );

  for (const message of [
    {
      sender: {user_id: 999, is_bot: true},
      recipient: {chat_id: CHAT},
      body: {mid: 'mid.test'}
    },
    {
      sender: {user_id: 123, is_bot: true},
      recipient: {chat_id: '-1'},
      body: {mid: 'mid.test'}
    },
    {
      sender: {user_id: 123, is_bot: false},
      recipient: {chat_id: CHAT},
      body: {mid: 'mid.test'}
    }
  ]) {
    const f = rawFixture();
    f.setMessage(message);

    const guarded = await capability(
      {token: 'offline', expectedId: '123'},
      {raw: f.raw}
    );

    await assert.rejects(
      guarded.deleteCalendarPoll(makePoll()),
      /SCOPE_REFUSED/
    );

    assert.equal(
      f.requests.filter(x => x[0] === 'DELETE').length,
      0
    );
  }
});
