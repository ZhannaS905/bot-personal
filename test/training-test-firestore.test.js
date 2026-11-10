'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {database}=require('./helpers/autopost-firestore');
const {createFirestoreStore,ROOT}=require('../src/training-test-firestore');
const {prepare,pollBody}=require('../src/training-test-autopost');
const {legacyPolls}=require('../training-test-autopost-state.cjs');
const {POLL}=require('../direct-core/src/pilot-policy.cjs');
const uuid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',date='2026-11-02',base={id:uuid,createdAt:100};
test('independent SDK adapter confines every read/write to bot-owned test documents and event receipts',async()=>{
 const db=database(),s=db.store();await s.reserve(date,base);await s.finish(date,uuid,'mid.test');await s.vote(date,{id:'cb',uuid,mid:'mid.test',uid:'1',at:100,action:'yes',name:'Анна'},pollBody);
 assert(db.paths.length>0);assert(db.paths.every(p=>p.startsWith(ROOT+'/123/polls/'+date)));assert(db.paths.some(p=>/\/events\/[a-f0-9]{64}$/.test(p)));
 for(const d of ['fitppTestWorkspaces/synthetic-v1/states/main','2026-02-30','../2026-11-02'])await assert.rejects(s.read(d));
});
test('wrong project/id/auth and disabled write capability fail closed',async()=>{
 const db=database();assert.throws(()=>createFirestoreStore({sdk:db.sdk,raw:{app:{options:{projectId:'fitpp'}}},botId:'123',validateAuth:async()=>{}}));
 for(const id of ['../clients','0','9007199254740992'])assert.throws(()=>db.store({botId:id}));
 const readOnly=db.store({writeEnabled:()=>false});await assert.rejects(readOnly.reserve(date,base),/WRITES_DISABLED/);assert.equal(db.commits.length,0);
 const denied=db.store({validateAuth:async()=>{throw Error('AUTH_LOST')}});await assert.rejects(denied.read(date),/AUTH_LOST/);await assert.rejects(denied.reserve(date,base),/AUTH_LOST/);
});
test('concurrent SDK retries commit only one reservation; no external effects in transaction callback',async()=>{
 const db=database(),a=db.store(),b=db.store();const results=await Promise.all([a.reserve(date,base),b.reserve(date,{...base,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'})]);assert.deepEqual(results.sort(),[false,true]);assert.equal(db.commits.length,1);
});
test('vote receipts conflict on reused ID with different intent; old replay remains harmless',async()=>{
 const db=database(),s=db.store();await s.reserve(date,base);await s.finish(date,uuid,'mid.test');const e={id:'once',uuid,mid:'mid.test',uid:'1',at:100,action:'yes',name:'Анна'};
 assert.equal(await s.vote(date,e,pollBody),true);assert.equal(await s.vote(date,e,pollBody),false);await assert.rejects(s.vote(date,{...e,action:'cancel'},pollBody),/EVENT_CONFLICT/);assert.equal((await s.read(date)).revision,1);
});
test('Firestore document representation uses no nested arrays and rejects corrupt scope',async()=>{
 const db=database(),s=db.store();await s.reserve(date,base);const key=ROOT+'/123/polls/'+date,p=db.data.get(key);assert.deepEqual(p.votes,{});assert.deepEqual(p.last,{});assert.deepEqual(p.order,[]);
 db.data.set(key,{...p,chat:'-1'});await assert.rejects(s.read(date),/DOCUMENT_REFUSED/);await assert.rejects(s.reserve(date,base),/DOCUMENT_REFUSED/);
});
test('legacy import from old pilot chat is refused without writes',async()=>{
 const db=database();
 const legacy={id:uuid,date,status:'published',mid:'mid.test',votes:[[1,'Анна']],last:[[1,100]],done:['old-callback'],dirty:true};
 const input={version:1,autopost:{chat:POLL.chat},polls:{[date]:legacy}};
 assert.throws(()=>legacyPolls(input,'123'),/AUTOPOST_DOCUMENT_REFUSED/);
 assert.equal(db.commits.length,0);
});

test('prepare uses verified existing session factory, server read only, without mkdir/init/network writes',async()=>{
 const db=database(),env={BOT_MODE:'test',CHAT_IDS:'-79450912874680',TEST_BOT_TOKEN:'offline',TEST_EXPECTED_BOT_ID:'123',WEBHOOK_SECRET:'offline_secret_123',AUTO_PUBLISH:'false',TEST_ALLOW_SEND:'false',TEST_ALLOW_EDIT:'false',TEST_ALLOW_DELETE:'false',TRAINING_TEST_AUTOPOST_ENABLED:'true',FIREBASE_PROJECT_ID:'fitpp-test'};
 const calls=[],raw={async request(method,p){assert.equal(method,'GET');return p==='/me'?{user_id:123,username:'id623401053090_1_bot',is_bot:true}:p.endsWith('/members/me')?{user_id:123,is_bot:true}:{chat_id:'-79450912874680',title:'ТАБАТА запись'}}};
 const s=await prepare({env,now:()=>new Date(date),raw,storeFactory:(id,options)=>{calls.push(id);assert(options.writeEnabled());return db.store(options)}});assert.deepEqual(calls,['123']);assert.equal(db.commits.length,0);assert.equal(db.paths.length,1);await s.close();
 db.setFail('read');await assert.rejects(prepare({env,raw,storeFactory:()=>db.store()}),error=>require('../src/fitpp-direct-diagnostic').format(error)==='stage=AUTOPOST_FIRST_READ reason=UNKNOWN');
 assert.equal(await prepare({env:{}}),null);await assert.rejects(prepare({env}),/FIRESTORE_REQUIRED/);
});

test('legacy import is idempotent when Firestore returns object keys in canonical order',async()=>{
 const db=database(),s=db.store(),legacy={id:uuid,date,status:'published',mid:'mid.test',votes:[[1,'Анна']],last:[[1,100]],done:[],dirty:false};
 await s.importLegacy(date,legacy);const key=ROOT+'/123/polls/'+date,p=db.data.get(key);db.data.set(key,Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b))));assert.equal(await s.importLegacy(date,legacy),false);
});
