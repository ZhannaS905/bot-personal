'use strict';
const {createHmac, timingSafeEqual} = require('node:crypto');
const personalConfig=require('./fitpp-personal/runtime-config');
const MAIN='fitppTestWorkspaces/synthetic-v1/states/main';
const LINKS='fitppTestWorkspaces/synthetic-v1/notificationBindings/training-test';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const chat=n=>Number.isSafeInteger(n)&&n!==0;
const client=id=>typeof id==='string'&&/^demo-client-[1-4]$/.test(id);
function phone(value){
 if(typeof value!=='string'||!/^\+?[\d ()-]+$/.test(value))return null;
 let n=value.replace(/[ ()-]/g,'').replace(/^\+/,'');
 if(/^8\d{10}$/.test(n))n='7'+n.slice(1);
 return /^7\d{10}$/.test(n)?n:null;
}
function ownPhone(payload,sender,token){
 if(typeof payload?.vcf_info!=='string'||payload.vcf_info.length>8192||
    typeof payload.hash!=='string'||!/^[a-fA-F0-9]{64}$/.test(payload.hash)||
    payload.max_info?.user_id!==sender)return null;
 // JSON decoding already turns escaped CRLF into actual characters. Never
 // reserialize or normalize the signed vCard before verifying its signature.
 const expected=createHmac('sha256',token).update(payload.vcf_info).digest();
 if(!timingSafeEqual(expected,Buffer.from(payload.hash,'hex')))return null;
 const lines=payload.vcf_info.split(/\r\n|\n/);
 if(lines[0]!=='BEGIN:VCARD'||lines.filter(x=>x==='END:VCARD').length!==1||
    lines.filter(x=>/^BEGIN:VCARD$/.test(x)).length!==1)return null;
 const tels=lines.filter(x=>/^TEL(?:;[^:]*)?:/i.test(x));
 if(tels.length!==1||lines.some(x=>/^[ \t]/.test(x)))return null;
 return phone(tels[0].slice(tels[0].indexOf(':')+1));
}
function matching(state,number,validClientId,personal){
 if(!Array.isArray(state?.clients)||state.clients.some(c=>(personal?!validClientId(String(c?.id??'')):typeof c?.id!=='string'||!c.id))||
    new Set(state.clients.map(c=>String(c.id))).size!==state.clients.length)throw Error('SYNTHETIC_CLIENTS_REQUIRED');
 if(number===null)return null; // Startup checks structure without inspecting phones.
 const matches=state.clients.filter(c=>phone(c.phone)===number);
 return matches.length===1&&validClientId(String(matches[0].id))&&!matches[0].archivedAt?String(matches[0].id):null;
}
function validateRegistry(value,botId,validClientId=client){
 if(value===undefined)return {version:1,botId,bindings:[]};
 if(value?.version!==1||value.botId!==botId||!Array.isArray(value.bindings))throw Error('BINDING_STATE_REFUSED');
 const users=new Set(),clients=new Set(),chats=new Set();
 for(const b of value.bindings){
  if(!validClientId(b.clientId)||!positive(b.maxUserId)||!chat(b.maxChatId)||typeof b.notificationsEnabled!=='boolean'||
     users.has(b.maxUserId)||clients.has(b.clientId)||chats.has(b.maxChatId))throw Error('BINDING_STATE_REFUSED');
  users.add(b.maxUserId);clients.add(b.clientId);chats.add(b.maxChatId);
 }
 return value;
}
// No SDK initialization, credentials lookup or network on import. Transactions
// use the two fixed test paths only. The caller supplies an authenticated SDK.
function firebaseStore({sdk,db,botId}){
 const project=db?.app?.options?.projectId;
 const personal=project===personalConfig.projectId;
 if((!personal&&project!=='fitpp-test')||!positive(botId))throw Error('TEST_SCOPE_REQUIRED');
 const validClientId=personal?personalConfig.validClientId:client;
 const main=sdk.doc(db,personal?personalConfig.main:MAIN);
 const links=sdk.doc(db,personal?personalConfig.bindings:LINKS);
 async function operate(number,binding){
  try{return await sdk.runTransaction(db,async tx=>{
   const state=await tx.get(main),stored=await tx.get(links);
   if(!state.exists())throw Error('TEST_STATE_MISSING');
   if(personal)require('./fitpp-personal/calendar').assertWorkspace(state.data());
   const clientId=matching(state.data(),number,validClientId,personal);
   const registry=validateRegistry(stored.exists()?stored.data():undefined,botId,validClientId);
   if(!binding)return clientId;
   if(clientId!==binding.clientId)return {status:'refused'};
   const existing=registry.bindings.filter(b=>b.clientId===clientId||b.maxUserId===binding.maxUserId||b.maxChatId===binding.maxChatId);
   if(existing.length){
    const b=existing[0];
    if(existing.length!==1||b.clientId!==clientId||b.maxUserId!==binding.maxUserId||b.maxChatId!==binding.maxChatId)return {status:'conflict'};
    if(b.notificationsEnabled!==true||b.recoverNotifications!==true){
     const next=validateRegistry({...registry,bindings:registry.bindings.map(row=>row===b?{...row,notificationsEnabled:true,recoverNotifications:true}:row)},botId,validClientId);
     tx.set(links,next);
    }
    return {status:'already_linked'};
   }
   const next=validateRegistry({...registry,bindings:[...registry.bindings,{...binding,notificationsEnabled:true,recoverNotifications:true}]},botId,validClientId);
   tx.set(links,next);
   return {status:'linked'};
  });}catch(error){
   const safe=require('./fitpp-direct-diagnostic').mark(error,'CONTACT_STORAGE');
   safe.message='CONTACT_LINK_STORAGE_REFUSED';throw safe;
  }
 }
 return {inspect:async()=>{await operate(null);},find:number=>operate(number),bind:(number,binding)=>operate(number,binding)};
}
function contactLinking({botId,token,allowedUserIds=[],store,now=Date.now,personal=false}){
 if(!positive(botId)||typeof token!=='string'||!token||!Array.isArray(allowedUserIds)||
    !allowedUserIds.every(positive)||!store)throw Error('TEST_LINK_CONFIG_REFUSED');
 const allowed=new Set(allowedUserIds),sessions=new Map();
 const draft=(userId,chatId,text,buttons=[])=>({state:'blocked',sendAllowed:false,userId,chatId,
  body:{text,attachments:buttons.length?[{type:'inline_keyboard',payload:{buttons}}]:[]}});
 const fresh=t=>Number.isSafeInteger(t)&&t<=now()+30000&&t>=now()-300000;
 // Call only behind the authenticated MAX webhook and verified Training Test identity.
 let tail=Promise.resolve();
 async function receive(u){
  if(!fresh(u?.timestamp))return;
  const m=u.message,r=m?.recipient;
  const user=u.update_type==='bot_started'?u.user:u.update_type==='message_callback'?u.callback?.user:m?.sender;
  const chatId=u.update_type==='bot_started'?u.chat_id:r?.chat_id;
  if(!positive(user?.user_id)||(allowed.size&&!allowed.has(user.user_id))||user.is_bot!==false||!chat(chatId))return;
  if(u.update_type!=='bot_started'&&(!['message_created','message_callback'].includes(u.update_type)||r?.chat_type!=='dialog'||
     (u.update_type==='message_callback'?
      r.user_id!==user.user_id||m.sender?.user_id!==botId||m.sender?.is_bot!==true:
      r.user_id!==botId)||m.link!=null||!fresh(m.timestamp)))return;
  const uid=user.user_id;
  if(u.update_type==='bot_started'||m.body?.text==='/start'){
   const old=sessions.get(uid);if(old&&u.timestamp<old.at)return;
   sessions.set(uid,{chatId,at:u.timestamp,expires:now()+300000});
   return draft(uid,chatId,personal?'Здравствуйте! Поделитесь своим номером, чтобы связать MAX с вашим клиентским профилем в FitPP Personal.':'Здравствуйте! Это Training Test. Поделитесь своим номером для поиска тестового клиента FitPP. После подтверждения будут включены уведомления об абонементе и посещениях, включая пропущенные.',
    [[{type:'request_contact',text:'📱 Поделиться номером телефона'}]]);
  }
  const s=sessions.get(uid);
  if(!s||s.chatId!==chatId||now()>=s.expires||u.timestamp<s.at||m.timestamp<s.at)return;
  if(u.update_type==='message_callback'&&!fresh(u.callback?.timestamp))return;
  if(u.update_type!=='message_created')return;
  const attachments=m.body?.attachments;
  const number=Array.isArray(attachments)&&attachments.length===1&&attachments[0].type==='contact'
   ?ownPhone(attachments[0].payload,uid,token):null;
  if(!number)return draft(uid,chatId,'Не удалось подтвердить ваш контакт. Используйте кнопку «📱 Поделиться номером телефона».');
  const clientId=await store.find(number);
  if(!clientId)return draft(uid,chatId,personal?'Не удалось однозначно найти клиента FitPP Personal. Обратитесь к администратору.':'Не удалось однозначно найти тестового клиента. Обратитесь к администратору теста.');
  const result=await store.bind(number,{clientId,maxUserId:uid,maxChatId:chatId});
  sessions.delete(uid);
  return draft(uid,chatId,['linked','already_linked'].includes(result.status)?
   (personal?'Привязка сохранена. Ответы в опросах тренировок будут обновлять запись в FitPP Personal.':'Привязка сохранена. Уведомления об абонементе и посещениях включены; пропущенные будут проверены и отправлены.'):
   'Привязка не выполнена. Обратитесь к администратору теста.');
 }
 return {receive(u){const next=tail.then(()=>receive(u));tail=next.catch(()=>{});return next;}};
}
// Standalone composition for callers that supply a raw authenticated Firebase SDK.
// identity must be a freshly verified /me result from the SAME test token.
function prepareTestContactLinking({identity,expectedBotId,token,allowedUserIds,sdk,db,now}){
 const {checkTestBotIdentity,identityAccepted}=require('./test-bot-identity');
 if(!identityAccepted(checkTestBotIdentity(identity,expectedBotId)))throw Error('TEST_IDENTITY_REFUSED');
 return contactLinking({botId:identity.user_id,token,allowedUserIds,now,
  store:firebaseStore({sdk,db,botId:identity.user_id})});
}
module.exports={prepareTestContactLinking,phone,ownPhone,firebaseStore,contactLinking,MAIN,LINKS,validateRegistry};
