'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('../src/fitpp-notification-recovery.cjs');
const {createSender,reserve,createExpirySender}=require('../src/fitpp-notification-send.cjs');
const {createExpirySession,expiryTime}=require('../src/fitpp-subscription-notifications.cjs');
const receipts=require('../src/fitpp-receipt-notifications.cjs');
const env={BOT_MODE:'test',FIREBASE_PROJECT_ID:'fitpp-test',TEST_EXPECTED_BOT_ID:'131384398',TEST_BOT_TOKEN:'mock',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',FITPP_NOTIFICATION_RECEIPTS_ENABLED:'true',FITPP_NOTIFICATION_EXPIRY_ENABLED:'true'};
function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fitpp-participants-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binding={version:1,botId:131384398,bindings:[1,2].map(n=>({clientId:'demo-client-'+n,maxChatId:70+n,maxUserId:80+n,notificationsEnabled:true,recoverNotifications:true}))};
 const state={...structuredClone(require('../direct-core/fixtures/main.json')),clients:[],workouts:{},visits:{},visitOps:{},attendanceOps:{},mutationReceipts:{}};
 for(let n=1;n<=2;n++){
  const cid='demo-client-'+n,sub='sub'+n,wid='w'+n;
  state.clients.push({id:cid,subscriptions:[{id:sub,saleOperationId:'cycle'+n,left:5,expires:'2026-11-27'}]});
  state.workouts[wid]={id:wid,date:'2026-10-29',location:'pole',cancelled:false};
  state.visits[wid]={[cid]:'attended'};
  state.visitOps[wid]={[cid]:{operationId:'operation-'+n,subscriptionId:sub,status:'attended',workoutId:wid,location:'pole'}};
  state.mutationReceipts['purchase'+n]={type:'subscription',event:{version:1,operationId:'purchase'+n,cycleId:'cycle'+n,clientId:cid,subscriptionId:sub,oldExpires:null,newExpires:'2026-11-20',sessions:8}};
 }
 const sends=[];const raw={request:async(method,url)=>{
  if(url==='/me')return {user_id:131384398,username:'id623401053090_1_bot',is_bot:true};
  const row=binding.bindings.find(b=>url==='/chats/'+b.maxChatId);a.ok(row);
  return {chat_id:row.maxChatId,type:'dialog',status:'active',dialog_with_user:{user_id:row.maxUserId,is_bot:false}};
 },send:async(chat,body)=>{sends.push({chat,body});return 'mid.mock'}};
 return {state,binding,directory,raw,sends,env,now:()=>Date.parse('2026-10-29T18:00:00Z'),readFresh:async()=>({main:state,binding})};
}
test('second participant receives live attendance, purchase, extension, freeze and expiry in own verified dialog',async t=>{
 const f=setup(t),cid='demo-client-2';
 const item={clientId:cid,maxChatId:72,operationId:'new-visit-123',remaining:5,previous:6,status:'missed',date:'2026-10-29',workoutId:'new-w'};
 a.equal(await createSender(f).send(item,f.binding),'sent');
 const rs=receipts.createReceiptSession();rs.check(f.state,f.binding);
 for(const [id,type]of [['purchase-new','subscription'],['extend-new','extendSubscription'],['freeze-new','freeze']]){
  f.state.mutationReceipts[id]={type,event:{version:1,operationId:id,cycleId:'cycle2',clientId:cid,subscriptionId:'sub2',oldExpires:type==='subscription'?null:'2026-11-20',newExpires:'2026-11-27',...(type==='subscription'?{sessions:8}:{days:7}),...(type==='freeze'?{freezeStart:'2026-10-29',returnDate:'2026-11-05'}:{})}};
 }
 const items=rs.check(f.state,f.binding);a.deepEqual(items.map(x=>x.kind),['purchase','extension','freeze']);
 for(const item of items)a.equal(await receipts.createReceiptSender(f).send(item,f.state,f.binding),'sent');
 const expiry=createExpirySession({clientId:cid}),due=expiryTime('2026-11-27');expiry.check(f.state,f.binding,due-1000);
 const [expired]=expiry.check(f.state,f.binding,due);a.equal(expired.clientId,cid);
 a.equal(await createExpirySender(f).send(expired,f.binding,due),'sent');
 a.equal(f.sends.length,5);a.ok(f.sends.every(s=>s.chat==='72'));
});
test('recovery sends only unattempted events once across repeat/restart and keeps first participant claims',async t=>{
 const f=setup(t);reserve(f.directory,'receipt-v1:purchase1');reserve(f.directory,'operation-1');
 a.deepEqual(await R.recover(f),['sent','sent']);a.equal(f.sends.length,2);a.ok(f.sends.every(s=>s.chat==='72'));
 a.match(f.sends.find(s=>s.body.text.includes('Посещение')).body.text,/Сейчас по абонементу осталось занятий: 5/);
 a.deepEqual(await R.recover(f),[]);a.equal(f.sends.length,2);
 a.equal(await createSender(f).send({clientId:'demo-client-2',maxChatId:72,operationId:'operation-2',workoutId:'w2',date:'2026-10-29',status:'attended',previous:6,remaining:5},f.binding),'duplicate');
});
test('unknown legacy attempts and uncertain recovery are never resent; subsequent events remain live',async t=>{
 const f=setup(t);f.binding.bindings[0].recoverNotifications=false;
 reserve(f.directory,'receipt-v1:purchase2');f.raw.send=async()=>{throw Error('unknown transport outcome')};
 a.deepEqual(await R.recover(f),['uncertain']);a.deepEqual(await R.recover(f),[]);
 f.raw.send=async(chat,body)=>f.sends.push({chat,body});
 a.equal(await createSender(f).send({clientId:'demo-client-2',maxChatId:72,operationId:'future-visit-12',workoutId:'future-w',date:'2026-10-30',status:'attended',previous:5,remaining:4},f.binding),'sent');
});
test('disabled/foreign/archived client and changed live recipient cannot recover',async t=>{
 for(const mutate of [f=>f.binding.bindings.forEach(b=>b.notificationsEnabled=false),f=>f.binding.bindings.forEach(b=>b.recoverNotifications=false),f=>f.state.clients.forEach(c=>c.archivedAt=1)]){
  const f=setup(t);mutate(f);a.deepEqual(await R.recover(f),[]);a.equal(f.sends.length,0);
 }
 const f=setup(t),request=f.raw.request;f.raw.request=async(...args)=>{const value=await request(...args);if(value.dialog_with_user)value.dialog_with_user.user_id=999;return value};
 await a.rejects(R.recover(f),/RECIPIENT_REFUSED/);a.equal(f.sends.length,0);a.equal(fs.readdirSync(f.directory).length,0);
});
test('stale/cancelled operations are not replayed and expiry recovery uses existing deduplication keys',async t=>{
 const f=setup(t);f.binding.bindings[0].recoverNotifications=false;
 f.state.visits.w2['demo-client-2']='excused';
 f.state.clients[1].subscriptions[0].expires='2026-10-20';
 // Purchase with later terms is stale; no fabricated replacement operation.
 const pending=R.candidates(f.state,f.binding,f.now());a.deepEqual(pending.map(x=>x.kind),['expiry']);
 a.deepEqual(await R.recover(f),['sent']);a.match(f.sends[0].body.text,/Срок абонемента истёк/);
 a.deepEqual(await R.recover(f),[]);
});

test('real watcher recovers second participant purchase and attendance after activation, with no replay on restart',async t=>{
 const f=setup(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'fitpp-recovery-watcher-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const marker='fitpp-test:synthetic-v1:training-test:v1';fs.writeFileSync(path.join(root,'.fitpp-notification-volume'),marker);
 f.binding.bindings[0].recoverNotifications=false;
 const wire=v=>v===null?{nullValue:null}:Array.isArray(v)?{arrayValue:{values:v.map(wire)}}:typeof v==='object'?{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,wire(x)]))}}:typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{booleanValue:v}:{integerValue:String(v)};
 const sent=[];t.mock.method(console,'log',()=>{});
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);let data;
  if(url.origin==='https://identitytoolkit.googleapis.com'){
   a.equal(options.method,'POST');
   const uid='lLlMAetSG1aEeJSeBl4F4ypydEh2',claims={aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:uid,exp:Math.floor(Date.now()/1000)+3600};
   data={localId:uid,idToken:'h.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.s'};
  }else if(url.origin==='https://firestore.googleapis.com'){
   a.equal(options.method,'GET');a.match(url.pathname,/^\/v1\/projects\/fitpp-test\/databases\/\(default\)\/documents\/fitppTestWorkspaces\/synthetic-v1\//);
   const value=url.pathname.endsWith('/states/main')?f.state:f.binding;data={name:url.pathname.slice(4),fields:wire(value).mapValue.fields};
  }else{
   a.equal(url.origin,'https://platform-api2.max.ru');
   if(options.method==='POST'){a.equal(url.pathname,'/messages');sent.push({chat:url.searchParams.get('chat_id'),body:JSON.parse(options.body)});data={message:{body:{mid:'mid.fake'}}};}
   else{a.equal(options.method,'GET');data=await f.raw.request('GET',url.pathname)}
  }
  return {ok:true,json:async()=>data};
 });
 const run=()=>require('../fitpp-notification-test.cjs').main({...env,FIREBASE_API_KEY:'fake',FIREBASE_BOT_EMAIL:'test@example.invalid',FIREBASE_BOT_PASSWORD:'fake',FITPP_NOTIFICATION_STORAGE_CONFIRMED:marker,FITPP_NOTIFICATION_RECEIPTS_ENABLED:'true'},['--send','--watch'],{storageRoot:root,wait:async()=>{throw Error('STOP_TEST')}});
 await a.rejects(run(),/STOP_TEST/);a.equal(sent.length,2);a.ok(sent.every(s=>s.chat==='72'));
 await a.rejects(run(),/STOP_TEST/);a.equal(sent.length,2);
});


test('recovery respects receipt/expiry switches and defers disabled kinds until enabled',async t=>{
 const f=setup(t);f.binding.bindings[0].recoverNotifications=false;
 f.env={...env,FITPP_NOTIFICATION_RECEIPTS_ENABLED:'false',FITPP_NOTIFICATION_EXPIRY_ENABLED:'false'};
 a.deepEqual(await R.recover(f),['sent']);a.equal(f.sends.length,1);a.match(f.sends[0].body.text,/Посещение/);
 f.env={...env};a.deepEqual(await R.recover(f),['sent']);a.equal(f.sends.length,2);a.match(f.sends[1].body.text,/Покупка/);
 a.deepEqual(await R.recover(f),[]);
});

test('recovery compares receipt meaning across reordered Firestore map fields',async t=>{
 const f=setup(t);f.binding.bindings[0].recoverNotifications=false;
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
   ?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
 const fresh=reorder(f.state);
 f.readFresh=async()=>({main:fresh,binding:reorder(f.binding)});
 a.deepEqual(await R.recover(f),['sent','sent']);
 a.equal(f.sends.length,2);
 a.deepEqual(await R.recover(f),[]);
});
