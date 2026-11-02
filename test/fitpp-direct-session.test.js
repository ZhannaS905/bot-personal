'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settings,connect,OWNER_UID}=require('../src/fitpp-direct-session');
const {prepare}=require('../src/fitpp-direct-runtime');
const env=()=>({BOT_MODE:'test',FITPP_DIRECT_ENABLED:'true',FIREBASE_PROJECT_ID:'fitpp-test',FIREBASE_API_KEY:'synthetic-key',FIREBASE_BOT_UID:OWNER_UID,FIREBASE_BOT_EMAIL:'bot@example.invalid',FIREBASE_BOT_PASSWORD:'synthetic-password',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false'});
function fixture(uid=OWNER_UID,project='fitpp-test') {
 const calls=[],user={uid,getIdTokenResult:async()=>({claims:{aud:project,iss:'https://securetoken.google.com/'+project,sub:uid}})},auth={currentUser:user};
 const sdk={initializeApp:c=>(calls.push('init'),{options:c}),initializeAuth:()=>auth,inMemoryPersistence:{},signInWithEmailAndPassword:async()=>{calls.push('login');return {user}},getFirestore:app=>({app}),signOut:async()=>calls.push('logout'),terminate:async()=>calls.push('terminate'),deleteApp:async()=>calls.push('delete'),doc:(_,p)=>p,getDocFromServer:async()=>({exists:()=>true,data:()=>({})})};
 return {sdk,calls,auth};
}
test('auth-read needs no openedAt, scope or HMAC; reads only main and cleans up',async()=>{
 const {authRead}=require('../direct-preflight.cjs'),f=fixture(),paths=[];
 f.sdk.doc=(_,path)=>(paths.push(path),path);
 const config={...env(),FITPP_DIRECT_ENABLED:'false',FITPP_DIRECT_WRITES_ENABLED:'false',OWNER_DIALOG_ENABLED:'false'};
 await authRead({env:config,sdk:f.sdk,now:()=>Date.parse('2026-10-25')});
 assert.deepEqual(paths,['fitppTestWorkspaces/synthetic-v1/states/main']);
 assert.equal(config.FITPP_DIRECT_ENABLED,'false');
 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});
test('auth-read refuses unsafe flags and deadline before login',async()=>{
 const {authRead}=require('../direct-preflight.cjs');
 const config={...env(),FITPP_DIRECT_ENABLED:'false',FITPP_DIRECT_WRITES_ENABLED:'false',OWNER_DIALOG_ENABLED:'false'};
 for(const change of [{FITPP_DIRECT_ENABLED:'true'},{FITPP_DIRECT_WRITES_ENABLED:'true'},{OWNER_DIALOG_ENABLED:'true'},{BOT_MODE:'production'},{FIREBASE_PROJECT_ID:'fitpp-crm'},{AUTO_PUBLISH:'true'},{TEST_ALLOW_EDIT:'true'}]) {
  const f=fixture();await assert.rejects(()=>authRead({env:{...config,...change},sdk:f.sdk,now:()=>Date.parse('2026-10-25')}));assert.deepEqual(f.calls,[]);
 }
 const f=fixture();await assert.rejects(()=>authRead({env:config,sdk:f.sdk,now:()=>Date.parse('2026-10-26T18:00:00Z')}),/POLL_CLOSED/);assert.deepEqual(f.calls,[]);
});
test('auth-read cleans up denied or missing reads and expiry during login',async()=>{
 const {authRead}=require('../direct-preflight.cjs');
 const config={...env(),FITPP_DIRECT_ENABLED:'false',FITPP_DIRECT_WRITES_ENABLED:'false',OWNER_DIALOG_ENABLED:'false'};
 for(const mode of ['denied','missing','expired']) {
  const f=fixture();let reads=0,ticks=0;
  f.sdk.getDocFromServer=async()=>{reads++;if(mode==='denied')throw Error('denied');return {exists:()=>false}};
  await assert.rejects(()=>authRead({env:config,sdk:f.sdk,now:()=>Date.parse(mode==='expired'&&ticks++?'2026-10-27':'2026-10-25')}));
  assert.equal(reads,mode==='expired'?0:1);assert.deepEqual(f.calls.slice(-3),['logout','terminate','delete']);
 }
});
test('disabled, production, other identity and missing credentials refuse before SDK access',async()=>{
 for(const change of [{FITPP_DIRECT_ENABLED:'false'},{FIREBASE_PROJECT_ID:'fitpp'},{FIREBASE_PROJECT_ID:'fitpp-crm'},{FIREBASE_BOT_UID:'other'},{FIREBASE_BOT_PASSWORD:''},{OWNER_DIALOG_ENABLED:'true'},{TEST_ALLOW_SEND:'true'}]) {
  const f=fixture();await assert.rejects(()=>connect({env:{...env(),...change},sdk:f.sdk}));assert.deepEqual(f.calls,[]);
 }
 assert.equal(settings(env()).projectId,'fitpp-test');
});
test('wrong uid or token project signs out and destroys app',async()=>{
 for(const f of [fixture('other'),fixture(OWNER_UID,'fitpp')]){await assert.rejects(()=>connect({env:env(),sdk:f.sdk}),/REJECTED/);assert.deepEqual(f.calls,['init','login','logout','delete']);}
});
test('client session defaults to no writes and refuses identity loss',async()=>{
 const f=fixture(),s=await connect({env:env(),sdk:f.sdk});
 assert.equal((await s.db.doc('fitppTestWorkspaces/synthetic-v1/states/main').get()).exists,true);
 f.auth.currentUser=null;await assert.rejects(()=>s.db.doc('fitppTestWorkspaces/synthetic-v1/states/main').get(),/BOT_AUTH/);
 await s.close();assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});
test('calendar preparation works after historical single-poll closure',async()=>{
 const f=fixture();
 const session=await prepare({
  env:env(),
  sdk:f.sdk,
  now:()=>Date.parse('2026-11-02')
 });
 await session.close();
 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});

test('existing test account uses memory auth and credentials only for SDK login',async()=>{
 const f=fixture();let received;
 f.sdk.initializeAuth=(app,options)=>{assert.equal(options.persistence,f.sdk.inMemoryPersistence);assert.equal(app.options.projectId,'fitpp-test');return f.auth};
 f.sdk.signInWithEmailAndPassword=async(a,email,password)=>{received={a,email,password};return {user:f.auth.currentUser}};
 const s=await connect({env:env(),sdk:f.sdk});assert.equal(received.a,f.auth);assert.equal(received.email,env().FIREBASE_BOT_EMAIL);assert.equal(received.password,env().FIREBASE_BOT_PASSWORD);
 await s.close();await s.close();assert.equal(f.calls.filter(x=>x==='delete').length,1);
});
test('SDK token refresh checked on every access, rejects changed claims and refresh failure',async()=>{
 for(const mode of ['project','issuer','subject','failure','identity']) {
  const f=fixture(),s=await connect({env:env(),sdk:f.sdk});let refreshes=0;
  f.auth.currentUser.getIdTokenResult=async()=>{refreshes++;if(mode==='failure')throw Error('synthetic-password private-token');
   const claims={aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:OWNER_UID};
   if(mode==='project')claims.aud='fitpp';if(mode==='issuer')claims.iss='https://securetoken.google.com/fitpp';if(mode==='subject')claims.sub='other';
   if(mode==='identity')f.auth.currentUser=null;
   return {claims};};
  await assert.rejects(()=>s.db.doc('fitppTestWorkspaces/synthetic-v1/states/main').get(),e=>e.message==='BOT_AUTH_REQUIRED');assert.equal(refreshes,1);await s.close();
 }
});
test('valid refreshed token continues reads without another password login',async()=>{
 const f=fixture(),s=await connect({env:env(),sdk:f.sdk});let refreshed=0;
 f.auth.currentUser.getIdTokenResult=async()=>{refreshed++;return {claims:{aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:OWNER_UID}}};
 for(let i=0;i<3;i++)await s.db.doc('fitppTestWorkspaces/synthetic-v1/states/main').get();
 assert.equal(refreshed,3);assert.equal(f.calls.filter(x=>x==='login').length,1);await s.close();
});
test('login and cleanup errors cannot expose secrets',async()=>{
 const f=fixture();f.sdk.signInWithEmailAndPassword=async()=>{throw Error('synthetic-password private-token')};f.sdk.signOut=async()=>{throw Error('private-token')};
 await assert.rejects(()=>connect({env:env(),sdk:f.sdk}),e=>e.message==='DIRECT_AUTH_CONNECTION_REJECTED');assert.ok(f.calls.includes('delete'));
});

const {POLL,USER}=require('../direct-core/src/pilot-policy.cjs');
const {format}=require('../src/fitpp-direct-diagnostic');
function fullConfig(){return {...env(),FITPP_DIRECT_WRITES_ENABLED:'false',OWNER_DIALOG_ENABLED:'false',FITPP_POLL_SYNC_ENABLED:'false',FITPP_BRIDGE_ENABLED:'true',FITPP_BRIDGE_HMAC_KEY:'a'.repeat(64),CHAT_IDS:POLL.chat,FITPP_BRIDGE_SCOPE:JSON.stringify({...POLL,user:USER}),FITPP_DIRECT_POLL_OPENED_AT:'1792773455958'}}
function fullFixture(){
 const f=fixture(),main=structuredClone(require('../direct-core/fixtures/main.json'));
 const data={main,bookings:{ownerUid:main.ownerUid,datasetId:'synthetic-v1',schemaVersion:1,entries:{}},bookingClock:{revision:84}};
 f.sdk.runTransaction=async(_,fn)=>fn({get:async path=>({exists:()=>!!data[path.split('/').pop()],data:()=>data[path.split('/').pop()]}),set:()=>assert.fail('write'),update:()=>assert.fail('write')});
 return {...f,data};
}
test('full preparation succeeds with SDK-shaped transaction snapshots and no writes',async()=>{
 const f=fullFixture(),s=await prepare({env:fullConfig(),sdk:f.sdk,now:()=>Date.parse('2026-10-25')});await s.close();
 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});
test('calendar preparation failure closes authenticated Firebase session',async()=>{
 const f=fullFixture();
 const config={
  ...fullConfig(),
  TRAINING_TEST_AUTOPOST_ENABLED:'true',
  TEST_EXPECTED_BOT_ID:'invalid-bot-id'
 };

 await assert.rejects(
  ()=>prepare({env:config,sdk:f.sdk}),
  /DAILY_TEST_BOT_REQUIRED/
 );
 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});

test('calendar preparation ignores legacy bridge scope without widening access',async()=>{
 const f=fullFixture();
 const config={
  ...fullConfig(),
  FITPP_BRIDGE_SCOPE:'invalid legacy scope',
  FITPP_BRIDGE_HMAC_KEY:'invalid legacy key',
  FITPP_DIRECT_POLL_OPENED_AT:'invalid legacy timestamp'
 };

 const session=await prepare({env:config,sdk:f.sdk});
 await session.close();

 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);
});

test('diagnostics never format arbitrary properties or external text',async()=>{
 const {at}=require('../src/fitpp-direct-diagnostic');
 assert.equal(format({stage:'READ_MAIN',reason:'private-token'}),'stage=UNKNOWN reason=UNKNOWN');
 await assert.rejects(()=>at('private-token',()=>{throw Object.assign(Error('private-token'),{code:'private-token'})}),e=>format(e)==='stage=UNKNOWN reason=UNKNOWN');
 const f=fixture();f.sdk.signInWithEmailAndPassword=async()=>{throw Object.assign(Error('private-token'),{code:'auth/invalid-credential'})};
 await assert.rejects(()=>connect({env:env(),sdk:f.sdk}),e=>format(e)==='stage=CONNECT reason=auth/invalid-credential');
});

test('daily autopost works after historical pilot closure and retains test Firebase isolation',async()=>{
 const config={
  ...fullConfig(),
  TEST_BOT_TOKEN:'offline',
  TEST_EXPECTED_BOT_ID:'123',
  WEBHOOK_SECRET:'offline_secret_123',
  TRAINING_TEST_AUTOPOST_ENABLED:'true'
 };

 const f=fullFixture();
 const session=await prepare({
  env:config,
  sdk:f.sdk,
  now:()=>POLL.closesAt+86400000
 });
 await session.close();
 assert.deepEqual(f.calls,['init','login','logout','terminate','delete']);

 for(const project of ['fitpp-crm','fitpp-165a2']){
  const rejected=fullFixture();
  await assert.rejects(()=>prepare({
   env:{...config,FIREBASE_PROJECT_ID:project},
   sdk:rejected.sdk,
   now:()=>POLL.closesAt+86400000
  }));
  assert.deepEqual(rejected.calls,[]);
 }
});

test('autopost uses the existing authenticated SDK session with separate paths and independent writes',async()=>{
 const f=fixture(),paths=[],written=[],docs=new Map();
 f.sdk.doc=(_,p)=>(paths.push(p),{path:p});
 f.sdk.getDocFromServer=async ref=>({exists:()=>docs.has(ref.path),data:()=>docs.get(ref.path)});
 f.sdk.runTransaction=async(_,fn)=>fn({get:async ref=>({exists:()=>docs.has(ref.path),data:()=>docs.get(ref.path)}),set:(ref,data)=>{written.push(ref.path);docs.set(ref.path,data)}});
 const s=await connect({env:{...env(),FITPP_DIRECT_WRITES_ENABLED:'false'},sdk:f.sdk});
 const store=s.autopostStore('123',{writeEnabled:()=>true});
 await store.reserve('2026-11-02',{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
 assert(written.every(p=>p.startsWith('trainingTestAutopostBots/123/polls/')));
 assert.equal(f.calls.filter(x=>x==='login').length,1);
 f.auth.currentUser=null;await assert.rejects(store.read('2026-11-02'),/BOT_AUTH_REQUIRED/);await s.close();
});
