const {test}=require('node:test');const assert=require('node:assert/strict');
const {CHAT,config,guardedApi,body,MemoryTrainingTest}=require('../src/memory-training-test');
function fixture(){let now=new Date('2026-10-19T07:00:00Z');const calls={send:[],edit:[],remove:[]};const api=Object.fromEntries(Object.keys(calls).map(k=>[k,async(...args)=>{calls[k].push(args);return 'mid';}]));const s=new MemoryTrainingTest(api,{auto:true,send:true},()=>now);return{s,calls,api,time:x=>now=new Date(x)};}
const event=(p,choice='yes',cid='a')=>({update_type:'message_callback',callback:{callback_id:cid,payload:`poll:${p.id}:${choice}`,user:{user_id:1,first_name:'Елена'}},message:{recipient:{chat_id:Number(CHAT)},body:{mid:p.mid}}});
test('schedule, Friday, Moscow publication/deletion boundaries, concurrent duplicate guard',async()=>{
 for(let day=19;day<=25;day++){const f=fixture();f.time(`2026-10-${day}T06:59:00Z`);await f.s.tick();assert.equal(f.calls.send.length,0);f.time(`2026-10-${day}T07:00:00Z`);await Promise.all([f.s.tick(),f.s.tick()]);assert.equal(f.calls.send.length,day===23?0:1);if(day!==23){const p=[...f.s.polls.values()][0];const b=body(p);assert(b.text.includes(['20:00','18:30','20:00','18:30',null,'18:00','18:00'][day-19]));assert.deepEqual(b.attachments[0].payload.buttons[0].map(x=>x.text),['✅ Приду','↩️ Отменить']);f.time(`2026-10-${day}T18:59:00Z`);await f.s.tick();assert.equal(f.calls.remove.length,0);f.time(`2026-10-${day}T19:00:00Z`);await f.s.tick();await f.s.tick();assert.equal(f.calls.remove.length,1);}}
});
test('names, duplicate receipt, cancellation, foreign/stale callback and restart isolation',async()=>{const f=fixture();await f.s.tick();const p=[...f.s.polls.values()][0];await f.s.receive(event(p));await f.s.receive(event(p));assert.equal(p.votes.size,1);await f.s.tick();assert(body(p).text.includes('✅ Записано (1):\n1. Елена'));const foreign=event(p,'cancel','b');foreign.message.recipient.chat_id=-1;await f.s.receive(foreign);assert.equal(p.votes.size,1);const stale=event(p,'cancel','c');stale.message.body.mid='old';await f.s.receive(stale);assert.equal(p.votes.size,1);await f.s.receive(event(p,'cancel','d'));assert.equal(p.votes.size,0);f.time('2026-10-19T19:00:00Z');await f.s.receive(event(p,'yes','e'));assert.equal(p.votes.size,0);const restarted=fixture();await restarted.s.tick();await restarted.s.receive(event(p));assert.equal([...restarted.s.polls.values()][0].votes.size,0);});
test('uncertain sends never repeat; failed edit and delete retry without replacement',async()=>{const f=fixture();f.api.send=async()=>{f.calls.send.push([]);throw Error();};await f.s.tick();await f.s.tick();assert.equal(f.calls.send.length,1);const g=fixture();await g.s.tick();const p=[...g.s.polls.values()][0];await g.s.receive(event(p));g.api.edit=async()=>{throw Error();};await g.s.tick();assert(p.dirty);g.api.remove=async()=>{throw Error();};g.time('2026-10-19T19:00:00Z');await g.s.tick();assert(p.closed);assert(!p.deleted);g.api.remove=async()=>{};await g.s.tick();assert(p.deleted);assert.equal(g.calls.send.length,1);});
const env={BOT_MODE:'test',CHAT_IDS:CHAT,TEST_BOT_TOKEN:'offline',TEST_EXPECTED_BOT_ID:'123',WEBHOOK_SECRET:'offline_secret_123'};
test('configuration needs no state or initializer, denies production and mismatched tokens',()=>{assert.equal(config(env).send,false);for(const patch of [{CHAT_IDS:'-1'},{BOT_MODE:'production'},{BOT_TOKEN:'other'},{TEST_EXPECTED_BOT_ID:''},{WEBHOOK_SECRET:''},{NODE_TLS_REJECT_UNAUTHORIZED:'0'}])assert.throws(()=>config({...env,...patch}));});
test('API validates identity and confines writes to owned test messages',async()=>{const calls=[];const fetch=async(url,opts)=>{calls.push([opts.method,url.pathname,url.search]);let data=url.pathname==='/me'?{user_id:123,username:'id623401053090_1_bot',is_bot:true}:url.pathname.endsWith('/members/me')?{user_id:123,is_bot:true}:url.pathname.startsWith('/chats/')?{chat_id:Number(CHAT),title:'ТАБАТА запись'}:{message:{body:{mid:'owned'}}};return{ok:true,json:async()=>data};};const c={...config(env),send:true,edit:true,remove:true};const a=await guardedApi(c,fetch);await assert.rejects(a.send('-1',{}));await assert.rejects(a.remove('foreign'));await a.send(CHAT,{});await a.edit('owned',{});await a.remove('owned');await assert.rejects(a.remove('owned'));assert.deepEqual(calls.slice(3).map(x=>x[0]),['POST','PUT','DELETE']);const blocked=await guardedApi(config(env),fetch);await assert.rejects(blocked.send(CHAT,{}));await assert.rejects(guardedApi({...c,expectedId:'124'},fetch));});
test('memory webhook authenticates and awaits callback before 200 without filesystem',async()=>{
 const {Readable}=require('node:stream');const {createWebhook}=require('../src/memory-test-webhook');let received=0;
 const server=createWebhook({async receive(){await Promise.resolve();received++;}},'secret');const handler=server.listeners('request')[0];
 async function request(secret,body){let status;const req=Readable.from([Buffer.from(body)]);req.method='POST';req.url='/webhook';req.headers={'x-max-bot-api-secret':secret};const res={writeHead(n){status=n;return this;},end(){if(status===200)assert.equal(received,1);}};await handler(req,res);return status;}
 assert.equal(await request('wrong','{}'),403);assert.equal(await request('secret','{'),400);assert.equal(await request('secret','{}'),200);
});

test('poll layout: empty, join, multiple names, cancel and rejoin keep both buttons',async()=>{
 const f=fixture();await f.s.tick();const p=[...f.s.polls.values()][0];
 const header='📅 <b>понедельник, 19 октября</b>\n\n📍 Место: <b>Заря</b>\n⏰ Время: <b>20:00 (МСК)</b>\n\n';
 const empty='🤨 Пока никто не записался!';
 const buttons=body(p).attachments;
 const check=(message,tail)=>{assert.equal(message.text,header+tail);assert.equal(message.format,'html');assert.deepEqual(message.attachments,buttons);};
 assert.deepEqual(buttons[0].payload.buttons[0],[{type:'callback',text:'✅ Приду',payload:`poll:${p.id}:yes`},{type:'callback',text:'↩️ Отменить',payload:`poll:${p.id}:cancel`}]);
 check(f.calls.send[0][1],empty);
 await f.s.receive(event(p,'yes','join'));await f.s.tick();
 check(f.calls.edit.at(-1)[1],'✅ Записано (1):\n1. Елена');
 const second=event(p,'yes','second');second.callback.user={user_id:2,first_name:'Анна <&>',last_name:'Иванова'};
 await f.s.receive(second);await f.s.tick();
 check(f.calls.edit.at(-1)[1],'✅ Записано (2):\n1. Елена\n2. Анна &lt;&amp;&gt; Иванова');
 await f.s.receive(event(p,'cancel','cancel-first'));await f.s.tick();
 check(f.calls.edit.at(-1)[1],'✅ Записано (1):\n1. Анна &lt;&amp;&gt; Иванова');
 const cancel=event(p,'cancel','cancel-last');cancel.callback.user.user_id=2;
 await f.s.receive(cancel);await f.s.tick();check(f.calls.edit.at(-1)[1],empty);
 await f.s.receive(event(p,'yes','rejoin'));await f.s.tick();check(f.calls.edit.at(-1)[1],'✅ Записано (1):\n1. Елена');
 assert.equal(f.calls.send.length,1);assert.equal(f.calls.remove.length,0);
});


test('weekend polls use the production meeting link, dynamic dates and time, and preserve signup layout',async()=>{
 const link='https://telemost.yandex.ru/j/35289250295816';
 for(const [date,label] of [['2026-10-24','суббота, 24 октября'],['2026-10-25','воскресенье, 25 октября'],['2026-11-01','воскресенье, 1 ноября']]) {
  const f=fixture();f.time(`${date}T07:00:00Z`);await f.s.tick();const p=f.s.polls.get(date);
  const header=`📅 <b>${label}</b>\n\n🎥 Платформа: <b>Яндекс Телемост</b>\n⏰  Время: <b>18:00</b>\n\n🔗 <a href="${link}">Ссылка для подключения</a>\n\n`;
  const buttons=body(p).attachments;
  const check=tail=>{const b=body(p);assert.equal(b.text,header+tail);assert.equal(b.format,'html');assert.deepEqual(b.attachments,buttons);assert.doesNotMatch(b.text,/Место:|онлайн|[━─]|Подключиться к тренировке|Ссылка (?:для подключения|на подключение):/);assert.equal(b.text.split('Ссылка для подключения').length-1,1);assert.equal(b.text.replace(/<[^>]*>/g,'' ).includes(link),false);assert.deepEqual(b.attachments.map(a=>a.type),['inline_keyboard']);};
  check('🤨 Пока никто не записался!');
  assert.deepEqual(f.calls.send[0][1],body(p));
  assert.deepEqual(f.calls.send[0][2],{disableLinkPreview:true});
  await f.s.receive(event(p,'yes','join'));await f.s.tick();check('✅ Записано (1):\n1. Елена');
  assert.equal(f.calls.edit.at(-1)[1].text,body(p).text);
  await f.s.receive(event(p,'cancel','cancel'));await f.s.tick();check('🤨 Пока никто не записался!');
  await f.s.receive(event(p,'yes','rejoin'));await f.s.tick();check('✅ Записано (1):\n1. Елена');
 }
});
test('all in-person training days have place and time without separators or online details',()=>{
 for(const [date,place,time] of [['2026-10-19','Заря','20:00'],['2026-10-20','Поле чудес','18:30'],['2026-10-21','Заря','20:00'],['2026-10-22','Поле чудес','18:30']]) {
  const b=body({id:'offline',date,votes:new Map()});
  assert(b.text.includes(`📍 Место: <b>${place}</b>\n⏰ Время: <b>${time} (МСК)</b>\n\n`));
  assert.doesNotMatch(b.text,/Платформа|Ссылка|telemost|[━─]/);
 }
});


test('failed edits log only a fixed safe message and retry through the queue',async(t)=>{
 const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
 const f=fixture();await f.s.tick();const p=[...f.s.polls.values()][0];
 await f.s.receive(event(p));
 f.api.edit=async()=>{throw Error('token=secret user=Елена message_id=private');};
 await f.s.tick();assert.equal(p.dirty,true);
 assert.deepEqual(logs,[['Training Test: PUT /messages failed; edit will retry.']]);
 let finish;let edits=0;
 f.api.edit=async()=>{edits++;await new Promise(resolve=>{finish=resolve;});};
 const first=f.s.tick();const second=f.s.tick();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(edits,1);assert.equal(p.dirty,true);
 finish();await Promise.all([first,second]);
 assert.equal(p.dirty,false);assert.equal(edits,1);assert.equal(f.calls.send.length,1);
});

test('Training Test entrypoint schedules ticks every 1000 ms',async()=>{
 const vm=require('node:vm');const fs=require('node:fs');let interval;let ticks=0;
 const server={once(){},listen(port,host,resolve){resolve();}};
 const context={require(name){
  if(name==='./src/training-startup-diagnostic')return require('../src/training-startup-diagnostic');
  if(name==='node:http')return {createServer:()=>server};
  if(name==='node:crypto')return require('node:crypto');
  if(name==='./src/memory-test-webhook')return {createWebhook:()=>({listeners:()=>[()=>{}]})};
  if(name==='./src/memory-training-test')return {config:()=>({}),guardedApi:async()=>({}),MemoryTrainingTest:class{async tick(){ticks++;}}};
  throw Error('Unexpected dependency');
 },module:{exports:{}},process:{env:{},once(){}},console:{log(){},error(){}},setInterval(fn,ms){interval={fn,ms};return 1;},clearInterval(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../memory-training-test.cjs'),'utf8'),context);
 await context.module.exports.main();assert.equal(interval.ms,1000);assert.equal(ticks,1);
 interval.fn();assert.equal(ticks,2);
});
