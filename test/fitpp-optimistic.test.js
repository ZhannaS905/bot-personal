'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createOptimistic}=require('../src/fitpp-optimistic'),{createPollSync,render,plainText}=require('../src/fitpp-poll-sync'),{startReconciliation}=require('../src/fitpp-test-bridge');
const scope={chat:'-79450912874680',user:'5819064',mid:'mid.mock1',uuid:'11111111-2222-4333-8444-555555555555'};
const self={clientId:'demo-client-1',name:'Вымышленный клиент'},other={clientId:'demo-client-2',name:'Другой тестовый клиент'};
function event(choice='yes',at=100000,id='one'){return {update_type:'message_callback',timestamp:at,callback:{callback_id:id,payload:`poll:${scope.uuid}:${choice}`,user:{user_id:5819064,is_bot:false}},message:{recipient:{chat_id:scope.chat,chat_type:'chat'},body:{mid:scope.mid}}}}
function fixture(initial=[]){
 let participants=structuredClone(initial),lastEventAt=0,revision=0,text='',puts=[],failMax=0,failWrite=false,binding=true,time=0,preflight=0,active=0,peak=0;
 const logs=[],done=new Set();
 const view=()=>({...scope,date:'2026-10-26',location:'zarya',time:'20:00',revision,participants:structuredClone(participants).sort((a,b)=>a.clientId.localeCompare(b.clientId))});
 const loadView=async()=>{preflight++;time+=5;return {...view(),...(binding?{optimistic:{userId:scope.user,...self,lastEventAt,openedAt:1,closesAt:200000}}:{})}};
 const api={syncPollText:async value=>{active++;peak=Math.max(peak,active);try{time+=10;if(failMax-- >0)throw Error('MAX failure');if(text===plainText(value))return {edited:false,maxVerifyMs:1,maxPutMs:0};puts.push(value);text=plainText(value);return {edited:true,maxVerifyMs:1,maxPutMs:9}}finally{active--}}};
 const sync=createPollSync({scope,loadView:async()=>view(),api,clock:()=>time});
 const make=()=>createOptimistic({scope,loadView,api,reconcile:()=>sync.sync({diagnostic:true}),clock:()=>time,now:()=>100000,log:x=>logs.push(x)});
 const commit=async e=>{time+=20;if(failWrite)throw Error('Firebase failure');if(done.has(e.callback.callback_id))return {duplicate:true};done.add(e.callback.callback_id);if(e.timestamp<=lastEventAt)return {applied:false,reason:'stale'};lastEventAt=e.timestamp;revision++;participants=participants.filter(p=>p.clientId!==self.clientId);if(e.callback.payload.endsWith(':yes'))participants.push(self);return {applied:true}};
 return {make,view,api,loadView,sync,logs,puts,commit,render:()=>text,clock:()=>time,peak:()=>peak,failMax:n=>failMax=n,failWrite:v=>failWrite=v,binding:v=>binding=v,external:p=>{participants=structuredClone(p);revision++},setLast:t=>lastEventAt=t};
}
test('successful yes previews before Firebase resolves, then confirms without profile name',async()=>{
 const f=fixture([other]),controller=f.make();let release,writeStarted=false;
 const pending=controller.run(event(),()=>{writeStarted=true;return new Promise(r=>release=()=>f.commit(event()).then(r))},0);
 await new Promise(r=>setImmediate(r));assert.equal(writeStarted,true);assert.match(f.render(),/не подтверждено FitPP/);assert.match(f.render(),/Вымышленный клиент/);assert.match(f.render(),/Другой тестовый клиент/);assert.equal(f.view().participants.length,1);
 release();await pending;assert.equal(f.view().participants.length,2);assert.ok(!f.render().includes('не подтверждено'));assert.match(f.render(),/Записано \(2\)/);assert.equal(f.logs[0].correctiveUpdates,0);assert.ok(f.logs[0].firstPutMs<f.logs[0].firebaseConfirmMs);
 assert.ok(!JSON.stringify(f.logs).includes(self.name));
});
test('successful cancellation previews removal and finally confirms only remaining clients',async()=>{
 const f=fixture([self,other]),e=event('cancel');await f.make().run(e,()=>f.commit(e),0);
 assert.ok(!f.render().includes(self.name));assert.match(f.render(),/Другой тестовый клиент/);assert.match(f.puts[0],/Предварительный список/);assert.ok(!f.puts[0].includes(self.name));assert.equal(f.puts.length,2);
});
test('Firebase failure corrects MAX to authoritative bookings and remains retryable',async()=>{
 const f=fixture([other]);f.failWrite(true);await assert.rejects(()=>f.make().run(event(),()=>f.commit(event()),0),/Firebase failure/);
 assert.equal(f.view().participants.length,1);assert.ok(!f.render().includes(self.name));assert.match(f.render(),/Записано \(1\)/);assert.equal(f.logs[0].firebaseConfirmed,false);assert.equal(f.logs[0].firebaseConfirmMs,null);assert.equal(f.logs[0].correctiveUpdates,1);
});
test('MAX preview failure does not prevent Firebase; confirmed sync repairs display',async()=>{
 const f=fixture();f.failMax(1);await f.make().run(event(),()=>f.commit(event()),0);assert.match(f.render(),/Записано \(1\)/);assert.equal(f.logs[0].previewFailed,true);assert.equal(f.logs[0].reconciled,true);
});
test('double callback rechecks durable order and makes no second optimistic or confirmed PUT',async()=>{
 const f=fixture(),controller=f.make(),e=event();await Promise.all([controller.run(e,()=>f.commit(e),0),controller.run(e,()=>f.commit(e),0)]);
 assert.equal(f.view().participants.length,1);assert.equal(f.puts.length,2);assert.equal(f.logs[1].optimisticUsed,false);assert.equal(f.peak(),1);
});
test('external client action during pending write is preserved by final Firestore reconciliation',async()=>{
 const f=fixture(),e=event();await f.make().run(e,async()=>{f.external([other]);return f.commit(e)},0);
 assert.match(f.render(),/Записано \(2\)/);assert.match(f.render(),/Другой тестовый клиент/);assert.equal(f.logs[0].correctiveUpdates,1);
});
test('stale callback uses confirmed path and never flashes cancelled participant',async()=>{
 const f=fixture([other]);f.setLast(100000);const e=event('yes',99999);await f.make().run(e,()=>f.commit(e),0);
 assert.equal(f.logs[0].optimisticUsed,false);assert.ok(f.puts.every(t=>!t.includes('Предварительный')));assert.ok(!f.render().includes(self.name));
});
test('restart recovers pending display from Firestore and persisted order blocks duplicate optimism',async()=>{
 const f=fixture();f.failWrite(true);f.failMax(0);const e=event();const controller=createOptimistic({scope,loadView:f.loadView,api:f.api,reconcile:async()=>{throw Error('MAX offline')},now:()=>100000,clock:f.clock});
 await assert.rejects(()=>controller.run(e,()=>f.commit(e),0));assert.match(f.render(),/не подтверждено/);
 await createPollSync({scope,loadView:async()=>f.view(),api:f.api}).sync();assert.match(f.render(),/Записано \(0\)/);
 f.failWrite(false);await f.make().run(e,()=>f.commit(e),0);const count=f.puts.length;await f.make().run(e,()=>f.commit(e),0);assert.equal(f.puts.length,count);
});
test('missing confirmed binding falls back; no name is taken from MAX profile',async()=>{
 const f=fixture();f.binding(false);const e=event();e.callback.user.first_name='PRIVATE PROFILE NAME';await f.make().run(e,()=>f.commit(e),0);
 assert.equal(f.logs[0].optimisticUsed,false);assert.ok(!f.puts.join().includes('PRIVATE PROFILE'));assert.equal(f.puts.length,1);
});
test('shared queue serializes actions from separately scoped clients and background sync',async()=>{
 const f=fixture(),loop=startReconciliation(null),first=f.make();let release;
 const a=loop.run(()=>first.run(event(),()=>new Promise(r=>release=()=>f.commit(event()).then(r)),0));await new Promise(r=>setImmediate(r));
 const secondScope={...scope,user:'9999'};const second=createOptimistic({scope:secondScope,api:f.api,loadView:async()=>({...f.view(),optimistic:{userId:'9999',...other,lastEventAt:0,openedAt:1,closesAt:200000}}),now:()=>100000,reconcile:()=>f.sync.sync()});
 const e=event('yes',100001,'second');e.callback.user.user_id=9999;
 const b=loop.run(()=>second.run(e,async()=>{f.external([self,other]);return {applied:true}}));release();await Promise.all([a,b]);assert.match(f.render(),/Записано \(2\)/);assert.equal(f.peak(),1);loop.stop();
});
test('callback while previous MAX PUT is pending waits; Firebase confirmation alone cannot finalize early',async()=>{
 const f=fixture();let release,order=[];
 const api={syncPollText:async text=>{order.push('preview-start');await new Promise(r=>release=r);order.push('preview-end');return {edited:true}}};
 const controller=createOptimistic({scope,loadView:f.loadView,api,reconcile:async()=>{order.push('reconcile');return {puts:1,text:render({...f.view(),participants:[self]},scope)}},now:()=>100000});
 const work=controller.run(event(),async()=>{order.push('commit');return {applied:true}});await new Promise(r=>setImmediate(r));assert.ok(order.includes('commit'));assert.ok(!order.includes('reconcile'));release();await work;assert.ok(order.indexOf('preview-end')<order.indexOf('reconcile'));
});
test('old mediator or failed snapshot safely uses confirmed path and still reconciles on Firebase error',async()=>{
 const f=fixture();f.failWrite(true);let reconciled=0;
 const controller=createOptimistic({scope,loadView:async()=>{throw Error('snapshot unavailable')},api:f.api,reconcile:async()=>{reconciled++;return f.sync.sync()},now:()=>100000});
 await assert.rejects(()=>controller.run(event(),()=>f.commit(event())),/Firebase/);assert.equal(reconciled,1);assert.ok(f.puts.every(t=>!t.includes('Предварительный')));
});
test('successful corrective PUT remains counted if the final verification later fails',async()=>{
 const f=fixture();f.failWrite(true);const logs=[];
 const controller=createOptimistic({scope,loadView:f.loadView,api:f.api,now:()=>100000,log:x=>logs.push(x),reconcile:async({onPut})=>{onPut({at:100,text:'confirmed old state'});throw Error('final read unavailable')}});
 await assert.rejects(()=>controller.run(event(),()=>f.commit(event())),/Firebase/);assert.equal(logs[0].correctiveUpdates,1);assert.equal(logs[0].finalPuts,1);assert.equal(logs[0].reconciled,false);
});
test('receiver enters optimistic flow only after the existing exact callback guards',async()=>{
 const {receiver}=require('../src/fitpp-test-bridge');let invoked=0,commits=0;
 const s={key:'a'.repeat(64),url:'https://example.test/bot/update',scope};
 const receiverUnderTest=receiver(s,{now:()=>100000,clock:()=>0,log:()=>{},optimistic:{run:async(e,commit)=>{invoked++;return commit()}},transport:async()=>{commits++;return {ok:true,json:async()=>({applied:true})}}});
 for(const mutate of [e=>e.message.body.mid='mid.other',e=>e.message.recipient.chat_id='-1',e=>e.callback.user.user_id=9999,e=>e.callback.payload='poll:wrong:yes']){const e=event();mutate(e);await receiverUnderTest.receive(e)}
 assert.equal(invoked,0);assert.equal(commits,0);await receiverUnderTest.receive(event());assert.equal(invoked,1);assert.equal(commits,1);
});
