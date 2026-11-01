'use strict';
// Isolated Training Test per-workout poll store. Never reads or writes legacy
// polls/{date}; all mutations are scoped to the stable workout hash.
const {createHash,randomUUID}=require('node:crypto');
const {workoutKey}=require('./fitpp-calendar-poll-plan');
const {resolveClient}=require('./fitpp-calendar-booking-link');
const {bookingId,bookingRecord}=require('./fitpp-calendar-booking');
const {bookingChanges}=require('./fitpp-calendar-booking-reconcile');
const {CHAT}=require('./training-test-firestore');
const ROOT='trainingTestCalendarPolls';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MID=/^mid\.[a-zA-Z0-9]+$/;
const KEY=/^[a-f0-9]{64}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function validate(p,botId,key){
 if(!p||p.version!==1||p.botId!==botId||p.chat!==CHAT||p.key!==key||!KEY.test(key)||!UUID.test(p.id)||
 !['reserved','published','uncertain','deletePending','deleted'].includes(p.status)||!p.workout||workoutKey(p.workout)!==key||
 !Number.isSafeInteger(p.createdAt)||!Number.isSafeInteger(p.revision)||!Number.isSafeInteger(p.displayedRevision)||
 (p.lastEventUid!==undefined&&p.lastEventUid!==null&&(typeof p.lastEventUid!=='string'||!/^[1-9]\d*$/.test(p.lastEventUid)))||p.displayedRevision<0||p.displayedRevision>p.revision||!p.votes||Array.isArray(p.votes)||
 !p.last||Array.isArray(p.last)||!Array.isArray(p.order)||new Set(p.order).size!==p.order.length||
 p.order.length!==Object.keys(p.votes).length||p.order.some(uid=>!/^[1-9]\d*$/.test(uid)||typeof p.votes[uid]!=='string'||p.votes[uid].length>100)||
 Object.entries(p.last).some(([uid,at])=>!/^[1-9]\d*$/.test(uid)||!Number.isSafeInteger(at))||
 (['published','deletePending','deleted'].includes(p.status)&&!MID.test(p.mid))||
 (p.editLease&&(!UUID.test(p.editLease.token)||!Number.isSafeInteger(p.editLease.until))))throw Error('CALENDAR_POLL_DOCUMENT_REFUSED');
 return p;
}
function createCalendarPollStore({sdk,raw,botId,validateAuth,writeEnabled=()=>false,bookingSyncEnabled=()=>false,now=Date.now}){
 if(raw?.app?.options?.projectId!=='fitpp-test'||typeof botId!=='string'||!/^[1-9]\d*$/.test(botId)||typeof validateAuth!=='function')throw Error('CALENDAR_POLL_SCOPE_REFUSED');
 const prefix=ROOT+'/'+botId+'/polls/';
 const bindingsPath='fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test';
 const bookingPrefix='fitppTestWorkspaces/synthetic-v1/calendarBookings/';
 const ref=key=>{if(!KEY.test(key))throw Error('CALENDAR_POLL_KEY_REFUSED');return sdk.doc(raw,prefix+key)};
 async function tx(key,fn){
  await validateAuth();
  return sdk.runTransaction(raw,async transaction=>{
   await validateAuth();
   const snap=await transaction.get(ref(key)),p=snap.exists()?validate(snap.data(),botId,key):null;
   const set=value=>{if(!writeEnabled())throw Error('CALENDAR_POLL_WRITES_DISABLED');validate(value,botId,key);transaction.set(ref(key),value)};
   const result=await fn({transaction,p,set});await validateAuth();return result;
  },{maxAttempts:5});
 }
 return {
  async read(key){await validateAuth();const snap=await sdk.getDocFromServer(ref(key));await validateAuth();return snap.exists()?validate(snap.data(),botId,key):null},
  async listPublished(){
   await validateAuth();
   const collection=sdk.collection(raw,ROOT,botId,'polls');
   const query=sdk.query(collection,sdk.where('status','==','published'));
   const snap=await sdk.getDocsFromServer(query);
   await validateAuth();
   return snap.docs.map(doc=>validate(doc.data(),botId,doc.id));
  },
  async listPendingBookingSync() {
    await validateAuth();
    const collection = sdk.collection(raw, ROOT, botId, 'polls');
    const query = sdk.query(
      collection,
      sdk.where('bookingSyncPending', '==', true)
    );
    const snap = await sdk.getDocsFromServer(query);
    await validateAuth();
    return snap.docs.map(doc => validate(doc.data(), botId, doc.id));
  },

  async listPendingDeletes(){
   await validateAuth();
   const collection=sdk.collection(raw,ROOT,botId,'polls');
   const query=sdk.query(collection,sdk.where('status','==','deletePending'));
   const snap=await sdk.getDocsFromServer(query);
   await validateAuth();
   return snap.docs.map(doc=>validate(doc.data(),botId,doc.id));
  },

  async reserve(workout,candidate){
   const key=workoutKey(workout);
   return tx(key,({p,set})=>{
    if(p)return false; // No automatic resend after an uncertain send.
    set({version:1,botId,chat:CHAT,key,id:candidate.id,createdAt:candidate.createdAt,workout:structuredClone(workout),
     status:'reserved',mid:null,votes:{},last:{},lastEventUid:null,order:[],revision:0,displayedRevision:0,bookingSyncedRevision:0,bookingSyncedClients:{},bookingSyncPending:false});return true;
   });
  },
  async finish(key,id,mid){if(!MID.test(mid))throw Error('CALENDAR_POLL_MID_REFUSED');return tx(key,({p,set})=>{
   if(p?.id!==id||p.status!=='reserved')throw Error('CALENDAR_POLL_RESERVATION_REFUSED');
   set({...p,status:'published',mid});return true;
  })},
  async beginDelete(key,id,mid){
   if(!UUID.test(id)||!MID.test(mid))throw Error('CALENDAR_DELETE_REFUSED');
   return tx(key,({p,set})=>{
    if(p?.id!==id||p.mid!==mid||p.status!=='published')return false;
    const next={...p,status:'deletePending',deleteRequestedAt:now()};
    delete next.editLease;
    set(next);
    return true;
   });
  },

  async markDeleteNeedsReview(key,id,mid){
   if(!UUID.test(id)||!MID.test(mid))throw Error('CALENDAR_DELETE_REFUSED');
   return tx(key,({p,set})=>{
    if(p?.id!==id||p.mid!==mid||p.status!=='deletePending')return false;
    set({...p,deleteNeedsReview:true,deleteReviewRequestedAt:now()});
    return true;
   });
  },

  async finishDelete(key,id,mid){
   if(!UUID.test(id)||!MID.test(mid))throw Error('CALENDAR_DELETE_REFUSED');
   return tx(key,({p,set})=>{
    if(p?.id!==id||p.mid!==mid||p.status!=='deletePending'||p.deleteNeedsReview===true)return false;
    const next={...p,status:'deleted',deletedAt:now()};
    delete next.editLease;
    set(next);
    return true;
   });
  },

  async uncertain(key,id){return tx(key,({p,set})=>{
   if(p?.id===id&&p.status==='reserved')set({...p,status:'uncertain'});return false;
  })},
  async vote(key,event,render){
   return tx(key,async({transaction,p,set})=>{
    if(!event||typeof event.id!=='string'||!event.id||event.id.length>256||
      !/^[1-9]\d*$/.test(event.uid)||!Number.isSafeInteger(event.at)||!['yes','cancel'].includes(event.action))throw Error('CALENDAR_POLL_EVENT_REFUSED');
    const receiptRef=sdk.doc(raw,prefix+key+'/events/'+hash(event.id));
    const receipt=await transaction.get(receiptRef),digest=hash(event);
    if(receipt.exists()){if(receipt.data().digest!==digest)throw Error('CALENDAR_POLL_EVENT_CONFLICT');return false}
    if(p?.status!=='published'||p.cancelled===true||p.id!==event.uuid||p.mid!==event.mid||event.at<=(p.last[event.uid]??-1))return false;
    const next=structuredClone(p);next.last[event.uid]=event.at;next.lastEventUid=event.uid;
    if(event.action==='cancel'){delete next.votes[event.uid];next.order=next.order.filter(uid=>uid!==event.uid)}
    else{if(typeof event.name!=='string'||event.name.length>100)throw Error('CALENDAR_POLL_EVENT_REFUSED');
     if(!Object.hasOwn(next.votes,event.uid))next.order.push(event.uid);next.votes[event.uid]=event.name}
    if(Array.from(render(next).text).length>4000)return false;
    next.revision++;next.bookingSyncPending=true;set(next);transaction.set(receiptRef,{digest,at:event.at});return true;
   });
  },
  async syncBookings(key) {
    if (!bookingSyncEnabled()) return false;

    return tx(key, async ({transaction, p, set}) => {
      if (!p || !['published', 'deletePending', 'deleted'].includes(p.status)) {
        return false;
      }

      const syncedRevision = p.bookingSyncedRevision ?? 0;
      const syncedClients = p.bookingSyncedClients ?? {};

      if (syncedRevision === p.revision) return false;

      const bindingsSnap = await transaction.get(sdk.doc(raw, bindingsPath));
      if (!bindingsSnap.exists()) {
        throw Error('CALENDAR_BOOKING_BINDINGS_MISSING');
      }

      const registry = bindingsSnap.data();
      const resolved = new Map();
      let unresolved = false;

      for (const uid of Object.keys(p.votes)) {
        const clientId = resolveClient(registry, uid, botId);
        resolved.set(uid, clientId);
        if (!clientId) unresolved = true;
      }

      const {changes, nextClients} = bookingChanges(
        p,
        syncedClients,
        uid => resolved.has(uid)
          ? resolved.get(uid)
          : resolveClient(registry, uid, botId)
      );

      if (!writeEnabled()) throw Error('CALENDAR_POLL_WRITES_DISABLED');

      for (const change of changes) {
        const id = bookingId(p.workout.id, change.clientId);
        const bookingRef = sdk.doc(raw, bookingPrefix + id);
        const record = bookingRecord(
          p.workout,
          change.clientId,
          change.booked,
          change.uid,
          p.revision
        );
        transaction.set(bookingRef, record);
      }

      set({
        ...p,
        bookingSyncedRevision: unresolved
          ? syncedRevision
          : p.revision,
        bookingSyncedClients: nextClients,
        bookingSyncPending: unresolved
      });

      return true;
    });
  },

  async syncWorkout(key, workout) {
    if (!workout || workoutKey(workout) !== key ||
        typeof workout.cancelled !== 'boolean') {
      throw Error('CALENDAR_WORKOUT_SYNC_REFUSED');
    }

    return tx(key, ({p, set}) => {
      if (p?.status !== 'published') return false;

      const changed =
        p.workout.date !== workout.date ||
        p.workout.time !== workout.time ||
        p.workout.location !== workout.location ||
        Boolean(p.cancelled) !== workout.cancelled;

      if (!changed) return false;

      const next = {
        ...p,
        workout: structuredClone(workout),
        cancelled: workout.cancelled,
        revision: p.revision + 1
      };

      set(next);
      return true;
    });
  },
  async claimEdit(key){const token=randomUUID();return tx(key,({p,set})=>{
   if(p?.status!=='published'||p.revision===p.displayedRevision||p.editLease?.until>now())return null;
   const next={...p,editLease:{token,until:now()+120000}};set(next);return next;
  })},
  async checkEdit(key,token){const p=await this.read(key);if(p?.editLease?.token!==token||p.editLease.until<now()+20000)throw Error('CALENDAR_POLL_EDIT_LEASE_EXPIRED')},
  async finishEdit(key,token,revision){return tx(key,({p,set})=>{
   if(p?.status!=='published'||p.editLease?.token!==token)return false;
   const next={...p,displayedRevision:Math.max(p.displayedRevision,revision)};delete next.editLease;set(next);return true;
  })},
  async releaseEdit(key,token){return tx(key,({p,set})=>{
   if(p?.editLease?.token===token){const next={...p};delete next.editLease;set(next)}return false;
  })},
  close(){}
 };
}
module.exports={ROOT,validate,createCalendarPollStore};
