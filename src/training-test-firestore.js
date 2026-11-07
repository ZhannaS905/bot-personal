'use strict';
const {createHash,randomUUID}=require('node:crypto');
const OWNER_UID='lLlMAetSG1aEeJSeBl4F4ypydEh2',CHAT='-79450912874680';
const ROOT='trainingTestAutopostBots';
const DATE=/^\d{4}-\d{2}-\d{2}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,MID=/^mid\.[a-zA-Z0-9]+$/;
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value}
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function validDate(date){return typeof date==='string'&&DATE.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date}
function validate(p,botId,date){
 if(!p||p.version!==1||p.botId!==botId||p.chat!==CHAT||p.date!==date||!UUID.test(p.id)||!['reserved','published','uncertain','external'].includes(p.status)||!Number.isSafeInteger(p.revision)||p.revision<0||!Number.isSafeInteger(p.displayedRevision)||p.displayedRevision>p.revision||p.displayedRevision<0||!p.votes||Array.isArray(p.votes)||!p.last||Array.isArray(p.last)||!Array.isArray(p.order))throw Error('AUTOPOST_DOCUMENT_REFUSED');
 if(p.editLease&&(!UUID.test(p.editLease.token)||!Number.isSafeInteger(p.editLease.until)))throw Error('AUTOPOST_DOCUMENT_REFUSED');
 if(p.legacyDone&&(!Array.isArray(p.legacyDone)||p.legacyDone.some(id=>typeof id!=='string')))throw Error('AUTOPOST_DOCUMENT_REFUSED');
 if(['published','external'].includes(p.status)&&!MID.test(p.mid))throw Error('AUTOPOST_DOCUMENT_REFUSED');
 if(new Set(p.order).size!==p.order.length||p.order.length!==Object.keys(p.votes).length||p.order.some(uid=>!(/^[1-9]\d*$/.test(uid))||typeof p.votes[uid]!=='string'||p.votes[uid].length>100)||Object.entries(p.last).some(([uid,at])=>!(/^[1-9]\d*$/.test(uid))||!Number.isSafeInteger(at)))throw Error('AUTOPOST_DOCUMENT_REFUSED');
 return p;
}
function createFirestoreStore({sdk,raw,botId,validateAuth,writeEnabled=()=>false,now=Date.now}){
 if(raw?.app?.options?.projectId!=='fitpp-test'||typeof botId!=='string'||!/^[1-9]\d*$/.test(botId)||!Number.isSafeInteger(Number(botId))||typeof validateAuth!=='function')throw Error('AUTOPOST_FIRESTORE_SCOPE_REFUSED');
 const prefix=`${ROOT}/${botId}/polls/`;
 const pollRef=date=>{if(!validDate(date))throw Error('AUTOPOST_DATE_REFUSED');return sdk.doc(raw,prefix+date)};
 const eventRef=(date,id)=>sdk.doc(raw,prefix+date+'/events/'+hash(id));
 async function transact(date,fn){
  const ref=pollRef(date);await validateAuth();
  return sdk.runTransaction(raw,async tx=>{
   await validateAuth();const snap=await tx.get(ref),p=snap.exists()?validate(snap.data(),botId,date):null;
   const set=value=>{if(!writeEnabled())throw Error('AUTOPOST_FIRESTORE_WRITES_DISABLED');validate(value,botId,date);tx.set(ref,value)};
   const result=await fn({tx,ref,p,set});await validateAuth();return result;
  },{maxAttempts:5});
 }
 return {
  async read(date){await validateAuth();const s=await sdk.getDocFromServer(pollRef(date));await validateAuth();return s.exists()?validate(s.data(),botId,date):null},
  async reserve(date,candidate){return transact(date,({p,set})=>{if(p)return false;set({...candidate,version:1,botId,chat:CHAT,date,status:'reserved',mid:null,votes:{},order:[],last:{},revision:0,displayedRevision:0});return true})},
  async finish(date,id,mid){if(!MID.test(mid))throw Error('AUTOPOST_MID_REQUIRED');return transact(date,({p,set})=>{if(!p||p.id!==id||p.status!=='reserved')throw Error('AUTOPOST_RESERVATION_REFUSED');set({...p,status:'published',mid});return true})},
  async uncertain(date,id){return transact(date,({p,set})=>{if(p?.id===id&&p.status==='reserved')set({...p,status:'uncertain'});return false})},
  async vote(date,event,render){return transact(date,async({tx,p,set})=>{
   const ref=eventRef(date,event.id),receipt=await tx.get(ref),digest=hash(event);
   if(receipt.exists()){if(receipt.data().digest!==digest)throw Error('AUTOPOST_EVENT_CONFLICT');return false}
   if(!p||p.legacyDone?.includes(event.id)||p.status!=='published'||p.id!==event.uuid||p.mid!==event.mid||event.at<=(p.last[event.uid]??-1))return false;
   const next=structuredClone(p);next.last[event.uid]=event.at;
   if(event.action==='cancel'){delete next.votes[event.uid];next.order=next.order.filter(uid=>uid!==event.uid)}
   else {if(!Object.hasOwn(next.votes,event.uid))next.order.push(event.uid);next.votes[event.uid]=event.name}
   if(Array.from(render(next).text).length>4000)return false;
   next.revision++;set(next);
   // No nested arrays, delete operations, customer paths or unbounded event arrays.
   tx.set(ref,{digest,at:event.at});return true;
  })},
  async claimEdit(date){const token=randomUUID();return transact(date,({p,set})=>{
   if(p?.status!=='published'||p.revision===p.displayedRevision||(p.editLease&&p.editLease.until>now()))return null;
   const claimed={...p,editLease:{token,until:now()+120000}};set(claimed);return claimed;
  })},
  async checkEdit(date,token){const p=await this.read(date);if(p?.editLease?.token!==token||p.editLease.until<now()+20000)throw Error('AUTOPOST_EDIT_LEASE_EXPIRED')},
  async finishEdit(date,token,revision){return transact(date,({p,set})=>{
   if(p?.editLease?.token!==token)return false;
   // A concurrent vote must stay dirty even when an older PUT succeeded.
   const next={...p,displayedRevision:Math.max(p.displayedRevision,revision)};delete next.editLease;set(next);return true;
  })},
  async releaseEdit(date,token){return transact(date,({p,set})=>{if(p?.editLease?.token===token){const next={...p};delete next.editLease;set(next)};return false})},
  // Explicit administrative migration only; never called automatically by runtime.
  async importLegacy(date,legacy){
   const votes=Object.fromEntries(legacy.votes),last=Object.fromEntries(legacy.last);
   const candidate={version:1,botId,chat:CHAT,date,id:legacy.id,status:legacy.status,mid:legacy.mid??null,votes,order:legacy.votes.map(v=>String(v[0])),last,revision:legacy.dirty?1:0,displayedRevision:0,legacyDone:legacy.done};
   validate(candidate,botId,date);
   if(!Array.isArray(legacy.done)||legacy.done.some(id=>typeof id!=='string'))throw Error('AUTOPOST_LEGACY_REFUSED');
   return transact(date,({p,set})=>{if(p){if(hash(p)!==hash(candidate))throw Error('AUTOPOST_IMPORT_CONFLICT');return false}set(candidate);return true});
  },
  close(){}
 };
}
module.exports={createFirestoreStore,validate,validDate,ROOT,OWNER_UID,CHAT};
