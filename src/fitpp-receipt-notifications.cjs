'use strict';
const { isDeepStrictEqual } = require('node:util');
const {validBinding}=require('./fitpp-notification-dry-run.cjs');
const {expiryTime,formatPurchase}=require('./fitpp-subscription-notifications.cjs');
const {frozenOn}=require('../direct-core/FitPP-Test/persistence.js');
const {reserve}=require('./fitpp-notification-send.cjs');
const kindOf=r=>r.type==='subscription'?'purchase':r.type==='freeze'?'freeze':'extension';
function valid(r,id){
 const e=r?.event;
 return e?.version===1&&e.operationId===id&&typeof e.cycleId==='string'&&e.cycleId&&
  typeof e.clientId==='string'&&typeof e.subscriptionId==='string'&&Number.isFinite(expiryTime(e.newExpires))&&(
   (r.type==='subscription'&&e.oldExpires===null&&Number.isSafeInteger(e.sessions)&&e.sessions>0)||
   (r.type==='extendSubscription'&&Number.isFinite(expiryTime(e.oldExpires))&&Number.isSafeInteger(e.days)&&e.days>0&&e.days<=14&&Date.parse(e.newExpires)-Date.parse(e.oldExpires)===e.days*86400000)||
   (r.type==='freeze'&&Number.isFinite(expiryTime(e.oldExpires))&&Number.isFinite(expiryTime(e.freezeStart))&&Number.isFinite(expiryTime(e.returnDate))&&Number.isSafeInteger(e.days)&&e.days>0&&Date.parse(e.returnDate)-Date.parse(e.freezeStart)===e.days*86400000&&Date.parse(e.newExpires)-Date.parse(e.oldExpires)===e.days*86400000));
}
// The unified FitPP writer stores the committed action as canonical JSON in
// signature. Older bot receipts use event. Normalize both without rewriting data.
function actionFor(r,id){
 try{
  if(typeof r?.signature!=='string'||r.signature.length>32768)return null;
  const value=JSON.parse(r.signature),a=value?.action;
  return a?.operationId===id&&a.type===r.type&&Number.isFinite(expiryTime(value.operationDay))?a:null;
 }catch{return null}
}
function eventFor(r,id,state){
 if(r?.event!==undefined)return valid(r,id)?r.event:null;
 const a=actionFor(r,id);
 if(!a||!['subscription','extendSubscription','freeze'].includes(a.type)||
    !Number.isSafeInteger(r.revision)||r.revision<1||r.revision>state._fitppRevision)return null;
 const cs=state.clients.filter(c=>c.id===a.clientId&&!c.archivedAt);if(cs.length!==1)return null;
 const subs=cs[0].subscriptions||[];
 let sub;
 if(a.type==='subscription'){
  const matches=subs.filter(s=>s.saleOperationId===id);if(matches.length!==1)return null;sub=matches[0];
 }else{
  if(!Number.isSafeInteger(a.subscriptionIndex)||a.subscriptionIndex<0)return null;
  sub=subs[a.subscriptionIndex];
 }
 if(!sub||sub.cancelledAt||typeof sub.saleOperationId!=='string'||typeof sub.saleRequest!=='string')return null;
 const sale=state.mutationReceipts?.[sub.saleOperationId];
 let saleAction;
 try{
  const storedSale=JSON.parse(sub.saleRequest);saleAction=actionFor(sale,sub.saleOperationId)||storedSale;
  if(!saleAction||saleAction.type!=='subscription'||saleAction.operationId!==sub.saleOperationId||saleAction.clientId!==a.clientId||
     !isDeepStrictEqual(JSON.parse(sub.saleRequest),Object.fromEntries(Object.entries(saleAction).filter(([k])=>k!=='balanceProofId')))||
     sub.id!=='subscription-'+sub.saleOperationId||sub.startDate!==saleAction.date||
     (sale?.revision!==undefined&&(!Number.isSafeInteger(sale.revision)||sale.revision>r.revision)))return null;
 }catch{return null}
 const add=(date,n)=>{if(!Number.isFinite(expiryTime(date))||!Number.isSafeInteger(n))return null;try{return new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)}catch{return null}};
 const event={version:1,operationId:id,cycleId:sub.saleOperationId,clientId:a.clientId,subscriptionId:sub.id};
 if(a.type==='subscription'){
  if(!Number.isSafeInteger(sub.terms?.sessions)||sub.terms.sessions<1||!Number.isSafeInteger(sub.terms?.durationDays)||sub.terms.durationDays<1)return null;
  Object.assign(event,{oldExpires:null,newExpires:add(sub.startDate,sub.terms.durationDays),sessions:sub.terms.sessions});
 }else if(a.type==='extendSubscription'){
  if((sale?.revision!==undefined&&sale.revision>=r.revision)||!Number.isSafeInteger(a.expectedUsed)||a.expectedUsed<0||
     !Number.isSafeInteger(a.days)||a.days<1||a.expectedUsed+a.days>14||
     !Number.isSafeInteger(sub.extensionDays)||sub.extensionDays<a.expectedUsed+a.days)return null;
  Object.assign(event,{oldExpires:a.expectedExpires,newExpires:add(a.expectedExpires,a.days),days:a.days});
 }else{
  const freezes=(sub.freezes||[]).filter(f=>f.version===1&&f.returnDate===a.returnDate&&
    (a.startDate===undefined||f.start===a.startDate));
  if(freezes.length!==1)return null;
  const f=freezes[0],days=(Date.parse(f.returnDate)-Date.parse(f.start))/86400000;
  Object.assign(event,{oldExpires:f.baseExpires,newExpires:add(f.baseExpires,days),freezeStart:f.start,returnDate:f.returnDate,days});
 }
 return valid({type:r.type,event},id)?event:null;
}
function current(item,state,binding){
 const r=state.mutationReceipts?.[item.requestId],event=eventFor(r,item.requestId,state);
 if(!event||!isDeepStrictEqual(r, JSON.parse(item.receipt))||item.kind!==kindOf(r)||
    Object.entries(event).some(([key,value])=>item[key]!==value))return false;
 const cs=state.clients.filter(c=>c.id===item.clientId&&!c.archivedAt);
 const ss=cs.length===1?(cs[0].subscriptions||[]).filter(s=>s.id===item.subscriptionId&&!s.cancelledAt):[];
 if(ss.length!==1||(ss[0].saleOperationId||ss[0].id)!==item.cycleId||!validBinding(binding,item.clientId))return false;
 const sub=ss[0];
 if(!Number.isSafeInteger(sub.left)||sub.left<0||!Number.isFinite(expiryTime(sub.expires)))return false;
 try{frozenOn(sub,sub.expires);}catch{return false;}
 // A freeze receipt describes the committed operation and its planned dates.
 // Early thaw (including cancellation of a pending freeze) can shorten the current
 // expiry or remove its history row. It cannot undo the successful receipt.
 // Other receipt kinds keep the existing expiry freshness rule.
 return item.kind==='freeze'||sub.expires>=item.newExpires;
}
function initialBaseline(directory,ids,name='receipt-baseline-v1.json',scope='fitpp-test:synthetic-v1:training-test:demo-client-1'){
 if(!directory)return new Set(ids);
 const fs=require('node:fs'),path=require('node:path');
 const file=path.join(directory,name);
 const read=()=>{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.version!==1||data.scope!==scope||
     !Array.isArray(data.ids)||data.ids.length>500||data.ids.some(id=>typeof id!=='string'||!id)||
     new Set(data.ids).size!==data.ids.length)throw Error('RECEIPT_BASELINE_REFUSED');
  return new Set(data.ids);
 };
 try{return read();}catch(e){if(e.code!=='ENOENT')throw e;}
 // Publish a fully flushed file exclusively: concurrent starters use the winner.
 // An interrupted write leaves only an unused temporary file, never a partial baseline.
 const temp=path.join(directory,'.receipt-baseline-'+require('node:crypto').randomUUID());
 let fd;
 try{
  fd=fs.openSync(temp,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify({version:1,scope,ids}));
  fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  try{fs.linkSync(temp,file);const d=fs.openSync(directory,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  catch(e){if(e.code!=='EEXIST')throw e;}
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.unlinkSync(temp);}
 return read();
}
function createReceiptSession({directory}={}){
 let seen;
 return {check(state,binding){
  const entries=Object.entries(state.mutationReceipts||{});
  // Without durable storage retain the previous read-only, no-history baseline.
  // In live mode the first baseline survives restarts: events committed after it
  // remain eligible even if the process stopped before the next poll. Durable
  // sender claims suppress already attempted events, including uncertain sends.
  if(!seen){
   const baseline=initialBaseline(directory,entries.map(([id])=>id));
   // The original durable cutoff applies to every receipt event type. Claims,
   // not a fresh in-memory baseline, suppress attempts after a restart.
   seen=new Set(directory?baseline:entries.map(([id])=>id));
   if(!directory)return [];
  }
  const result=[];
  for(const [id,r]of entries){
   if(seen.has(id))continue;seen.add(id);
   const event=eventFor(r,id,state);
   if(!event||!/^demo-client-[1-4]$/.test(event.clientId))continue;
   const item={...event,kind:kindOf(r),requestId:id,receipt:JSON.stringify(r)};
   if(current(item,state,binding))result.push(item);
  }
  return result;
 }};
}
const daysLabel=n=>n%100>=11&&n%100<=14?'дней':n%10===1?'день':n%10>=2&&n%10<=4?'дня':'дней';
function format(item){
 if(item.kind==='purchase')return formatPurchase({sessions:item.sessions,expires:item.newExpires});
 if(item.kind==='freeze')return `❄️ Абонемент заморожен!\n\n🧊 Возвращение: ${item.returnDate}\n📅 Новая дата окончания: ${item.newExpires.split('-').reverse().join('.')}\n\n🫶 Ждём возвращения на тренировки!`;
 return `📅 Абонемент продлён!\n\n➕ Продление: ${item.days} ${daysLabel(item.days)}\n📅 Новая дата окончания: ${item.newExpires.split('-').reverse().join('.')}\n\n🫶 Ждём на тренировке!`;
}
function createReceiptSender({env,directory,raw}){const {settings,verify}=require('./fitpp-notification-send.cjs');const token=settings(env);raw||=new (require('./api').MaxApi)(token);return {async send(item,state,binding){if(!current(item,state,binding))return 'stale';await verify(raw,binding,item.clientId);const text=format(item);if(!reserve(directory,'receipt-v1:'+item.requestId))return 'duplicate';try{await raw.send(String(binding.bindings.find(b=>b.clientId===item.clientId).maxChatId),{text,notify:false});return 'sent';}catch{return 'uncertain';}}};}
module.exports={createReceiptSession,createReceiptSender,current,format,eventFor,attendanceBaseline:(directory,ids)=>initialBaseline(directory,ids,'attendance-baseline-v1.json','fitpp-test:synthetic-v1:training-test:attendance-v1')};
