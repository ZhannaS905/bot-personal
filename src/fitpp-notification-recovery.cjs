'use strict';
// Explicit recovery requested by verified activation. Reads only; shares the
// existing durable attempt keys, so uncertain/legacy attempts are never retried.
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {validateState,validBinding}=require('./fitpp-notification-dry-run.cjs');
const receipts=require('./fitpp-receipt-notifications.cjs');
const {expiryTime,formatExpiry}=require('./fitpp-subscription-notifications.cjs');
const {settings,verify,reserve}=require('./fitpp-notification-send.cjs');
const {MaxApi}=require('./api');
function claimed(directory,key){
 try{fs.accessSync(path.join(directory,createHash('sha256').update('fitpp-test:synthetic-v1:'+key).digest('hex')));return true}
 catch(e){if(e.code==='ENOENT')return false;throw e}
}
function candidates(state,binding,now=Date.now()){
 validateState(state);
 const result=[];
 for(const row of binding?.bindings||[]){
  const cid=row.clientId;
  if(!/^demo-client-[1-4]$/.test(cid)||row.recoverNotifications!==true||!validBinding(binding,cid))continue;
  const client=state.clients.find(c=>c.id===cid&&!c.archivedAt);if(!client)continue;
  for(const [id,r]of Object.entries(state.mutationReceipts||{})){
   const event=receipts.eventFor(r,id,state);
   if(event?.clientId!==cid)continue;
   const kind=r.type==='subscription'?'purchase':r.type==='freeze'?'freeze':'extension';
   const item={...event,kind,requestId:id,receipt:JSON.stringify(r)};
   if(receipts.current(item,state,binding))result.push({kind:'receipt',clientId:cid,item,keys:['receipt-v1:'+id],maxChatId:row.maxChatId});
  }
  for(const [wid,ops]of Object.entries(state.visitOps)){
   const op=ops[cid],w=state.workouts[wid];
   if(!op||!['attended','missed'].includes(op.status)||state.visits[wid]?.[cid]!==op.status||op.moneyChargeId||
      !/^[a-zA-Z0-9-]{8,128}$/.test(op.operationId||'')||!w||w.id!==wid||w.cancelled!==false||op.workoutId!==wid||op.location!==w.location||
      !['zarya','pole','online'].includes(w.location)||!Number.isFinite(expiryTime(w.date)))continue;
   const same=Object.values(state.visitOps).flatMap(rows=>Object.values(rows)).filter(x=>x.operationId===op.operationId);
   if(same.length!==1)continue;
   const subs=(client.subscriptions||[]).filter(s=>s.id===op.subscriptionId&&!s.cancelledAt);
   if(subs.length!==1||!Number.isSafeInteger(subs[0].left)||subs[0].left<0)continue;
   result.push({kind:'visit',clientId:cid,workoutId:wid,date:w.date,status:op.status,remaining:subs[0].left,
    keys:[op.operationId,'visit:'+JSON.stringify([cid,wid])],maxChatId:row.maxChatId});
  }
  for(const sub of client.subscriptions||[]){
   if(sub.cancelledAt||typeof sub.id!=='string'||!sub.id||!Number.isSafeInteger(sub.left)||sub.left<1||!Number.isFinite(expiryTime(sub.expires))||now<expiryTime(sub.expires))continue;
   result.push({kind:'expiry',clientId:cid,subscriptionId:sub.id,expires:sub.expires,remaining:sub.left,
    keys:['expiry-v1:'+JSON.stringify([cid,sub.id,sub.expires])],maxChatId:row.maxChatId});
  }
 }
 return result;
}
function format(item){
 let text;
 if(item.kind==='receipt')text=receipts.format(item.item);
 else if(item.kind==='expiry')text=formatExpiry(item);
 else text=`${item.status==='attended'?'✅ Посещение':'🔥 Занятие сгорело'}\n\n📅 ${item.date.split('-').reverse().join('.')}\nС абонемента списано 1 занятие.\n\nСейчас по абонементу осталось занятий: ${item.remaining}`;
 return '📨 Пропущенное уведомление\n\n'+text;
}
async function recover({state,binding,readFresh,env,directory,raw,now=Date.now,excludeReceiptIds=[]}){
 const completion=row=>'recovery-completed-v1:'+JSON.stringify([row.clientId,row.maxUserId,row.maxChatId]);
 const rows=(binding?.bindings||[]).filter(row=>/^demo-client-[1-4]$/.test(row.clientId)&&row.recoverNotifications===true&&validBinding(binding,row.clientId));
 const completed=new Set(rows.filter(row=>claimed(directory,completion(row))).map(row=>row.clientId));
 const excluded=new Set(excludeReceiptIds);
 const scoped={...binding,bindings:(binding?.bindings||[]).map(row=>rows.includes(row)?row:{...row,recoverNotifications:false})};
 const unclaimed=candidates(state,scoped,now()).filter(item=>(item.kind==='receipt'?!excluded.has(item.item.requestId):!completed.has(item.clientId))&&!item.keys.some(key=>claimed(directory,key)));
 const enabled=item=>(item.kind!=='receipt'||env.FITPP_NOTIFICATION_RECEIPTS_ENABLED==='true')&&
   (item.kind!=='expiry'||env.FITPP_NOTIFICATION_EXPIRY_ENABLED==='true');
 const deferred=new Set(unclaimed.filter(item=>!enabled(item)).map(item=>item.clientId));
 const pending=unclaimed.filter(enabled);
 if(!rows.length)return [];
 const token=settings(env);raw||=new MaxApi(token);
 const results=[];
 for(const old of pending){
  const fresh=await readFresh();
  const item=candidates(fresh.main,fresh.binding,now()).find(item=>{
   // REST map field ordering is not stable. Compare the parsed receipt, while
   // retaining every identity, recipient and event freshness check.
   if(item.kind!=='receipt'||old.kind!=='receipt')return isDeepStrictEqual(item,old);
   const normalized=value=>({...value,item:{...value.item,receipt:JSON.parse(value.item.receipt)}});
   return isDeepStrictEqual(normalized(item),normalized(old));
  });
  if(!item){results.push('stale');continue}
  await verify(raw,fresh.binding,item.clientId);
  const text=format(item);
  if(item.keys.some(key=>claimed(directory,key))){results.push('duplicate');continue}
  if(!item.keys.every(key=>reserve(directory,key))){results.push('duplicate');continue}
  try{await raw.send(String(item.maxChatId),{text,notify:false});results.push('sent')}
  catch{results.push('uncertain')}
 }
 if(!results.includes('stale'))for(const row of rows)if(!deferred.has(row.clientId))reserve(directory,completion(row));
 return results;
}
module.exports={candidates,format,recover};
