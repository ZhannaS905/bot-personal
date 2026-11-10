'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const {prepare}=require('../src/contact-linking-runtime');
const {OWNER_UID}=require('../src/fitpp-direct-session');
const {MAIN,LINKS}=require('../src/contact-linking');
const {createHmac}=require('node:crypto');
function fixture(t){
 const env={BOT_MODE:'test',CHAT_IDS:'-79450912874680',TEST_ADMIN_IDS:'5819064',CONTACT_LINK_ENABLED:'true',CONTACT_LINK_REPLY_ENABLED:'true',CONTACT_LINK_WRITES_ENABLED:'true',FITPP_DIRECT_ENABLED:'false',FITPP_DIRECT_WRITES_ENABLED:'false',OWNER_DIALOG_ENABLED:'false',FIREBASE_PROJECT_ID:'fitpp-test',FIREBASE_API_KEY:'fake',FIREBASE_BOT_UID:OWNER_UID,FIREBASE_BOT_EMAIL:'test@example.invalid',FIREBASE_BOT_PASSWORD:'fake',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',TEST_EXPECTED_BOT_ID:'90',TEST_BOT_TOKEN:'fake-token',WEBHOOK_SECRET:'a'.repeat(32)};
 let registry,writes=0;const requests=[],paths=[];
 const user={uid:OWNER_UID,getIdTokenResult:async()=>({claims:{aud:'fitpp-test',iss:'https://securetoken.google.com/fitpp-test',sub:OWNER_UID}})},auth={currentUser:user};
 const sdk={initializeApp:options=>({options}),initializeAuth:()=>auth,signInWithEmailAndPassword:async()=>({user}),getFirestore:app=>({app}),signOut:async()=>{},terminate:async()=>{},deleteApp:async()=>{},doc:(_,p)=>({path:p}),runTransaction:async(_,fn)=>fn({get:async ref=>{paths.push(ref.path);return {exists:()=>ref.path===MAIN||registry!==undefined,data:()=>ref.path===MAIN?{clients:[{id:'demo-client-1',phone:'79990000000'}]}:registry}},set:(ref,value)=>{a.equal(ref.path,LINKS);registry=value;writes++}})};
 const fetchImpl=async(url,options)=>{requests.push({url:String(url),options});return {ok:true,json:async()=>options.method==='GET'?{user_id:90,is_bot:true,username:'id623401053090_1_bot'}:{message:{body:{mid:'mid.fake'}}}}};
 const start={update_type:'bot_started',timestamp:1000000,chat_id:70,user:{user_id:5819064,is_bot:false}};
 return {env,sdk,fetchImpl,requests,paths,auth,start,now:()=>1000000,get registry(){return registry},get writes(){return writes}};
}
test('unsafe configuration fails before network; owner file is unnecessary',async t=>{
 const f=fixture(t);
 for(const change of [{TEST_ADMIN_IDS:'invalid'},{TEST_ALLOW_SEND:'true'},{FIREBASE_PROJECT_ID:'fitpp-crm'}])await a.rejects(prepare({...f,env:{...f.env,...change}}));
 a.equal(f.requests.length,0);
 const prepared=await prepare({...f,env:{...f.env,CONTACT_LINK_OWNER_FILE:'/missing',TEST_BOT_TOKEN:undefined,BOT_TOKEN:'fake-token',FITPP_DIRECT_ENABLED:'true',FITPP_DIRECT_WRITES_ENABLED:'true'}});await prepared.close();
});
test('runtime reads both test documents, replies to ordinary participants, suppresses duplicate events',async t=>{
 const f=fixture(t),s=await prepare(f);t.after(()=>s.close());
 a.deepEqual(f.paths,[MAIN,LINKS]);a.equal(f.writes,0);
 await s.receive({...f.start,user:{user_id:81,is_bot:false}});
 a.equal(f.requests.length,2);
 await Promise.all([s.receive(f.start),s.receive(f.start)]);
 a.equal(f.requests.length,3);a.equal(new URL(f.requests[2].url).searchParams.get('chat_id'),'70');
 a.equal(JSON.parse(f.requests[1].options.body).notify,false);
});
test('authenticated Firebase session commits contact registry, never main; identity loss blocks',async t=>{
 const f=fixture(t),s=await prepare(f);t.after(()=>s.close());await s.receive(f.start);
 const vcf_info='BEGIN:VCARD\r\nTEL:79990000000\r\nEND:VCARD\r\n';
 await s.receive({update_type:'message_created',timestamp:1000000,message:{timestamp:1000000,sender:{user_id:5819064,is_bot:false},recipient:{chat_type:'dialog',chat_id:70,user_id:90},body:{mid:'contact.1',attachments:[{type:'contact',payload:{vcf_info,max_info:{user_id:5819064},hash:createHmac('sha256','fake-token').update(vcf_info).digest('hex')}}]}}});
 a.equal(f.writes,1);a.equal(f.registry.bindings[0].notificationsEnabled,true);
 a.equal(JSON.stringify(f.registry).includes('79990000000'),false);
 a.equal(JSON.parse(f.requests[2].options.body).attachments.length,0);
 f.auth.currentUser=null;await s.receive({...f.start,timestamp:1000001});
 // Authentication is rechecked inside every transaction, including after restart.
 const {connect}=require('../src/fitpp-direct-session');
 await a.rejects(connect({env:{...f.env,FITPP_DIRECT_ENABLED:'true'},sdk:f.sdk}));
});
test('disabled dedicated replies leave global flags false and do not send',async t=>{
 const f=fixture(t),s=await prepare({...f,env:{...f.env,CONTACT_LINK_REPLY_ENABLED:'false',CONTACT_LINK_WRITES_ENABLED:'false'}});t.after(()=>s.close());
 await s.receive(f.start);a.equal(f.requests.length,1);a.equal(f.writes,0);a.equal(f.env.TEST_ALLOW_SEND,'false');
});
test('contact capability checks auth and separate write permission without widening booking paths',async t=>{
 const f=fixture(t),{connect}=require('../src/fitpp-direct-session');
 const session=await connect({env:{...f.env,FITPP_DIRECT_ENABLED:'true'},sdk:f.sdk});t.after(()=>session.close());
 a.throws(()=>session.db.doc(LINKS),/PATH_REJECTED/);
 const binding={clientId:'demo-client-1',maxUserId:5819064,maxChatId:70};
 await a.rejects(session.contactStore(90).bind('79990000000',binding),/STORAGE_REFUSED/);a.equal(f.writes,0);
 f.auth.currentUser=null;
 await a.rejects(session.contactStore(90,{writeEnabled:()=>true}).bind('79990000000',binding),/STORAGE_REFUSED/);a.equal(f.writes,0);
});
test('combined runtime reuses Firebase capability and leaves shared session lifetime to caller',async t=>{
 const f=fixture(t);let inspected=0,closed=0;
 const session={contactStore:()=>({inspect:async()=>{inspected++}}),close:async()=>{closed++}};
 const s=await prepare({...f,sdk:undefined,session});
 a.equal(inspected,1);a.equal(f.requests.length,1);
 await s.close();a.equal(closed,0);
});

test('ordinary non-admin activates, repeats without writes, and cannot claim another contact or binding',async t=>{
 const f=fixture(t),s=await prepare({...f,env:{...f.env,TEST_ADMIN_IDS:''}});t.after(()=>s.close());
 const start=(uid,cid)=>({...f.start,chat_id:cid,user:{user_id:uid,is_bot:false}});
 const contact=(uid,cid,owner=uid)=>{
  const vcf_info='BEGIN:VCARD\r\nTEL:79990000000\r\nEND:VCARD\r\n';
  return {update_type:'message_created',timestamp:1000001,message:{timestamp:1000001,sender:{user_id:uid,is_bot:false},recipient:{chat_type:'dialog',chat_id:cid,user_id:90},body:{mid:`contact.${uid}.${f.requests.length}`,attachments:[{type:'contact',payload:{vcf_info,max_info:{user_id:owner},hash:createHmac('sha256','fake-token').update(vcf_info).digest('hex')}}]}}};
 };
 await s.receive(start(81,71));await s.receive(contact(81,71));
 a.equal(f.writes,1);a.equal(f.registry.bindings[0].maxUserId,81);
 await s.receive({...start(81,71),timestamp:1000001});await s.receive(contact(81,71));a.equal(f.writes,1);
 await s.receive(start(82,72));await s.receive(contact(82,72,81));a.equal(f.writes,1);
 await s.receive(contact(82,72));a.equal(f.writes,1);a.equal(f.registry.bindings[0].maxUserId,81);
});

test('contact preflight preserves safe storage diagnosis through startup wrappers and cleanup errors',async()=>{
 const {at,format}=require('../src/fitpp-direct-diagnostic');
 for(const reason of ['permission-denied','unavailable','BINDING_STATE_REFUSED','TEST_STATE_MISSING']){
  const f=fixture(),error=new Error(reason);
  if(['permission-denied','unavailable'].includes(reason))error.code=reason;
  f.sdk.runTransaction=async()=>{throw error};
  try{await at('RUNTIME_PREPARE',()=>prepare(f));a.fail('must reject')}
  catch(e){a.equal(format(e),`stage=CONTACT_STORAGE reason=${reason}`);a.equal(e.message,'CONTACT_LINK_STORAGE_REFUSED')}
 }
 const f=fixture(),session={contactStore:()=>({inspect:async()=>{throw Object.assign(new Error('private phone and token'),{code:'permission-denied'})}})};
 await a.rejects(at('RUNTIME_PREPARE',()=>prepare({...f,session})),e=>format(e)==='stage=CONTACT_STORE reason=permission-denied');
});
