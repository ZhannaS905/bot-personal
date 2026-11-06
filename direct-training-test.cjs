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
  let tracedSdk=sdk;
  if(env.FITPP_TRACE_WRITES==='true'){
    try {
      const counts={set:0,update:0,delete:0};
      tracedSdk={...sdk,runTransaction(database,callback,options){
        return sdk.runTransaction(database,tx=>callback(new Proxy(tx,{
          get(target,property){
            if(['set','update','delete'].includes(property)){
              return (...args)=>{
                counts[property]++;
                console.log('[FIRESTORE_WRITE_ATTEMPT]',JSON.stringify({
                  operation:property,
                  path:args[0]?.path??'(unknown)',
                  count:counts[property],
                  stack:new Error().stack.split('\n').slice(2,7)
                }));
                return target[property](...args);
              };
            }
            const value=Reflect.get(target,property,target);
            return typeof value==='function'?value.bind(target):value;
          }
        })),options);
      }};
      console.log('FITPP_TRACE_LOADED');
    } catch(error) {
      console.error('FITPP_TRACE_LOAD_FAILED code='+(
        error?.code==='MODULE_NOT_FOUND'?'MODULE_NOT_FOUND':'OTHER'
      ));
      throw error;
    }
  }
  prepared=await at('RUNTIME_PREPARE',()=>require('./src/fitpp-direct-runtime').prepare({env,sdk:tracedSdk}));
  autopost=await at('AUTOPOST_PREPARE',()=>autopostModule.prepare({env,storeFactory:prepared.autopostStore,booking:prepared.dailyBooking,calendarPollStoreFactory:prepared.calendarPollStore,calendarStore:prepared.calendarStore,calendarDb:prepared.calendarDb,personalCalendar:prepared.personalCalendar}));
  const server=await at('CALENDAR_SERVER_START',()=>require('./src/training-test-http-server').start({
    autopost,
    contact:prepared.contact,
    secret:env.WEBHOOK_SECRET,
    env
  }));
  // Graceful shutdown: supervisor gives this process 10 seconds.
  let stopping=false;
  const stop=()=>{
    if(stopping)return;
    stopping=true;
    server.closeIdleConnections?.();
    server.close();
  };

  if(typeof process.once==='function'){
    process.once('SIGTERM',stop);
    process.once('SIGINT',stop);
    server.once('close',()=>{
      process.removeListener('SIGTERM',stop);
      process.removeListener('SIGINT',stop);
    });
  }

  // Drain Firestore work before closing the shared authenticated session.
  server.once('close',()=>void (async()=>{
    try {
      await server.stopAutopost();
    } finally {
      await prepared.close();
    }
  })().catch(()=>console.error('DIRECT_CLOSE_FAILED')));
  return server;
 } catch(error) {
  // Best-effort cleanup must neither replace the original diagnosis nor leak SDK errors.
  for(const close of [()=>autopost?.close(),()=>prepared?.close()])try{await close()}catch{}
  throw mark(error,'STARTUP');
 }
}
if(require.main===module)main().catch(error=>{console.error('DIRECT_STARTUP_REJECTED '+format(error));process.exitCode=1});
module.exports={main};
