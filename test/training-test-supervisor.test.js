'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {supervise,manualWatchers,personalNotificationsEnabled,preparePersonalNotifications}=require('../training-test-supervisor.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
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

function personalFixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'personal-supervisor-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const dataRoot=path.join(base,'data');
 const directory=path.join(dataRoot,'fitpp-personal-notifications');
 fs.mkdirSync(dataRoot,{mode:0o700});
 const env={
  FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'true', FITPP_PERSONAL_NOTIFICATION_STATE_DIR:directory,
  FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION:'0', TEST_EXPECTED_BOT_ID:'123', TEST_BOT_TOKEN:'token',
  BOT_MODE:'test', FITPP_DIRECT_ENABLED:'true', FIREBASE_PROJECT_ID:'fitpp-personal',
  FIREBASE_API_KEY:'key', FIREBASE_BOT_UID:'dedicated-bot', FIREBASE_BOT_EMAIL:'bot@example.test',
  FIREBASE_BOT_PASSWORD:'password', AUTO_PUBLISH:'false', TEST_ALLOW_SEND:'false',
  TEST_ALLOW_EDIT:'false', TEST_ALLOW_DELETE:'false'
 };
 const logs=[];
 const options={dataRoot,log:m=>logs.push(m)};
 const check=overrides=>personalNotificationsEnabled({...env,...overrides},options);
 return {base,dataRoot,directory,env,logs,options,check};
}

test('Personal startup requires opt-in and valid settings, creates the private directory and preserves existing files',t=>{
 const {base,dataRoot,directory,logs,check}=personalFixture(t);
 const outside=path.join(base,'outside');
 fs.mkdirSync(outside,{mode:0o700});
 fs.symlinkSync(outside,path.join(dataRoot,'escape'));
 assert.equal(check({FITPP_PERSONAL_NOTIFICATIONS_ENABLED:undefined}),false);
 assert.equal(check({FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'false'}),false);
 assert.deepEqual(logs,[]);
 for(const overrides of [
  {FITPP_PERSONAL_NOTIFICATIONS_ENABLED:'TRUE'}, {FITPP_NOTIFICATION_SUPERVISED:'true'},
  {FIREBASE_BOT_PASSWORD:undefined}, {TEST_BOT_TOKEN:undefined}, {FIREBASE_PROJECT_ID:'fitpp-test'},
  {FITPP_PERSONAL_NOTIFICATION_START_AFTER_REVISION:undefined},
  ...['relative',outside,dataRoot,path.join(dataRoot,'missing'),path.join(dataRoot,'escape'),
   dataRoot+'/escape/../fitpp-personal-notifications']
   .map(dir=>({FITPP_PERSONAL_NOTIFICATION_STATE_DIR:dir}))
 ])assert.equal(check(overrides),false);
 assert.equal(fs.existsSync(directory),false);
 const custom=path.join(dataRoot,'existing-personal');
 fs.mkdirSync(custom,{mode:0o700});
 assert.equal(check({FITPP_PERSONAL_NOTIFICATION_STATE_DIR:custom}),true);
 assert.equal(check({}),true);
 const created=fs.lstatSync(directory);
 assert.equal(created.mode&0o7777,0o700);
 assert.equal(created.uid,process.geteuid());
 const cursor=path.join(directory,'cursor-v1.json');
 fs.writeFileSync(cursor,'existing cursor',{mode:0o600});
 assert.equal(check({}),true);
 assert.equal(fs.statSync(directory).ino,created.ino);
 fs.chmodSync(directory,0o755);
 assert.equal(check({}),false);
 assert.equal(fs.statSync(directory).mode&0o777,0o755);
 assert.equal(fs.readFileSync(cursor,'utf8'),'existing cursor');
 assert.ok(logs.length>0);
assert.ok(logs.every(message=>message.startsWith('FITPP_PERSONAL_NOTIFICATION_SUPERVISOR_REFUSED check_settings_and_data_directory')));
});

test('Personal startup rejects symlinks, files, foreign ownership, unsafe parents and failed access',t=>{
 const {base,dataRoot,directory,check}=personalFixture(t);
 const volume=path.join(base,'volume');
 fs.renameSync(dataRoot,volume);
 fs.symlinkSync(volume,dataRoot);
 assert.equal(check({}),false);
 assert.deepEqual(fs.readdirSync(volume),[]);
 fs.unlinkSync(dataRoot);
 fs.renameSync(volume,dataRoot);
 for(const target of [path.join(base,'outside'),path.join(dataRoot,'inside'),path.join(base,'missing')]){
  if(!target.endsWith('missing'))fs.mkdirSync(target,{mode:0o755});
  fs.symlinkSync(target,directory);
  assert.equal(check({}),false);
  assert.equal(fs.readlinkSync(directory),target);
  if(fs.existsSync(target))assert.equal(fs.statSync(target).mode&0o777,0o755);
  fs.unlinkSync(directory);
 }
 fs.writeFileSync(directory,'existing file');
 assert.equal(check({}),false);
 assert.equal(fs.readFileSync(directory,'utf8'),'existing file');
 fs.unlinkSync(directory);
 fs.chmodSync(dataRoot,0o777);
 assert.equal(check({}),false);
 assert.equal(fs.existsSync(directory),false);
 fs.chmodSync(dataRoot,0o700);
 fs.mkdirSync(directory,{mode:0o700});
 const lstat=fs.lstatSync;
 const foreign=t.mock.method(fs,'lstatSync',file=>{
  const state=lstat(file);
  if(file===directory)state.uid=process.geteuid()+1;
  return state;
 });
 assert.equal(check({}),false);
 foreign.mock.restore();
 t.mock.method(fs,'accessSync',()=>{throw Error('access denied')});
 assert.equal(check({}),false);
});

test('Personal preflight honors legacy precedence, holds one lock and leaves the bridge on refusal',async t=>{
 const {directory,env,options}=personalFixture(t);
 let busy=false,acquisitions=0;
 const lock={close(){busy=false}};
 const acquire=async()=>{
  acquisitions++;
  if(busy)throw Error('already locked');
  busy=true;
  return lock;
 };
 const prepare=(overrides={},scan=()=>[])=>preparePersonalNotifications({...env,...overrides},{...options,acquire,scan});
 assert.equal(await prepare({FITPP_NOTIFICATION_SUPERVISED:'true'}),undefined);
 assert.equal(acquisitions,0);
 assert.equal(await prepare({},()=>['98']),undefined);
 assert.equal(busy,false);
 assert.equal(fs.existsSync(directory),false);
 fs.writeFileSync(directory,'occupied');
 const refused=await prepare();
 assert.equal(busy,false);
 assert.deepEqual(fixture(false,Boolean(refused)).children.map(c=>c.file),['direct-training-test.cjs']);
 fs.unlinkSync(directory);
 assert.equal(await prepare(),lock);
 assert.equal(await prepare(),undefined);
 assert.equal(busy,true);
 lock.close();
});
