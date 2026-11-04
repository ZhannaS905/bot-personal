'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// Deliberately use the ACTUAL Desktop UI writer, not direct-core's old Pilot.
const UI=require('../../fitpp-ui/legacy/FitPP-Test/operations.js');
const E=require('../../fitpp-ui/legacy/FitPP-Test/persistence.js').createProductionPricingModel();
const G=require('../../fitpp-ui/legacy/FitPP-Test/group-period-model.js');
const N=require('../src/fitpp-unified-attendance-notifications.cjs');
const {createPreviewSession}=require('../src/fitpp-notification-dry-run.cjs');
const {createSender}=require('../src/fitpp-notification-send.cjs');
const uid=UI.UID,day=UI.today(),wid='pole_extra_current-ui-attendance';
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'current-ui-attendance-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let state={...E.read({}),ownerUid:uid,datasetId:'synthetic-v1',schemaVersion:1,attendanceRevision:0,mutationReceipts:{}};
 state.clients=[{id:'demo-client-1',name:'Local',locations:['pole'],money:{version:1,entries:[]},subscriptions:[{id:'sub-current',location:'pole',price:3800,left:6,startDate:'2026-10-01',expires:'2026-12-01'}]}];
 state.workouts[wid]={id:wid,date:day,originDate:day,location:'pole',time:'18:30',cancelled:false,extra:true};
 const binding={version:1,botId:131384398,bindings:[{clientId:'demo-client-1',maxUserId:80,maxChatId:70,notificationsEnabled:true}]};
 const trainer={groupScheduleV1:G.empty(uid)},bookings={ownerUid:uid,datasetId:'synthetic-v1',entries:{}};
 const snapshot=p=>({exists:true,metadata:{fromCache:false,hasPendingWrites:false},data:()=>structuredClone(p===UI.MAIN?state:p.startsWith('trainers/')?trainer:bookings)});
 const db={app:{options:{projectId:'fitpp-test'}},doc:p=>({path:p,get:async()=>snapshot(p)}),runTransaction:async fn=>{
  const changes=[];const result=await fn({get:async ref=>snapshot(ref.path),update:(ref,patch)=>changes.push([ref,patch])});
  for(const [ref,patch]of changes){a.equal(ref.path,UI.MAIN);state={...state,...patch}}return result;
 }};
 return {directory,binding,read:()=>structuredClone(state),write:value=>state=value,async mark(status,id){
  return UI.execute({db,uid,expectedFingerprint:E.fingerprint(E.read(state)),operationDay:day,
   action:{type:'attendance',clientId:'demo-client-1',workoutId:wid,date:day,location:'pole',status,operationId:id}});
 }};
}
for(const status of ['attended','missed'])test(`actual Desktop UI ${status}: durable receipt detected while legacy revision detector misses it`,async t=>{
 const f=fixture(t),before=f.read(),legacy=createPreviewSession(),session=N.createSession(f);
 legacy.check(before,f.binding);a.deepEqual(session.check(before,f.binding),[]);
 await f.mark(status,'actual-ui-'+status);
 const after=f.read();a.equal(after.attendanceRevision,before.attendanceRevision);a.equal(after._fitppRevision,before._fitppRevision+1);
 a.equal(legacy.check(after,f.binding).candidates.length,0); // Original incident reproduced.
 const [item]=session.check(after,f.binding);a.ok(item);a.equal(item.status,status);a.equal(item.remaining,5);
 const sends=[],raw={request:async(method,url)=>url==='/me'?{user_id:131384398,username:'id623401053090_1_bot',is_bot:true}:{chat_id:70,type:'dialog',status:'active',dialog_with_user:{user_id:80,is_bot:false}},send:async(chat,body)=>{sends.push({chat,body});return 'mid.local'}};
 const env={BOT_MODE:'test',FIREBASE_PROJECT_ID:'fitpp-test',TEST_EXPECTED_BOT_ID:'131384398',TEST_BOT_TOKEN:'mock',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false'};
 const sender=createSender({directory:f.directory,env,raw});
 a.equal(await sender.send(item,f.binding),'sent');a.match(sends[0].body.text,status==='attended'?/Посещение/:/Занятие сгорело/);
 a.deepEqual(session.check(after,f.binding),[]);
 const restarted=N.createSession(f),[retry]=restarted.check(after,f.binding);a.ok(retry);
 a.equal(await sender.send(retry,f.binding),'duplicate');a.equal(sends.length,1);
 await f.mark(status==='attended'?'missed':'attended','changed-ui-'+status);
 const [changed]=session.check(f.read(),f.binding);a.ok(changed);
 a.equal(await sender.send(changed,f.binding),'sent');a.equal(sends.length,2);
 a.equal(await sender.send(changed,f.binding),'duplicate');a.equal(sends.length,2);
});
test('first activation does not restore historical attendance; later receipts survive snapshot gaps',async t=>{
 const f=fixture(t);await f.mark('attended','old-attendance');
 const s=N.createSession(f);a.deepEqual(s.check(f.read(),f.binding),[]);
 await f.mark(null,'clear-attendance');await f.mark('missed','new-attendance');
 const [item]=s.check(f.read(),f.binding);a.equal(item.status,'missed');
});
test('latest cancel, tampered receipt, unlinked recipient and changed operation never send',async t=>{
 const f=fixture(t),s=N.createSession(f);s.check(f.read(),f.binding);await f.mark('attended','new-attendance');const state=f.read();
 const [item]=s.check(state,f.binding);a.ok(N.current(item,state,f.binding));
 await f.mark(null,'cancel-attendance');a.equal(N.current(item,f.read(),f.binding),false);a.deepEqual(N.candidates(f.read(),f.binding),[]);
 const bad=structuredClone(state);bad.mutationReceipts['new-attendance'].signature='invalid';a.deepEqual(N.candidates(bad,f.binding),[]);
 a.deepEqual(N.candidates(state,{...f.binding,bindings:[]}),[]);
 const changed=structuredClone(state);changed.visitOps[wid]['demo-client-1'].operationId='changed-operation';a.equal(N.current(item,changed,f.binding),false);
});

for(const status of ['attended','missed'])test(`actual Desktop writer -> real watcher -> personal MAX transport: ${status}`,async t=>{
 const f=fixture(t),{main}=require('../fitpp-notification-test.cjs');
 const marker='fitpp-test:synthetic-v1:training-test:v1';fs.writeFileSync(path.join(f.directory,'.fitpp-notification-volume'),marker);
 const encode=v=>v===null?{nullValue:null}:Array.isArray(v)?{arrayValue:{values:v.map(encode)}}:typeof v==='object'?{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]))}}:typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{booleanValue:v}:{integerValue:String(v)};
 const posts=[],logs=[];t.mock.method(console,'log',x=>logs.push(x));
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);let data;
  if(url.hostname==='identitytoolkit.googleapis.com'){
   const claims={aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:uid,exp:Math.floor(Date.now()/1000)+3600};
   data={localId:uid,idToken:'h.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.s'};
  }else if(url.hostname==='firestore.googleapis.com'){
   a.equal(options.method,'GET');a.match(url.pathname,/projects\/fitpp-test\//);
   data={name:url.pathname.slice(4),fields:encode(url.pathname.endsWith('/states/main')?f.read():f.binding).mapValue.fields};
  }else{
   a.equal(url.hostname,'platform-api2.max.ru');
   if(url.pathname==='/me')data={user_id:131384398,username:'id623401053090_1_bot',is_bot:true};
   else if(url.pathname==='/chats/70')data={chat_id:70,type:'dialog',status:'active',dialog_with_user:{user_id:80,is_bot:false}};
   else{a.equal(url.pathname,'/messages');a.equal(options.method,'POST');a.equal(url.search,'?chat_id=70');posts.push(JSON.parse(options.body));data={message:{body:{mid:'mid.local'}}};}
  }
  return {ok:true,json:async()=>data};
 });
 const env={BOT_MODE:'test',FIREBASE_PROJECT_ID:'fitpp-test',TEST_EXPECTED_BOT_ID:'131384398',TEST_BOT_TOKEN:'mock',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',FIREBASE_API_KEY:'mock',FIREBASE_BOT_EMAIL:'local@example.invalid',FIREBASE_BOT_PASSWORD:'mock',FITPP_NOTIFICATION_STORAGE_CONFIRMED:marker};
 const stop=Error('STOP');let n=0;
 await a.rejects(main(env,['--send','--watch'],{storageRoot:f.directory,wait:async()=>{
  if(++n===1)await f.mark(status,'watcher-current-'+status);
  if(n===3)throw stop;
 }}),e=>e===stop);
 a.equal(posts.length,1);a.match(posts[0].text,status==='attended'?/Посещение/:/Занятие сгорело/);
 a.ok(logs.includes('FITPP_NOTIFICATION_RESULT sent'));
});
