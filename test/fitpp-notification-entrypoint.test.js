'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {main}=require('../fitpp-notification-test.cjs');
const preview=require('../fitpp-notification-preview.cjs');
const env={BOT_MODE:'test',FIREBASE_PROJECT_ID:'fitpp-test',TEST_EXPECTED_BOT_ID:'131384398',TEST_BOT_TOKEN:'mock',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',FIREBASE_API_KEY:'fake-key',FIREBASE_BOT_EMAIL:'fake@example.invalid',FIREBASE_BOT_PASSWORD:'fake-password',FITPP_NOTIFICATION_STORAGE_CONFIRMED:'fitpp-test:synthetic-v1:training-test:v1',CHAT_IDS:'-80345864298680'};
const uid='lLlMAetSG1aEeJSeBl4F4ypydEh2';
const binding={version:1,botId:131384398,bindings:[{clientId:'demo-client-1',maxChatId:126619382,maxUserId:5819064,notificationsEnabled:true}]};
function snapshots(){
  const before={...structuredClone(require('../direct-core/fixtures/main.json')),_fitppRevision:90,attendanceRevision:112,clients:[{id:'demo-client-1',subscriptions:[{id:'sub',left:6}]}],visits:{},visitOps:{},attendanceOps:{},workouts:{w:{id:'w',date:'2026-10-26',location:'zarya',cancelled:false}}};
  const after=structuredClone(before);after.attendanceRevision++;after.clients[0].subscriptions[0].left=5;
  after.visits.w={'demo-client-1':'attended'};after.visitOps.w={'demo-client-1':{operationId:'entrypoint-operation-1234',subscriptionId:'sub',status:'attended',workoutId:'w',location:'zarya'}};
  return [before,after,after];
}
function wire(v){
  if(v===null)return {nullValue:null};if(Array.isArray(v))return {arrayValue:{values:v.map(wire)}};
  if(typeof v==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,wire(x)]))}};
  return typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{booleanValue:v}:{integerValue:String(v)};
}
function fixture(t,{wrongUser=false}={}){
  const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'fitpp-entrypoint-'));
  fs.writeFileSync(path.join(storageRoot,'.fitpp-notification-volume'),env.FITPP_NOTIFICATION_STORAGE_CONFIRMED);
  const calls=[],logs=[],states=snapshots();let reads=0,waits=0;
  t.after(()=>fs.rmSync(storageRoot,{recursive:true,force:true}));
  t.mock.method(console,'log',line=>logs.push(line));
  // Every fetch is intercepted. Unknown URLs fail before any network transport.
  t.mock.method(global,'fetch',async(input,options)=>{
    const url=new URL(input);calls.push({url,options});let data;
    if(url.origin==='https://identitytoolkit.googleapis.com'){
      assert.equal(options.method,'POST');assert.equal(url.pathname,'/v1/accounts:signInWithPassword');
      const claims={aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:uid,exp:Math.floor(Date.now()/1000)+3600};
      data={localId:uid,idToken:'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature'};
    }else if(url.origin==='https://firestore.googleapis.com'){
      assert.equal(options.method,'GET');
      const prefix='/v1/projects/fitpp-test/databases/(default)/documents/fitppTestWorkspaces/synthetic-v1/';
      assert.ok(url.pathname===prefix+'states/main'||url.pathname===prefix+'notificationBindings/training-test');
      const value=url.pathname.endsWith('/states/main')?states[Math.min(reads++,states.length-1)]:binding;
      data={name:url.pathname.slice(4),fields:wire(value).mapValue.fields};
    }else{
      assert.equal(url.origin,'https://platform-api2.max.ru');assert.equal(options.headers.Authorization,'mock');
      if(url.pathname==='/me'){assert.equal(options.method,'GET');data={user_id:131384398,username:'id623401053090_1_bot',is_bot:true};}
      else if(url.pathname==='/chats/126619382'){assert.equal(options.method,'GET');data={chat_id:126619382,type:'dialog',status:'active',dialog_with_user:{user_id:wrongUser?999:5819064,is_bot:false}};}
      else {assert.equal(url.pathname,'/messages');assert.equal(options.method,'POST');assert.equal(url.search,'?chat_id=126619382');data={message:{body:{mid:'mock-mid'}}};}
    }
    assert.equal(options.redirect,'error');return {ok:true,json:async()=>data};
  });
  const stop=new Error('END_OF_FIXTURE');
  const wait=async ms=>{assert.equal(ms,30000);if(++waits===3)throw stop;};
  return {storageRoot,wait,stop,calls,logs,states};
}
test('standalone dry-run: Auth -> fixed Firestore snapshots -> identity -> candidate, zero MAX writes or disk claims',async t=>{
  const f=fixture(t);await assert.rejects(main(env,['--watch'],f),e=>e===f.stop);
  assert.ok(f.logs.includes('FITPP_NOTIFICATION_RESULT dry-run'));
  assert.equal(f.calls.filter(c=>c.url.hostname==='platform-api2.max.ru'&&c.options.method!=='GET').length,0);
  assert.deepEqual(fs.readdirSync(f.storageRoot),['.fitpp-notification-volume']);
});
test('standalone send mode with intercepted fetch: baseline silent, one personal POST, repeat silent, durable claim',async t=>{
  const f=fixture(t);await assert.rejects(main(env,['--send','--watch'],f),e=>e===f.stop);
  const posts=f.calls.filter(c=>c.url.hostname==='platform-api2.max.ru'&&c.options.method==='POST');
  assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].options.body),{text:require('../src/fitpp-notification-send.cjs').formatNotification({...snapshots()[1],status:'attended',date:'2026-10-26',remaining:5}),notify:false});
  assert.equal(f.logs[0],'FITPP_NOTIFICATION_BASELINE no_history_send');
  assert.ok(f.logs.includes('FITPP_NOTIFICATION_RESULT sent'));
  assert.equal(fs.readdirSync(path.join(f.storageRoot,'fitpp-notification-attempts-v1')).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,2);
  assert.ok(fs.existsSync(path.join(f.storageRoot,'fitpp-notification-attempts-v1','attendance-baseline-v1.json')));
});
test('standalone verify exits without sending or creating storage',async t=>{
  const f=fixture(t);await main(env,['--verify'],f);
  assert.deepEqual(f.logs,['FITPP_NOTIFICATION_VERIFIED no_send no_firestore_write']);
  assert.equal(f.calls.length,5);assert.deepEqual(fs.readdirSync(f.storageRoot),['.fitpp-notification-volume']);
});
test('standalone refuses wrong live recipient before any message or reservation',async t=>{
  const f=fixture(t,{wrongUser:true});await assert.rejects(main(env,['--send','--watch'],f),/NOTIFICATION_RECIPIENT_REFUSED/);
  assert.ok(f.calls.every(c=>c.url.hostname!=='platform-api2.max.ru'||c.options.method==='GET'));
  assert.deepEqual(fs.readdirSync(path.join(f.storageRoot,'fitpp-notification-attempts-v1')),[]);
});
test('existing preview watcher delegates explicit send mode through prepared integration and blocks replay after restart',async t=>{
  const f=fixture(t);
  await assert.rejects(preview.main(env,['--send','--watch'],f),e=>e===f.stop);
  let waits=0;
  await assert.rejects(preview.main(env,['--send','--watch'],{...f,wait:async()=>{if(++waits===2)throw f.stop;}}),e=>e===f.stop);
  const posts=f.calls.filter(c=>c.url.hostname==='platform-api2.max.ru'&&c.options.method==='POST');
  assert.equal(posts.length,1);assert.equal(posts[0].url.search,'?chat_id=126619382');
  assert.ok(f.logs.includes('FITPP_NOTIFICATION_RESULT sent'));
  assert.ok(!f.logs.some(line=>line.startsWith('FITPP_PREVIEW_ONLY')));
  assert.equal(fs.readdirSync(path.join(f.storageRoot,'fitpp-notification-attempts-v1')).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,2);
  assert.ok(fs.existsSync(path.join(f.storageRoot,'fitpp-notification-attempts-v1','attendance-baseline-v1.json')));
});
test('existing watcher send mode refuses production, wrong recipient and ambiguous flags',async t=>{
  const f=fixture(t,{wrongUser:true});
  for(const args of [['--send'],['--send','--checks','4'],['--diagnose','--send','--watch'],['--send','--watch','--send']])
    await assert.rejects(preview.main(env,args,f),/ARGUMENT_REFUSED/);
  await assert.rejects(preview.main({...env,FIREBASE_PROJECT_ID:'fitpp-crm'},['--send','--watch'],f),/PROJECT_REFUSED/);
  assert.equal(f.calls.length,0);
  await assert.rejects(preview.main(env,['--send','--watch'],f),/NOTIFICATION_RECIPIENT_REFUSED/);
  assert.ok(f.calls.every(c=>c.url.hostname!=='platform-api2.max.ru'||c.options.method==='GET'));
});
test('actual preview CLI loads shared helpers before delegation and hides transport errors',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fitpp-cli-connect-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const hook=path.join(dir,'offline.cjs');
  fs.writeFileSync(hook,`const fs=require('node:fs');
require(require('node:path').join(process.cwd(),'src/fitpp-notification-lock.cjs')).acquire=async()=>({close(){}});
const stat=fs.statSync,mkdir=fs.mkdirSync,read=fs.readFileSync;
fs.readFileSync=function(p,...args){if(p==='/app/data/.fitpp-notification-volume')return 'fitpp-test:synthetic-v1:training-test:v1';return read.call(this,p,...args)};
fs.statSync=function(p,...args){return p==='/app/data'?{isDirectory:()=>true}:stat.call(this,p,...args)};
fs.mkdirSync=function(p,...args){if(p==='/app/data/fitpp-notification-attempts-v1')return;return mkdir.call(this,p,...args)};
global.fetch=async()=>{console.log('TEST_AUTH_INTERCEPTED');throw Error('private-transport-detail')};
`);
  const result=require('node:child_process').spawnSync(process.execPath,['--require',hook,path.resolve(__dirname,'../fitpp-notification-preview.cjs'),'--send','--watch'],{env:{...process.env,...env},encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout.trim(),'TEST_AUTH_INTERCEPTED');
  assert.equal(result.stderr.trim(),'FITPP_NOTIFICATION_FAILED CHECK_FAILED');
  assert.ok(!result.stderr.includes('private-transport-detail'));
});
test('live mode requires operator-confirmed persistent volume before network',async t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.storageRoot,'.fitpp-notification-volume'));
 await assert.rejects(main(env,['--send','--watch'],f));assert.equal(f.calls.length,0);
 fs.writeFileSync(path.join(f.storageRoot,'.fitpp-notification-volume'),env.FITPP_NOTIFICATION_STORAGE_CONFIRMED);
 await assert.rejects(main({...env,FITPP_NOTIFICATION_STORAGE_CONFIRMED:''},['--send','--watch'],f),/DURABLE_STORAGE_REQUIRED/);assert.equal(f.calls.length,0);
});
test('verified Training Test volume accepts existing evidence, preserves journal and refuses missing or changed evidence',async t=>{
 const f=fixture(t),read=fs.readFileSync,stat=fs.statSync,mkdir=fs.mkdirSync;
 const claim='/app/data/fitpp-notification-attempts-v1/f50668b32b88ed07d5831a719737b31b6aff4c59b9f4b8f4aa6362a8bf7e3a3e';
 const evidence=new Map([['/app/data/fitpp-storage-check.txt','fitpp-storage-check-20261026\n'],[claim,'attempted\n']]);
 t.mock.method(fs,'readFileSync',(p,...args)=>{if(String(p)==='/app/data/fitpp-notification-attempts-v1/attendance-baseline-v1.json')return JSON.stringify({version:1,scope:'fitpp-test:synthetic-v1:training-test:attendance-v1',ids:[]});if(String(p).startsWith('/app/data/')){if(!evidence.has(p))throw Error('ENOENT');return evidence.get(p)}return read(p,...args)});
 t.mock.method(fs,'statSync',(p,...args)=>p==='/app/data'?{isDirectory:()=>true}:stat(p,...args));
 t.mock.method(fs,'mkdirSync',(p,...args)=>{if(p==='/app/data/fitpp-notification-attempts-v1')return;return mkdir(p,...args)});
 const liveEnv={...env,FITPP_NOTIFICATION_STORAGE_CONFIRMED:'fitpp-test:training-test:storage-check-20261026'};
 const options={...f,storageRoot:'/app/data',wait:async()=>{throw f.stop}};
 await assert.rejects(main(liveEnv,['--send','--watch'],options),e=>e===f.stop);
 assert.ok(f.logs.includes('FITPP_NOTIFICATION_BASELINE no_history_send'));
 assert.equal(evidence.get(claim),'attempted\n');
 const calls=f.calls.length;
 for(const [file,value] of [...evidence]){
   evidence.delete(file);await assert.rejects(main(liveEnv,['--send','--watch'],options));
   evidence.set(file,'wrong');await assert.rejects(main(liveEnv,['--send','--watch'],options),/DURABLE_STORAGE_REQUIRED/);
   evidence.set(file,value);
 }
 await assert.rejects(main(liveEnv,['--send','--watch'],f),/DURABLE_STORAGE_REQUIRED/);
 await assert.rejects(main({...liveEnv,FIREBASE_PROJECT_ID:'production'},['--send','--watch'],options));
 assert.equal(f.calls.length,calls);
 assert.ok(f.calls.every(c=>c.url.hostname!=='platform-api2.max.ru'||c.options.method==='GET'));
});

test('empty candidate logs are hourly per process while every poll and nonzero candidate proceeds immediately',async t=>{
  const f=fixture(t);
  // Baseline, empty poll, then a new attendance and repeated unchanged snapshots.
  f.states.splice(1,0,f.states[0]);
  const start=Date.now()+7200000;
  const times=[0,30000,60000,3629999,3630000];
  let now=start, polls=0;
  t.mock.method(Date,'now',()=>now);
  const zeroLogs=()=>f.logs.filter(line=>line==='FITPP_NOTIFICATION_CANDIDATES 0').length;
  const wait=async ms=>{
    assert.equal(ms,30000);
    polls++;
    if(polls===2)assert.equal(zeroLogs(),1);
    if(polls===3){
      assert.ok(f.logs.includes('FITPP_NOTIFICATION_CANDIDATES 1'));
      assert.ok(f.logs.includes('FITPP_NOTIFICATION_RESULT dry-run'));
    }
    if(polls===4)assert.equal(zeroLogs(),1); // one millisecond before the hour
    if(polls===5){assert.equal(zeroLogs(),2);throw f.stop;} // exactly one hour
    now=start+times[polls];
  };
  await assert.rejects(main(env,['--watch'],{...f,wait}),e=>e===f.stop);
  assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/states/main')).length,5);
  assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/notificationBindings/training-test')).length,5);
  // A second main invocation in the same process must retain the throttle.
  await assert.rejects(main(env,['--watch'],{...f,wait:async ms=>{
    assert.equal(ms,30000);if(++polls===7)throw f.stop;
  }}),e=>e===f.stop);
  assert.equal(zeroLogs(),2);
});

for(const status of ['attended','missed'])test(`temporary MAX verification failure retains pending ${status} without resetting baseline`,async t=>{
 const f=fixture(t);
 for(const state of f.states.slice(1)){
  state.visits.w['demo-client-1']=status;
  state.visitOps.w['demo-client-1'].status=status;
 }
 const intercepted=global.fetch;let checks=0;
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='platform-api2.max.ru'&&url.pathname==='/me'&&++checks===3)
   return {ok:false,status:503};
  return intercepted(input,options);
 });
 await assert.rejects(main(env,['--send','--watch'],f),e=>e===f.stop);
 assert.equal(f.calls.filter(c=>c.url.pathname==='/messages').length,1);
 assert.equal(f.logs.filter(s=>s==='FITPP_NOTIFICATION_BASELINE no_history_send').length,1);
 assert.ok(f.logs.includes('FITPP_NOTIFICATION_RETRY reason=MAX_HTTP_503'));
 assert.ok(f.logs.includes('FITPP_NOTIFICATION_RESULT sent'));
});

test('temporary Firestore read failure preserves baseline and later attendance transition',async t=>{
 const f=fixture(t),intercepted=global.fetch;let reads=0;
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='firestore.googleapis.com'&&url.pathname.endsWith('/states/main')&&++reads===2)
   return {ok:false,status:503};
  return intercepted(input,options);
 });
 await assert.rejects(main(env,['--send','--watch'],f),e=>e===f.stop);
 assert.equal(f.calls.filter(c=>c.url.pathname==='/messages').length,1);
 assert.equal(f.logs.filter(s=>s==='FITPP_NOTIFICATION_BASELINE no_history_send').length,1);
 assert.ok(f.logs.includes('FITPP_NOTIFICATION_RETRY reason=HTTP_503'));
});

test('failure diagnostics exclude arbitrary error text; only temporary transport failures retry',()=>{
 const {failureReason,transientFailure}=require('../fitpp-notification-test.cjs');
 assert.equal(failureReason(Error('secret body token=value')),'UNKNOWN');
 assert.equal(failureReason(Error('NOTIFICATION_RECIPIENT_REFUSED')),'NOTIFICATION_RECIPIENT_REFUSED');
 assert.equal(transientFailure(Error('NOTIFICATION_RECIPIENT_REFUSED')),false);
 assert.equal(transientFailure(Error('HTTP_403')),false);
 assert.equal(transientFailure(Error('MAX HTTP 429')),true);
 assert.equal(transientFailure(Object.assign(Error('private'),{cause:{code:'ECONNRESET'}})),true);
});

test('purchase remains queued after temporary pre-send verification error',async t=>{
 const f=fixture(t),before=f.states[0],after=structuredClone(before);
 before.mutationReceipts={};after.mutationReceipts={purchase1:{type:'subscription',event:{
  version:1,operationId:'purchase1',cycleId:'sub',clientId:'demo-client-1',
  subscriptionId:'sub',oldExpires:null,newExpires:'2026-12-01',sessions:8}}};
 before.clients[0].subscriptions[0].expires='2026-12-01';
 after.clients[0].subscriptions[0].expires='2026-12-01';
 f.states.splice(0,f.states.length,before,after,after);
 const intercepted=global.fetch;let checks=0;
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='platform-api2.max.ru'&&url.pathname==='/me'&&++checks===3)
   return {ok:false,status:503};
  return intercepted(input,options);
 });
 await assert.rejects(main({...env,FITPP_NOTIFICATION_RECEIPTS_ENABLED:'true'},['--send','--watch'],f),e=>e===f.stop);
 const posts=f.calls.filter(c=>c.url.pathname==='/messages');
 assert.equal(posts.length,1);
 assert.match(JSON.parse(posts[0].options.body).text,/Покупка/);
 assert.ok(f.logs.includes('FITPP_RECEIPT_RESULT sent'));
 assert.ok(f.logs.includes('FITPP_NOTIFICATION_RETRY reason=MAX_HTTP_503'));
});

test('queued attendance is discarded if cancelled before network recovers',async t=>{
 const f=fixture(t),intercepted=global.fetch;let checks=0,waits=0;
 t.mock.method(global,'fetch',async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='platform-api2.max.ru'&&url.pathname==='/me'&&++checks===3)
   return {ok:false,status:503};
  return intercepted(input,options);
 });
 const wait=async()=>{
  if(++waits===2){f.states[1].visits={};f.states[1].visitOps={};}
  if(waits===3)throw f.stop;
 };
 await assert.rejects(main(env,['--send','--watch'],{...f,wait}),e=>e===f.stop);
 assert.equal(f.calls.filter(c=>c.url.pathname==='/messages').length,0);
});
