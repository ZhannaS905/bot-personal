'use strict';
// Preparation only: no imports of Firebase, login, or network on module load.
const personalConfig=require('./fitpp-personal/runtime-config');
const OWNER_UID='lLlMAetSG1aEeJSeBl4F4ypydEh2';
function settings(env) {
 if(env.FITPP_DIRECT_ENABLED!=='true'||env.BOT_MODE!=='test')throw Error('DIRECT_DISABLED');
 const projectId=env.FIREBASE_PROJECT_ID;
 const personal=projectId===personalConfig.projectId;
 if(!personal&&projectId!=='fitpp-test')throw Error('TEST_PROJECT_REQUIRED');
 if(personal&&(env.TRAINING_TEST_CALENDAR_POLLS_ENABLED!=='true'||
    env.FITPP_NOTIFICATION_SUPERVISED==='true'))throw Error('PERSONAL_CALENDAR_MODE_REQUIRED');
 if(env.OWNER_DIALOG_ENABLED!==undefined&&env.OWNER_DIALOG_ENABLED!=='false')throw Error('OWNER_DIALOG_MUST_STAY_DISABLED');
 for(const k of ['AUTO_PUBLISH','TEST_ALLOW_SEND','TEST_ALLOW_EDIT','TEST_ALLOW_DELETE'])if(env[k]!=='false')throw Error('POLL_WRITES_MUST_BE_DISABLED');
 for(const k of ['FIREBASE_API_KEY','FIREBASE_BOT_UID','FIREBASE_BOT_EMAIL','FIREBASE_BOT_PASSWORD'])if(typeof env[k]!=='string'||!env[k].trim())throw Error(k+'_REQUIRED');
 if(personal){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(env.FIREBASE_BOT_UID)||
     [OWNER_UID,personalConfig.ownerUid].includes(env.FIREBASE_BOT_UID))
   throw Error('DEDICATED_PERSONAL_UID_REQUIRED');
 }else if(env.FIREBASE_BOT_UID!==OWNER_UID)throw Error('EXPECTED_TEST_UID_REQUIRED');
 return {apiKey:env.FIREBASE_API_KEY,projectId,authDomain:projectId+'.firebaseapp.com',uid:env.FIREBASE_BOT_UID,email:env.FIREBASE_BOT_EMAIL,password:env.FIREBASE_BOT_PASSWORD};
}
async function connect({env,sdk}) {
 const c=settings(env);
 const personal=c.projectId===personalConfig.projectId;
 let app;
 try {app=sdk.initializeApp({apiKey:c.apiKey,projectId:c.projectId,authDomain:c.authDomain},'training-test-direct')}catch{throw Error('DIRECT_AUTH_CONNECTION_REJECTED')}
 let auth,raw;
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;for(const action of [()=>auth&&sdk.signOut(auth),()=>raw&&sdk.terminate(raw),()=>sdk.deleteApp(app)]){try{await action()}catch{ /* Never expose SDK errors or credentials. */ }}};
 try {
  auth=sdk.initializeAuth(app,{persistence:sdk.inMemoryPersistence});
  const result=await sdk.signInWithEmailAndPassword(auth,c.email,c.password);
  async function validateAuth() {
   try {
    const user=auth.currentUser;
    if(closed||user?.uid!==c.uid||result.user.uid!==c.uid)throw Error();
    // SDK refreshes expired/soon-expiring tokens here, including after idle periods.
    const token=await user.getIdTokenResult();
    if(closed||auth.currentUser!==user||token.claims.aud!==c.projectId||token.claims.iss!=='https://securetoken.google.com/'+c.projectId||token.claims.sub!==c.uid)throw Error();
   }catch{throw Error('BOT_AUTH_REQUIRED')}
  }
  await validateAuth();
  raw=sdk.getFirestore(app);
  const {createDirectDb}=require('./fitpp-direct-db');
  const db=personal?null:createDirectDb({sdk,raw,projectId:c.projectId,botUid:c.uid,validateAuth,getUid:()=>auth.currentUser?.uid,writeEnabled:()=>env.FITPP_DIRECT_WRITES_ENABLED==='true',dailyBotId:env.TRAINING_TEST_AUTOPOST_ENABLED==='true'?env.TEST_EXPECTED_BOT_ID:undefined});
  // Firebase client SDK owns refresh lifecycle. Never persist or log tokens.
  // Separate capability: never widen the booking adapter's paths or write flag.
  function contactStore(botId,{writeEnabled=()=>false}={}) {
   const {firebaseStore,MAIN,LINKS}=require('./contact-linking');
   const main=personal?personalConfig.main:MAIN;
   const links=personal?personalConfig.bindings:LINKS;
   const guarded={doc(database,path){
    if(database!==raw||![main,links].includes(path))throw Error('CONTACT_PATH_REFUSED');
    return sdk.doc(raw,path);
   },runTransaction:async(database,fn)=>{
    if(database!==raw)throw Error('CONTACT_PATH_REFUSED');
    await validateAuth();
    return sdk.runTransaction(raw,async tx=>{
     await validateAuth();
     const value=await fn({get:ref=>tx.get(ref),set(ref,data){
      if(ref.path!==links||!writeEnabled())throw Error('CONTACT_WRITES_DISABLED');
      tx.set(ref,data);
     }});
     await validateAuth();return value;
    },{maxAttempts:5});
   }};
   return firebaseStore({sdk:guarded,db:raw,botId});
  }
  // Independent capability: the booking adapter and its write flag remain unchanged.
  function autopostStore(botId,{writeEnabled=()=>false,now=Date.now}={}) {
   return require('./training-test-firestore').createFirestoreStore({sdk,raw,botId,validateAuth,writeEnabled,now});
  }
  // Separate read-only capability for the trainer calendar. No Firestore rules
  // changes, no writes and no widening of the booking database adapter.
  function calendarPollStore(botId,{writeEnabled=()=>false,bookingSyncEnabled=()=>false,now=Date.now}={}) {
    return require('./training-test-calendar-firestore').createCalendarPollStore({
      sdk,raw,botId,validateAuth,writeEnabled,bookingSyncEnabled,now
    });
  }
  function calendarStore() {
   const ref=sdk.doc(raw,'trainers/'+OWNER_UID);
   return {async read(){
    await validateAuth();
    const snapshot=await sdk.getDocFromServer(ref);
    await validateAuth();
    if(!snapshot.exists())throw Error('TRAINER_CALENDAR_MISSING');
    const data=snapshot.data();
    if(!data||!Object.hasOwn(data,'groupScheduleV1'))throw Error('TRAINER_CALENDAR_MISSING');
    return structuredClone(data.groupScheduleV1);
   },
   async readTrainerWorkouts(){
    await validateAuth();
    const snapshot=await sdk.getDocFromServer(ref);
    await validateAuth();
    if(!snapshot.exists())throw Error('TRAINER_WORKOUTS_MISSING');
    const data=snapshot.data();
    if(!data||!data.workouts||typeof data.workouts!=='object'||Array.isArray(data.workouts))
     throw Error('TRAINER_WORKOUTS_MISSING');
    return structuredClone(data.workouts);
   }};
  }
  const personalCalendar=personal
   ?require('./fitpp-personal/calendar').createPersonalCalendar({sdk,raw,validateAuth})
   :null;
  return {db,contactStore,autopostStore,calendarStore,calendarPollStore,personalCalendar,close};
 } catch(error) {await close();const safe=require('./fitpp-direct-diagnostic').mark(error,'CONNECT');safe.message='DIRECT_AUTH_CONNECTION_REJECTED';throw safe}
}
module.exports={settings,connect,OWNER_UID};
