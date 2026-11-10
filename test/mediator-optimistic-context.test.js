'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const USER='5819064',POLL={chat:'-79450912874680',mid:'mid.mock',uuid:'test-uuid',date:'2026-10-26',location:'zarya',workoutId:'zarya_2026-10-26',closesAt:200000},scope={...POLL,openedAt:1};
const key=(...x)=>JSON.stringify(x),prefix='fitppTestWorkspaces/synthetic-v1/';
function fixture(){const docs=new Map(),reads=[];let cancelled=false;
 docs.set(prefix+'maxBindings/'+hash(USER),{active:true,clientId:'demo-client-1'});docs.set(prefix+'maxPolls/'+hash([POLL.chat,POLL.mid]),{...POLL,openedAt:1,open:true});docs.set(prefix+'maxClientBindings/'+hash('demo-client-1'),{userHash:hash(USER)});docs.set(prefix+'bookingVersions/'+hash(key('demo-client-1',POLL.date,POLL.location)),{eventAt:90000,booked:false});
 const main={clients:[{id:'demo-client-1',name:'Fictional <&>',locations:['zarya']}]},bookings={entries:{}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../integration/fitpp-mediator/optimistic-context.cjs'),'utf8'),{module,require:p=>p==='./service.cjs'?{hash,bookingKey:key}:p==='./pilot-policy.cjs'?{USER,POLL}:{createProductionPricingModel:()=>({workoutsOn:()=>[{id:POLL.workoutId,cancelled}]})}});
 const tx={get:async r=>{reads.push(r.path);return {exists:docs.has(r.path),data:()=>docs.get(r.path)}},set:()=>{throw Error('WRITE_FORBIDDEN')}};
 return {docs,main,bookings,reads,cancel:v=>cancelled=v,read:()=>module.exports.optimisticContext(tx,{doc:path=>({path})},main,bookings,scope)};
}
test('context comes only from reciprocal Firestore binding, card and version in read-only snapshot',async()=>{
 const f=fixture(),before=JSON.stringify([...f.docs]);const context=await f.read();assert.equal(context.userId,USER);assert.equal(context.clientId,'demo-client-1');assert.equal(context.name,f.main.clients[0].name);assert.equal(context.lastEventAt,90000);assert.equal(f.reads.length,4);assert.equal(JSON.stringify([...f.docs]),before);
});
test('wrong binding, reverse link, poll identity/cutover, cancelled workout or inconsistent version disables preview',async()=>{
 const cases=[f=>f.docs.get(prefix+'maxBindings/'+hash(USER)).active=false,f=>f.docs.get(prefix+'maxClientBindings/'+hash('demo-client-1')).userHash='wrong',f=>f.docs.get(prefix+'maxPolls/'+hash([POLL.chat,POLL.mid])).uuid='wrong',f=>f.docs.get(prefix+'maxPolls/'+hash([POLL.chat,POLL.mid])).openedAt=2,f=>f.cancel(true),f=>f.docs.get(prefix+'bookingVersions/'+hash(key('demo-client-1',POLL.date,POLL.location))).booked=true];
 for(const change of cases){const f=fixture();change(f);assert.equal(await f.read(),null)}
});
