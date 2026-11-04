'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {initializeTestEnvironment,assertSucceeds}=require('@firebase/rules-unit-testing');
const sdk=require('firebase/firestore');
const {createCalendarPollStore}=require('../src/training-test-calendar-firestore');
const {workoutKey}=require('../src/fitpp-calendar-poll-plan');
const owner='lLlMAetSG1aEeJSeBl4F4ypydEh2';
const workout={id:'emulator-rules-regression',date:'2026-11-04',location:'zarya',time:'20:00'};
const key=workoutKey(workout),pollPath=`trainingTestCalendarPolls/131384398/polls/${key}`;
const base={version:1,botId:'131384398',chat:'-80345864298680',key,id:'11111111-1111-4111-8111-111111111111',createdAt:100,workout,status:'published',mid:'mid.test123',votes:{},last:{},order:[],revision:2,displayedRevision:0,bookingSyncedRevision:0,bookingSyncedClients:{},bookingSyncPending:true};
async function main(){
 const env=await initializeTestEnvironment({projectId:'fitpp-test',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync(process.env.RULES_FILE||path.resolve(__dirname,'../../firestore.rules'),'utf8')}});
 const db=env.authenticatedContext(owner).firestore();let passed=0;
 const seed=data=>env.withSecurityRulesDisabled(c=>sdk.setDoc(sdk.doc(c.firestore(),pollPath),data));
 async function deny(context,data,label){let e;try{await sdk.setDoc(sdk.doc(context,pollPath),data);}catch(error){e=error;}assert.ok(e,label);assert.equal(e.code,'permission-denied',label);assert.doesNotMatch(e.message,/1000|maximum|Unable to evaluate/i,label);passed++;console.log('PASS deny',label);}
 try{
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore();
  for(const id of ['emulator-real-vote','emulator-real-cancel']) {
   const digest=require('node:crypto').createHash('sha256').update(JSON.stringify(id)).digest('hex');
   await sdk.deleteDoc(sdk.doc(db,pollPath+'/events/'+digest));
  }
  for(const id of ['c','d']) await sdk.deleteDoc(sdk.doc(db,'trainingTestCalendarPolls/131384398/polls/'+'a'.repeat(64)+'/events/'+id.repeat(64)));
 });
 for(const status of ['published','deletePending','deleted']){
  const p={...base,status,...(status!=='published'?{deleteRequestedAt:101}:{}),...(status==='deleted'?{deletedAt:102}:{})};
  for(const [actor,context] of [['owner',db],['nonowner',env.authenticatedContext('foreign').firestore()],['anonymous',env.unauthenticatedContext().firestore()]]){
   const ack={...p,bookingSyncedRevision:2,bookingSyncPending:false};await seed(p);
   if(actor==='owner'){await assertSucceeds(sdk.setDoc(sdk.doc(context,pollPath),ack));passed++;}else await deny(context,ack,`${status}/${actor}/ack`);
   for(const [label,patch] of Object.entries({future:{bookingSyncedRevision:3},votes:{votes:{'80':'X'},order:['80']},status:{status:status==='published'?'deleted':'published'},clientsType:{bookingSyncedClients:[]},revisionType:{bookingSyncedRevision:'2'},pendingType:{bookingSyncPending:0},identity:{chat:'other'}})){
    await seed(p);await deny(context,{...ack,...patch},`${status}/${actor}/${label}`);
   }
  }
  for(const [label,patch] of Object.entries({future:{bookingSyncedRevision:3},votes:{votes:{'80':'X'},order:['80']},status:{status:status==='published'?'deleted':'published'}})) {
   await seed(p);await deny(db,{...p,...patch},`${status}/standalone/${label}`);
  }
  await seed({...p,bookingSyncedRevision:2});
  await assertSucceeds(sdk.setDoc(sdk.doc(db,pollPath),{...p,bookingSyncedRevision:2,bookingSyncPending:false}));passed++;
  await seed({...p,bookingSyncedRevision:2});await deny(db,{...p,bookingSyncedRevision:1},status+'/rollback');
 }
 for(const status of ['reserved','uncertain']){const p={...base,status,mid:null};await seed(p);await deny(db,{...p,bookingSyncedRevision:2,bookingSyncPending:false},status+'/ack');}
 await seed(base);
 const pending={...base,status:'deletePending',deleteRequestedAt:101};
 await assertSucceeds(sdk.setDoc(sdk.doc(db,pollPath),pending));passed++;
 await assertSucceeds(sdk.setDoc(sdk.doc(db,pollPath),{...pending,status:'deleted',deletedAt:102}));passed++;
 await seed(pending);const review={...pending,deleteNeedsReview:true,deleteReviewRequestedAt:102};
 await assertSucceeds(sdk.setDoc(sdk.doc(db,pollPath),review));passed++;
 await deny(db,{...review,status:'deleted',deletedAt:103},'review blocks deletion');
 await env.withSecurityRulesDisabled(c=>sdk.setDoc(sdk.doc(c.firestore(),'fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test'),{version:1,botId:131384398,bindings:[{clientId:'demo-client-1',maxUserId:80,maxChatId:80,notificationsEnabled:true,recoverNotifications:true}]}));
 const store=createCalendarPollStore({sdk,raw:db,botId:'131384398',validateAuth:async()=>{},writeEnabled:()=>true,bookingSyncEnabled:()=>true});
 await env.withSecurityRulesDisabled(c=>sdk.deleteDoc(sdk.doc(c.firestore(),pollPath)));
 assert.equal(await store.reserve(workout,{id:base.id,createdAt:100}),true);passed++;
 assert.equal(await store.finish(key,base.id,base.mid),true);passed++;

 const event={id:'emulator-real-vote',uuid:base.id,mid:base.mid,uid:'80',at:200,action:'yes',name:'Test'};
 assert.equal(await store.vote(key,event,()=>({text:'OK'})),true);passed++;
 assert.equal(await store.syncBookings(key),true);passed++;
 const lease=await store.claimEdit(key);assert.ok(lease);passed++;
 assert.equal(await store.finishEdit(key,lease.editLease.token,lease.revision),true);passed++;
 const {bookingId}=require('../src/fitpp-calendar-booking');
 const booking=sdk.doc(db,'fitppTestWorkspaces/synthetic-v1/calendarBookings/'+bookingId(workout.id,'demo-client-1'));
 assert.equal((await sdk.getDoc(booking)).data().booked,true);
 assert.equal(await store.vote(key,{...event,id:'emulator-real-cancel',at:201,action:'cancel'},()=>({text:'OK'})),true);passed++;
 assert.equal(await store.syncBookings(key),true);passed++;
 assert.equal((await sdk.getDoc(booking)).data().booked,false);
 assert.equal((await store.read(key)).bookingSyncedRevision,2);
 for(const status of ['deletePending','deleted']) {
  await seed({...base,status,revision:3,bookingSyncedRevision:2,bookingSyncedClients:{'80':'demo-client-1'},deleteRequestedAt:101,...(status==='deleted'?{deletedAt:102}:{})});
  assert.equal(await store.syncBookings(key),true);passed++;
  assert.equal((await store.read(key)).bookingSyncedRevision,3);
  assert.equal((await sdk.getDoc(booking)).data().booked,false);
 }
 console.log(`PASS ${passed} checks including real vote/cancel + booking sync`);
 }finally{await env.cleanup();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
