'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {supervise,manualWatchers,personalNotificationsEnabled}=require('../training-test-supervisor.cjs');
function fixture(enabled=true,personalEnabled=false){
 const children=[],timers=[],codes=[];
 const runtime=supervise({enabled,personalEnabled,launch:(file,args)=>{const child=new EventEmitter();Object.assign(child,{file,args,signals:[],kill(s){this.signals.push(s)}});children.push(child);return child},schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer},cancel:t=>t.cancelled=true,log:()=>{},finish:c=>codes.push(c)});
 return {children,timers,codes,runtime};
}
test('default runs only existing bridge; enabled starts one watcher with exact arguments',()=>{
 assert.equal(fixture(false).children.length,1);const f=fixture();assert.equal(f.children.length,2);
 assert.deepEqual(f.children[1].args,['--send','--watch']);
 f.children[1].emit('exit',1);f.children[1].emit('error',Error());assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,5000);
 f.timers[0].fn();assert.equal(f.children.length,3);assert.equal(f.children[0].signals.length,0);
 f.children[2].emit('exit',0);assert.equal(f.timers[1].ms,10000);
});
test('stop cancels retry, drains both processes, escalates after grace and exits',()=>{
 const f=fixture();f.runtime.stop();assert.deepEqual(f.children.map(c=>c.signals),[['SIGTERM'],['SIGTERM']]);
 f.timers[0].fn();assert.deepEqual(f.children[1].signals,['SIGTERM','SIGKILL']);
 for(const c of f.children)c.emit('exit',0);assert.deepEqual(f.codes,[0]);assert.equal(f.timers[0].cancelled,true);
});
test('bridge failure stops watcher and reports failure; shutdown cancels pending retry',()=>{
 const f=fixture();f.children[0].emit('exit',1);assert.deepEqual(f.children[1].signals,['SIGTERM']);f.children[1].emit('exit',0);assert.deepEqual(f.codes,[1]);
 const g=fixture();g.children[1].emit('exit',1);g.runtime.stop();assert.equal(g.timers[0].cancelled,true);
});
test('proc scan identifies old manual entrypoints without ps; unreadable proc fails closed',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-proc-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [pid,cmd] of [['98','node\0/opt/training-test/fitpp-notification-test.cjs\0--send\0--watch\0'],['99','node\0direct-training-test.cjs\0']]){fs.mkdirSync(path.join(dir,pid));fs.writeFileSync(path.join(dir,pid,'cmdline'),cmd)}
 assert.deepEqual(manualWatchers(dir),['98']);assert.throws(()=>manualWatchers(path.join(dir,'missing')));
});
test('kernel lock refuses a second live watcher and releases after close',async t=>{
 if(process.platform!=='linux')return t.skip('Linux abstract socket, production platform');
 const {acquire}=require('../src/fitpp-notification-lock.cjs');const first=await acquire();
 try{await assert.rejects(acquire(),{code:'EADDRINUSE'})}finally{await new Promise(r=>first.close(r))}
 const next=await acquire();await new Promise(r=>next.close(r));
});

test('Personal worker runs beside the bridge and retries independently',()=>{
 const f=fixture(false,true);
 assert.deepEqual(f.children.map(({file,args})=>[file,args]),[
  ['direct-training-test.cjs',[]],['src/fitpp-personal/notification-worker.js',[]]
 ]);
 f.children[1].emit('error',Error());
 f.children[1].emit('exit',1);
 assert.deepEqual(f.timers.map(t=>t.ms),[5000]);
 f.timers[0].fn();
 f.children[2].emit('exit',1);
 assert.deepEqual(f.timers.map(t=>t.ms),[5000,10000]);
 assert.deepEqual(f.children[0].signals,[]);
 f.runtime.stop();
 assert.equal(f.timers[1].cancelled,true);
 f.timers[1].fn();
 assert.equal(f.children.length,3);
 f.children[0].emit('exit',0);
 assert.deepEqual(f.codes,[0]);
});

test('bridge failure drains Personal worker; legacy watcher takes precedence',()=>{
 const f=fixture(false,true);
 f.children[0].emit('exit',1);
 assert.deepEqual(f.children[1].signals,['SIGTERM']);
 f.timers[0].fn();
 assert.deepEqual(f.children[1].signals,['SIGTERM','SIGKILL']);
 f.children[1].emit('exit',0);
 assert.deepEqual(f.codes,[1]);
 assert.deepEqual(fixture(true,true).children.map(c=>c.file),[
  'direct-training-test.cjs','fitpp-notification-test.cjs'
 ]);
});

test('Personal startup requires explicit opt-in, worker settings and private state under the data root',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'personal-supervisor-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const dataRoot=path.join(base,'data');
 const directory=path.join(dataRoot,'personal');
 const outside=path.join(base,'outside');
 fs.mkdirSync(dataRoot);
 fs.mkdirSync(directory,{mode:0o700});
 fs.mkdirSync(outside,{mode:0o700});
 fs.symlinkSync(outside,path.join(dataRoot,'escape'));
 const env={
  FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'true', FITPP_PERSONAL_NOTIFICATION_STATE_DIR:directory,
  FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION:'0', TEST_EXPECTED_BOT_ID:'123', TEST_BOT_TOKEN:'token',
  BOT_MODE:'test', FITPP_DIRECT_ENABLED:'true', FIREBASE_PROJECT_ID:'fitpp-personal',
  FIREBASE_API_KEY:'key', FIREBASE_BOT_UID:'dedicated-bot', FIREBASE_BOT_EMAIL:'bot@example.test',
  FIREBASE_BOT_PASSWORD:'password', AUTO_PUBLISH:'false', TEST_ALLOW_SEND:'false',
  TEST_ALLOW_EDIT:'false', TEST_ALLOW_DELETE:'false'
 };
 const logs=[];
 const check=overrides=>personalNotificationsEnabled({...env,...overrides},{dataRoot,log:m=>logs.push(m)});
 assert.equal(check({FITPP_PERSONAL_NOTIFICATIONS_ENABLED:undefined}),false);
 assert.equal(check({FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'false'}),false);
 assert.deepEqual(logs,[]);
 assert.equal(check({}),true);
 for(const overrides of [
  {FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'TRUE'}, {FITPP_NOTIFICATION_SUPERVISED:'true'},
  {FIREBASE_BOT_PASSWORD:undefined}, {TEST_BOT_TOKEN:undefined}, {FIREBASE_PROJECT_ID:'fitpp-test'},
  {FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION:undefined},
  ...['relative',outside,dataRoot,path.join(dataRoot,'missing'),path.join(dataRoot,'escape')]
   .map(dir=>({FITPP_PERSONAL_NOTIFICATION_STATE_DIR:dir}))
 ])assert.equal(check(overrides),false);
 fs.chmodSync(directory,0o755);
 assert.equal(check({}),false);
 assert.ok(logs.length>0);
 assert.ok(logs.every(message=>message==='FITPP_PERSONAL_NOTIFICATION_SUPERVISOR_REFUSED check_settings_and_data_directory'));
 assert.deepEqual(fs.readdirSync(directory),[]);
});
