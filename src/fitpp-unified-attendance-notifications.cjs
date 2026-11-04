'use strict';
const {validateState,validBinding}=require('./fitpp-notification-dry-run.cjs');
const {attendanceBaseline}=require('./fitpp-receipt-notifications.cjs');
// The current Desktop FitPP writer commits attendance as mutationReceipts,
// advancing _fitppRevision rather than the legacy attendanceRevision counter.
function candidates(state,binding){
 validateState(state);
 const latest=new Map();
 for(const [id,r] of Object.entries(state.mutationReceipts||{})){
  if(r?.type!=='attendance'||typeof r.signature!=='string'||r.signature.length>32768||
     !Number.isSafeInteger(r.revision)||r.revision<1||r.revision>state._fitppRevision)continue;
  let value;try{value=JSON.parse(r.signature)}catch{continue}
  const a=value?.action;
  if(a?.type!=='attendance'||a.operationId!==id||typeof a.workoutId!=='string'||
     !/^demo-client-[1-4]$/.test(a.clientId||'')||typeof a.date!=='string'||
     !/^\d{4}-\d{2}-\d{2}$/.test(value.operationDay||''))continue;
  const key=JSON.stringify([a.workoutId,a.clientId]),old=latest.get(key);
  if(!old||r.revision>old.revision)latest.set(key,{id,a,revision:r.revision,ambiguous:false});
  else if(r.revision===old.revision)old.ambiguous=true;
 }
 const result=[];
 for(const {id,a,ambiguous,revision} of latest.values()){
  if(ambiguous||!['attended','missed'].includes(a.status)||!validBinding(binding,a.clientId))continue;
  const w=state.workouts[a.workoutId],op=state.visitOps?.[a.workoutId]?.[a.clientId];
  const clients=state.clients.filter(c=>c.id===a.clientId&&!c.archivedAt);
  const subs=clients.length===1?(clients[0].subscriptions||[]).filter(s=>s.id===op?.subscriptionId&&!s.cancelledAt):[];
  if(!w||w.id!==a.workoutId||w.cancelled!==false||w.date!==a.date||w.location!==a.location||
     !['zarya','pole','online'].includes(w.location)||!/^\d{4}-\d{2}-\d{2}$/.test(w.date)||
     op?.status!==a.status||op.workoutId!==w.id||op.location!==w.location||op.moneyChargeId||
     !/^[a-zA-Z0-9-]{8,128}$/.test(op.operationId||'')||
     state.visits?.[w.id]?.[a.clientId]!==a.status||subs.length!==1||
     !Number.isSafeInteger(subs[0].left)||subs[0].left<0)continue;
  result.push({operationId:op.operationId,workoutId:w.id,clientId:a.clientId,
   subscriptionId:op.subscriptionId,remaining:subs[0].left,previous:subs[0].left+1,
   status:a.status,date:w.date,maxChatId:binding.bindings.find(b=>b.clientId===a.clientId).maxChatId,
   receiptId:id,receiptRevision:revision});
 }
 return result;
}
function createSession({directory}={}){
 let seen;
 return {check(state,binding){
  const ids=Object.keys(state.mutationReceipts||{});
  if(!seen){seen=attendanceBaseline(directory,ids);if(!directory)return []}
  return candidates(state,binding).filter(item=>{
   if(seen.has(item.receiptId))return false;
   seen.add(item.receiptId);return true;
  });
 }};
}
function current(item,state,binding){return candidates(state,binding).some(now=>
 Object.keys(now).every(k=>now[k]===item[k]));}
module.exports={candidates,createSession,current};
