'use strict';
// Current Training Test entrypoint; daily test polls are an opt-in capability.
const {at,mark,format}=require('./src/fitpp-direct-diagnostic');
async function main({env=process.env}={}) {
 let prepared,autopost;
 try {
  await at('SETTINGS',()=>require('./src/fitpp-direct-session').settings(env));
  const autopostModule=require('./src/training-test-autopost');
  await at('AUTOPOST_SETTINGS',()=>autopostModule.settings(env));
  const sdk=await at('SDK_LOAD',()=>{
   const load=require('node:module').createRequire(require('node:path').join(__dirname,'direct-sdk/package.json'));
   return {...load('firebase/app'),...load('firebase/auth'),...load('firebase/firestore')};
  });
  const tracedSdk=env.FITPP_TRACE_WRITES==='true'
    ?require('./firestore-write-counter.local-debug.cjs').wrapSdk(sdk)
    :sdk;
  prepared=await at('RUNTIME_PREPARE',()=>require('./src/fitpp-direct-runtime').prepare({env,sdk:tracedSdk}));
  autopost=await at('AUTOPOST_PREPARE',()=>autopostModule.prepare({env,storeFactory:prepared.autopostStore,booking:prepared.dailyBooking,calendarPollStoreFactory:prepared.calendarPollStore,calendarStore:prepared.calendarStore,calendarDb:prepared.calendarDb}));
  const server=await at('BRIDGE_START',()=>require('./src/fitpp-test-bridge').main({...prepared,autopost}));
  // Drain Firestore work before closing the shared authenticated session.
  server.once('close',()=>void (async()=>{if(autopost)await autopost.close();await prepared.close()})().catch(()=>console.error('DIRECT_CLOSE_FAILED')));
  return server;
 } catch(error) {
  // Best-effort cleanup must neither replace the original diagnosis nor leak SDK errors.
  for(const close of [()=>autopost?.close(),()=>prepared?.close()])try{await close()}catch{}
  throw mark(error,'STARTUP');
 }
}
if(require.main===module)main().catch(error=>{console.error('DIRECT_STARTUP_REJECTED '+format(error));process.exitCode=1});
module.exports={main};
