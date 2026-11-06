'use strict';
const {MaxApi}=require('./api');
const {at,mark}=require('./fitpp-direct-diagnostic');
const {config}=require('./memory-training-test');
const {checkTestBotIdentity,identityAccepted}=require('./test-bot-identity');
const {contactLinking}=require('./contact-linking');
async function prepare({env=process.env,sdk,fetchImpl=fetch,now=Date.now,session:sharedSession}={}){
 if(env.CONTACT_LINK_ENABLED!=='true'||env.OWNER_DIALOG_ENABLED==='true'||
    !['false','true'].includes(env.CONTACT_LINK_REPLY_ENABLED)||
    !['false','true'].includes(env.CONTACT_LINK_WRITES_ENABLED))throw Error('CONTACT_CONFIG_REFUSED');
 // Admin configuration governs admin commands, never participant activation.
 const c=config(env);
 const sessionModule=require('./fitpp-direct-session');
 // This mode never starts the booking transport or scheduler. Its write capability
 // remains separate even if the existing server has direct booking flags enabled.
 const sessionEnv={...env,FITPP_DIRECT_ENABLED:'true',FITPP_DIRECT_WRITES_ENABLED:'false'};
 sessionModule.settings(sessionEnv);
 const raw=new MaxApi(c.token,fetchImpl);
 const identity=await at('CONTACT_MAX_IDENTITY',async()=>{
  const value=await raw.request('GET','/me');
  if(!identityAccepted(checkTestBotIdentity(value,c.expectedId)))throw Error('TEST_IDENTITY_REFUSED');
  return value;
 });
 const session=sharedSession||await at('CONTACT_CONNECT',()=>sessionModule.connect({env:sessionEnv,sdk}));
 const close=sharedSession?async()=>{}:session.close;
 try{
  const store=session.contactStore(identity.user_id,{writeEnabled:()=>env.CONTACT_LINK_WRITES_ENABLED==='true'});
  await at('CONTACT_STORE',()=>store.inspect()); // Read-only transaction: main + registry, no phone output.
  const handler=contactLinking({botId:identity.user_id,token:c.token,store,now,personal:env.FIREBASE_PROJECT_ID===require('./fitpp-personal/runtime-config').projectId});
  const seen=new Set();let tail=Promise.resolve();
  async function receive(u){
   const user=u?.update_type==='bot_started'?u.user:u?.update_type==='message_callback'?u.callback?.user:u?.message?.sender;
   const chat=u?.update_type==='bot_started'?u.chat_id:u?.message?.recipient?.chat_id;
   if(!Number.isSafeInteger(user?.user_id)||user.user_id<=0||user.is_bot!==false||!Number.isSafeInteger(chat)||chat===0)return;
   // Reserve before processing/sending; never retry an ambiguous MAX send.
   const key=u.update_type==='bot_started'?`start:${user.user_id}:${chat}:${u.timestamp}`:
    u.update_type==='message_callback'?`callback:${user.user_id}:${chat}:${u.callback?.callback_id||''}`:`message:${user.user_id}:${chat}:${u.message?.body?.mid||''}`;
   if(key.endsWith(':')||seen.has(key))return;
   if(seen.size>=512)throw Error('CONTACT_EVENT_LIMIT');
   seen.add(key);
   const draft=await handler.receive(u);
   if(draft&&env.CONTACT_LINK_REPLY_ENABLED==='true'){
    if(draft.userId!==user.user_id||draft.chatId!==chat)throw Error('CONTACT_RECIPIENT_REFUSED');
    await raw.send(String(draft.chatId),{...draft.body,notify:false});
   }
  }
  return {secret:env.WEBHOOK_SECRET,close,receive(u){const next=tail.then(()=>receive(u));tail=next.catch(()=>{});return next;}};
 }catch(error){try{await close()}catch{}throw mark(error,'CONTACT_STORE')}
}
async function main(options={}){
 const prepared=await prepare(options);
 const server=require('./memory-test-webhook').createWebhook(prepared,prepared.secret);
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3000,'0.0.0.0',resolve)});
  server.once('close',()=>void prepared.close());return server;
 }catch{await prepared.close();throw Error('CONTACT_LISTEN_REFUSED')}
}
module.exports={prepare,main};
