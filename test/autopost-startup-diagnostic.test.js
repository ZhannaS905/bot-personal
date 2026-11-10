'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const diagnostic=require('../src/fitpp-direct-diagnostic');
const autopost=require('../src/training-test-autopost');
const source=fs.readFileSync(require.resolve('../direct-training-test.cjs'),'utf8');
const secret='PRIVATE_TOKEN password=PRIVATE_PASSWORD document={name:PRIVATE_PERSON} https://private.invalid/path\nFORGED_LOG';
const env={BOT_MODE:'test',CHAT_IDS:'-79450912874680',TEST_BOT_TOKEN:'PRIVATE_TOKEN',TEST_EXPECTED_BOT_ID:'123',WEBHOOK_SECRET:'private_secret_123',FIREBASE_PROJECT_ID:'fitpp-test',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',TRAINING_TEST_AUTOPOST_ENABLED:'true'};
function failure(code){return Object.assign(Error(secret),{code,stack:secret,cause:{message:secret,code:secret},stage:secret,reason:secret,document:{name:'PRIVATE_PERSON'}})}
function fixture({stage='AUTOPOST_FIRST_READ',code='permission-denied',cleanupFails=false,cli=false,disabled=false}={}){
 const calls=[],logs=[],module={exports:{}},runtimeEnv={...env,...(disabled?{TRAINING_TEST_AUTOPOST_ENABLED:'false'}:{})};
 const raw={async request(method,endpoint){assert.equal(method,'GET');calls.push('GET');if(stage==='AUTOPOST_MAX_IDENTITY')throw failure(code);return endpoint==='/me'?{user_id:123,username:'id623401053090_1_bot',is_bot:true}:endpoint.endsWith('/members/me')?{user_id:123,is_bot:true}:{chat_id:env.CHAT_IDS,title:'ТАБАТА запись'}}};
 const prepared={autopostStore(){calls.push('factory');if(stage==='AUTOPOST_STORE_FACTORY')throw failure(code);return {async read(){calls.push('read');if(stage==='AUTOPOST_FIRST_READ')throw failure(code);return null},close(){calls.push('store-close')}}},async close(){calls.push('session-close');if(cleanupFails)throw failure('unavailable')}};
 const fakeRequire=id=>{
  if(id==='./src/fitpp-direct-diagnostic')return diagnostic;
  if(id==='./src/fitpp-direct-session')return {settings(){if(stage==='SETTINGS')throw failure(code)}};
  if(id==='./src/training-test-autopost')return {settings(e){if(stage==='AUTOPOST_SETTINGS')throw failure(code);return autopost.settings(e)},prepare:o=>autopost.prepare({...o,raw,now:()=>new Date('2026-11-02T06:00:00Z')})};
  if(id==='node:path')return path;
  if(id==='node:module')return {createRequire:()=>()=>{if(stage==='SDK_LOAD')throw failure(code);return {}}};
  if(id==='./src/fitpp-direct-runtime')return {async prepare(){calls.push('runtime');if(stage==='RUNTIME_PREPARE')throw diagnostic.mark(failure(code),'CONNECT');return prepared}};
  if(id==='./src/training-test-http-server')return {async start(){calls.push('calendar-server');if(stage==='CALENDAR_SERVER_START')throw failure(code);return {once(){}}}};
  throw Error('Unexpected import');
 };
 fakeRequire.main=cli?module:{};
 const context={require:fakeRequire,module,__dirname:path.resolve('.'),process:{env:runtimeEnv},console:{error:line=>logs.push(line)}};
 vm.runInNewContext(source,context);return {calls,logs,context,run:()=>module.exports.main({env:runtimeEnv})};
}
for(const code of ['permission-denied','firestore/permission-denied','unauthenticated','unavailable','deadline-exceeded','failed-precondition','invalid-argument','resource-exhausted','aborted']){
 test('actual prepare and entrypoint preserve first Firestore read code '+code,async()=>{
  const f=fixture({code});await assert.rejects(f.run(),error=>diagnostic.format(error)==='stage=AUTOPOST_FIRST_READ reason='+code.replace(/^firestore\//,''));
  assert.equal(f.calls.filter(x=>x==='read').length,1);assert(f.calls.includes('session-close'));assert(!f.calls.includes('calendar-server'));assert.equal(f.logs.length,0);
 });
}
test('configuration, SDK, identity, store factory and runtime have distinct safe stages',async()=>{
 for(const [stage,code,expected]of [['SETTINGS','auth/invalid-credential','SETTINGS'],['AUTOPOST_SETTINGS','permission-denied','AUTOPOST_SETTINGS'],['SDK_LOAD','MODULE_NOT_FOUND','SDK_LOAD'],['AUTOPOST_MAX_IDENTITY','ECONNRESET','AUTOPOST_MAX_IDENTITY'],['AUTOPOST_STORE_FACTORY','permission-denied','AUTOPOST_STORE_FACTORY'],['RUNTIME_PREPARE','unauthenticated','CONNECT'],['CALENDAR_SERVER_START','ECONNRESET','CALENDAR_SERVER_START']]){
  const f=fixture({stage,code});await assert.rejects(f.run(),error=>diagnostic.format(error)===`stage=${expected} reason=${code}`);
 }
});
test('CLI logs safe stage/reason and preserves the first failure even if cleanup also fails',async()=>{
 const f=fixture({cli:true,cleanupFails:true});await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.logs,['DIRECT_STARTUP_REJECTED stage=AUTOPOST_FIRST_READ reason=permission-denied']);assert.equal(f.context.process.exitCode,1);assert(f.calls.includes('session-close'));assert(!f.logs.join('').includes('unavailable'));
 for(const value of ['PRIVATE_TOKEN','PRIVATE_PASSWORD','PRIVATE_PERSON','document=','https://','FORGED_LOG','stack'])assert(!f.logs.join('').includes(value));
});
test('unknown errors, forged diagnostics and unsafe code suffixes cannot cross the CLI boundary',async()=>{
 for(const code of [secret,'permission-denied '+secret,'firestore/permission-denied\nFORGED_LOG',{code:'permission-denied'},null]){
  const f=fixture({cli:true,code});await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.logs,['DIRECT_STARTUP_REJECTED stage=AUTOPOST_FIRST_READ reason=UNKNOWN']);
 }
 assert.equal(diagnostic.format({stage:'AUTOPOST_FIRST_READ',reason:secret}),'stage=UNKNOWN reason=UNKNOWN');
 const safe=diagnostic.mark(failure('permission-denied'),'AUTOPOST_FIRST_READ');safe.stage=secret;safe.reason=secret;safe.message=secret;assert.equal(diagnostic.format(safe),'stage=AUTOPOST_FIRST_READ reason=permission-denied');
});
test('disabled autopost does not create a store, read Firestore or request MAX',async()=>{
 const f=fixture({disabled:true});await f.run();assert.deepEqual(f.calls,['runtime','calendar-server']);assert.equal(f.logs.length,0);
});
