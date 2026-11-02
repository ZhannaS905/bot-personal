'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('deployed Docker entrypoint starts calendar server with contact enabled',async()=>{
 const calls=[],sdk={};const env={CONTACT_LINK_ENABLED:'true'};
 const fakeRequire=id=>{
  if(id==='./src/fitpp-direct-diagnostic')return require('../src/fitpp-direct-diagnostic');
  if(id==='node:module')return {createRequire:()=>name=>{calls.push(name);return sdk}};
  if(id==='node:path')return path;
  if(id==='./src/training-test-autopost')return {settings:()=>null,prepare:async()=>null};
  if(id==='./src/fitpp-direct-session')return {settings:()=>calls.push('settings')};
  if(id==='./src/fitpp-direct-runtime')return {prepare:async options=>{a.equal(options.env,env);calls.push('prepare');return {contact:{},close:async()=>{}}}};
  if(id==='./src/training-test-http-server')return {start:async options=>{a.ok(options.contact);calls.push('calendar-server');return {once:()=>{}}}};
  throw Error('Unexpected runtime: '+id);
 };
 const context={require:fakeRequire,module:{exports:{}},__dirname:path.resolve('.'),process:{env},console};
 vm.runInNewContext(fs.readFileSync('direct-training-test.cjs','utf8'),context);
 a.ok(await context.module.exports.main({env}));
 a.deepEqual(calls,['settings','firebase/app','firebase/auth','firebase/firestore','prepare','calendar-server']);
 a.match(fs.readFileSync('Dockerfile','utf8'),/CMD \["node", "\/opt\/training-test\/training-test-supervisor.cjs"\]/);
});

test('entrypoint passes shared Firestore factory and drains autopost before closing Firebase',async()=>{
 const {EventEmitter}=require('node:events'),server=new EventEmitter(),calls=[];let release;
 const gate=new Promise(resolve=>release=resolve),factory=()=>{};
 const fakeRequire=id=>{
  if(id==='./src/fitpp-direct-diagnostic')return require('../src/fitpp-direct-diagnostic');
  if(id==='node:module')return {createRequire:()=>()=>({})};if(id==='node:path')return path;
  if(id==='./src/fitpp-direct-session')return {settings(){}};
  if(id==='./src/fitpp-direct-runtime')return {prepare:async()=>({autopostStore:factory,close:async()=>calls.push('session-closed')})};
  if(id==='./src/training-test-autopost')return {settings(){},prepare:async options=>{a.equal(options.storeFactory,factory);return {close:async()=>{calls.push('draining');await gate;calls.push('drained')}}}};
  if(id==='./src/training-test-http-server')return {start:async()=>{server.stopAutopost=async()=>{calls.push('draining');await gate;calls.push('drained')};return server}};throw Error(id);
 };
 const context={require:fakeRequire,module:{exports:{}},__dirname:path.resolve('.'),process:{env:{}},console};
 vm.runInNewContext(fs.readFileSync('direct-training-test.cjs','utf8'),context);await context.module.exports.main();server.emit('close');await new Promise(r=>setImmediate(r));a.deepEqual(calls,['draining']);release();await new Promise(r=>setImmediate(r));a.deepEqual(calls,['draining','drained','session-closed']);
});

test('calendar entrypoint gracefully drains on SIGTERM only once',async()=>{
 const {EventEmitter}=require('node:events');
 const calls=[],server=new EventEmitter();
 const signals=new EventEmitter();
 signals.env={};
 let release;
 const gate=new Promise(resolve=>release=resolve);

 server.listening=true;
 server.close=callback=>{
  calls.push('http-close');
  server.listening=false;
  server.emit('close');
  callback?.();
 };
 server.closeIdleConnections=()=>calls.push('idle-close');

 const fakeRequire=id=>{
  if(id==='./src/fitpp-direct-diagnostic')
   return require('../src/fitpp-direct-diagnostic');
  if(id==='node:module')
   return {createRequire:()=>()=>({})};
  if(id==='node:path')return path;
  if(id==='./src/fitpp-direct-session')
   return {settings(){}};
  if(id==='./src/fitpp-direct-runtime')
   return {prepare:async()=>({
    close:async()=>calls.push('firebase-close')
   })};
  if(id==='./src/training-test-autopost')
   return {settings(){},prepare:async()=>({})};
  if(id==='./src/training-test-http-server')
   return {start:async()=>{
    server.stopAutopost=async()=>{
     calls.push('autopost-stop');
     await gate;
     calls.push('autopost-drained');
    };
    return server;
   }};
  throw Error(id);
 };

 const context={
  require:fakeRequire,
  module:{exports:{}},
  __dirname:path.resolve('.'),
  process:signals,
  console
 };
 vm.runInNewContext(
  fs.readFileSync('direct-training-test.cjs','utf8'),
  context
 );

 await context.module.exports.main({env:signals.env});
 try{
  a.equal(signals.listenerCount('SIGTERM'),1);
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  await new Promise(resolve=>setImmediate(resolve));
  a.equal(calls.filter(x=>x==='http-close').length,1);
  a.equal(calls.includes('firebase-close'),false);
  release();
  await new Promise(resolve=>setImmediate(resolve));
  a.deepEqual(calls.filter(x=>[
   'http-close','autopost-stop','autopost-drained','firebase-close'
  ].includes(x)),[
   'http-close','autopost-stop','autopost-drained','firebase-close'
  ]);
 }finally{
  release();
 }
});
