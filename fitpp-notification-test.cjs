'use strict';
// Explicit standalone watcher; no polling/webhook changes, no Firestore writes.
const fs = require('node:fs');
const {config,signIn,readBoth} = require('./fitpp-notification-preview.cjs');
const {createPreviewSession} = require('./src/fitpp-notification-dry-run.cjs');
const {createSender,settings} = require('./src/fitpp-notification-send.cjs');
let lastEmptyCandidatesLog = -Infinity;
async function main(env=process.env,args=process.argv.slice(2),{
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  storageRoot=env.FITPP_NOTIFICATION_STORAGE_ROOT || '/app/data'
}={}) {
  const mode=args.join(' ');
  if (!['--verify','--watch','--send --watch'].includes(mode)) throw Error('ARGUMENT_REFUSED');
  config(env);settings(env);
  const live=mode==='--send --watch';
  const directory=require('node:path').join(storageRoot,'fitpp-notification-attempts-v1');
  if(live){
    const path=require('node:path');
    const confirmed=env.FITPP_NOTIFICATION_STORAGE_CONFIRMED;
    if(confirmed === 'fitpp-test:training-test:storage-check-20261026') {
      // Operator verified these exact files across restart AND rebuild on Training Test.
      // Never create or repair the evidence: a missing volume must stop sending.
      if(storageRoot !== '/app/data' ||
         fs.readFileSync(path.join(storageRoot,'fitpp-storage-check.txt'),'utf8').trim() !== 'fitpp-storage-check-20261026' ||
         fs.readFileSync(path.join(directory,'f50668b32b88ed07d5831a719737b31b6aff4c59b9f4b8f4aa6362a8bf7e3a3e'),'utf8') !== 'attempted\n')
        throw Error('DURABLE_STORAGE_REQUIRED');
    } else if(confirmed !== 'fitpp-test:synthetic-v1:training-test:v1' ||
       fs.readFileSync(path.join(storageRoot,'.fitpp-notification-volume'),'utf8').trim() !== confirmed)
      throw Error('DURABLE_STORAGE_REQUIRED');
    if(!fs.statSync(storageRoot).isDirectory())throw Error('DURABLE_STORAGE_REQUIRED');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
  }
  const sender=createSender({env,directory}), session=createPreviewSession();
  const expiryEnabled=env.FITPP_NOTIFICATION_EXPIRY_ENABLED==='true';
  const expirySessions=Array.from({length:4},(_,i)=>require('./src/fitpp-subscription-notifications.cjs').createExpirySession({clientId:'demo-client-'+(i+1)}));
  const expirySender=require('./src/fitpp-notification-send.cjs').createExpirySender({env,directory});
  const receipts=require('./src/fitpp-receipt-notifications.cjs');
  const receiptSession=receipts.createReceiptSession(live&&env.FITPP_NOTIFICATION_RECEIPTS_ENABLED==='true'?{directory}:{}), receiptSender=receipts.createReceiptSender({env,directory});
  let token=await signIn(env),expires=Date.now()+45*60000;
  const unified=require('./src/fitpp-unified-attendance-notifications.cjs');
  const unifiedSession=unified.createSession(live?{directory}:{});
  const pendingVisits=new Map(), pendingReceipts=new Map();
  do {
   try {
    if(Date.now()>=expires){token=await signIn(env);expires=Date.now()+45*60000}
    const {main:state,binding}=await readBoth(token);
    await sender.verify(binding);
    if(mode==='--verify'){console.log('FITPP_NOTIFICATION_VERIFIED no_send no_firestore_write');return}
    const {baseline,candidates:legacyCandidates}=session.check(state,binding);
    const candidates=[...legacyCandidates,...unifiedSession.check(state,binding)];
    for(const item of candidates)pendingVisits.set(item.operationId,item);
    const receiptCandidates=env.FITPP_NOTIFICATION_RECEIPTS_ENABLED==='true'?receiptSession.check(state,binding):[];
    for(const item of receiptCandidates)pendingReceipts.set(item.requestId,item);
    if(live)for(const result of await require('./src/fitpp-notification-recovery.cjs').recover({state,binding,env,directory,excludeReceiptIds:[...pendingReceipts.keys()],readFresh:()=>readBoth(token)}))
      console.log('FITPP_RECOVERY_RESULT '+result);
    for(const item of pendingReceipts.values()){
      const fresh=await readBoth(token);
      if(receipts.current(item,fresh.main,fresh.binding)){
        if(!live)console.log('FITPP_RECEIPT_PREVIEW '+JSON.stringify(receipts.format(item)));
        console.log('FITPP_RECEIPT_RESULT '+(live?await receiptSender.send(item,fresh.main,fresh.binding):'dry-run'));
      }
      pendingReceipts.delete(item.requestId);
    }
    if(expiryEnabled)for(const item of expirySessions.flatMap(session=>session.check(state,binding,Date.now()))) {
      // Refresh immediately before attempting: extension/cancellation/balance may change.
      const fresh=await readBoth(token);
      if(require('./src/fitpp-subscription-notifications.cjs').stillCurrent(item,fresh.main,fresh.binding))
        console.log('FITPP_EXPIRY_RESULT '+(live?await expirySender.send(item,fresh.binding):'dry-run'));
    }
    if(baseline)console.log('FITPP_NOTIFICATION_BASELINE no_history_send');
    else if(candidates.length)console.log('FITPP_NOTIFICATION_CANDIDATES '+candidates.length);
    else if(Date.now()-lastEmptyCandidatesLog>=60*60000){
      console.log('FITPP_NOTIFICATION_CANDIDATES 0');
      lastEmptyCandidatesLog=Date.now();
    }
    for(const item of pendingVisits.values()){
      // A pre-send transport failure leaves the item queued. Recheck committed
      // intent and remaining balance before a later attempt, never replay a
      // corrected/cancelled visit or send stale balance to another binding.
      const fresh=live?await readBoth(token):{main:state,binding};
      const op=fresh.main.visitOps?.[item.workoutId]?.[item.clientId];
      const client=fresh.main.clients?.find(c=>c.id===item.clientId&&!c.archivedAt);
      const sub=client?.subscriptions?.find(s=>s.id===item.subscriptionId&&!s.cancelledAt);
      const workout=fresh.main.workouts?.[item.workoutId];
      const row=fresh.binding.bindings?.find(b=>b.clientId===item.clientId);
      if((!item.receiptId||unified.current(item,fresh.main,fresh.binding))&&
         op?.operationId===item.operationId&&op.status===item.status&&op.subscriptionId===item.subscriptionId&&
         fresh.main.visits?.[item.workoutId]?.[item.clientId]===item.status&&sub?.left===item.remaining&&
         workout?.cancelled===false&&workout.date===item.date&&workout.location===op.location&&
         row?.notificationsEnabled===true&&row.maxChatId===item.maxChatId){
        console.log('FITPP_NOTIFICATION_RESULT '+(live?await sender.send(item,fresh.binding):'dry-run'));
      }
      pendingVisits.delete(item.operationId);
    }
   } catch(error) {
    if(!transientFailure(error))throw error;
    // Keep detector baselines and unsent candidates across temporary read or
    // verification errors. Reserved/uncertain sends are still never retried.
    console.log('FITPP_NOTIFICATION_RETRY reason='+failureReason(error));
   }
    await wait(30000);
  } while(true);
}
if(require.main===module)(async()=>{let lock;try{if(process.argv.slice(2).join(' ')==='--send --watch')lock=await require('./src/fitpp-notification-lock.cjs').acquire();await main()}finally{lock?.close()}})().catch(error=>{console.error('FITPP_NOTIFICATION_STOPPED verification_or_io_failed no_automatic_retry reason='+failureReason(error));process.exitCode=1});
function transientFailure(error){
 const reason=failureReason(error);
 return /^(?:MAX_HTTP_|HTTP_)(?:429|500|502|503|504)$/.test(reason)||
   ['ECONNRESET','ENOTFOUND','ETIMEDOUT','TIMEOUT_OR_ABORT'].includes(reason);
}
function failureReason(error){
  const message=error?.message||'';
  if(/^(?:MAX HTTP [1-5][0-9]{2}|HTTP_[1-5][0-9]{2})$/.test(message))return message.replaceAll(' ','_');
  if(['NOTIFICATION_SCOPE_REFUSED','NOTIFICATION_BINDING_REFUSED','NOTIFICATION_IDENTITY_REFUSED',
      'NOTIFICATION_RECIPIENT_REFUSED','DURABLE_STORAGE_REQUIRED','RECEIPT_BASELINE_REFUSED',
      'STATE_REFUSED','BINDING_REFUSED','UID_REFUSED','TOKEN_REFUSED','PATH_REFUSED',
      'CONFIG_MISSING','PROJECT_REFUSED'].includes(message))return message;
  if(['EACCES','ENOENT','ENOSPC','EROFS','ECONNRESET','ENOTFOUND','ETIMEDOUT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code))return error.code;
  if(['ECONNRESET','ENOTFOUND','ETIMEDOUT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.cause?.code))return error.cause.code;
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'TIMEOUT_OR_ABORT';
  return 'UNKNOWN';
}
module.exports={main,failureReason,transientFailure};
