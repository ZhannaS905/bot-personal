'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../tools/inspect-training-test-today.cjs'),'utf8');
const {POLL}=require('../direct-core/src/pilot-policy.cjs');
const identity=require('../src/test-bot-identity');
function fixture({patchMessage=m=>m,patchMe=m=>m,full=false,missing=false,ledger=false}={}){
 const calls=[],logs=[],me=patchMe({user_id:123,username:'id623401053090_1_bot',is_bot:true});
 const message=patchMessage({sender:me,recipient:{chat_id:POLL.chat,chat_type:'chat'},body:{mid:POLL.mid,text:'понедельник, 26 октября Заря 20:00 Записано (1): PRIVATE_PARTICIPANT',attachments:[{type:'inline_keyboard',payload:{buttons:[['yes','cancel'].map(a=>({type:'callback',payload:`poll:${POLL.uuid}:${a}`}))]}}]}});
 const context={module:{exports:{}},process:{},console};
 context.require=id=>{
  if(id==='node:path'||id==='node:crypto')return require(id);
  if(id==='node:fs')return {existsSync:()=>ledger,lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1}),readFileSync:()=>Buffer.from(JSON.stringify({autopost:{chat:POLL.chat},polls:{[POLL.date]:{status:'external',mid:POLL.mid}}}))};
  if(id.endsWith('pilot-policy.cjs'))return {POLL};
  if(id.endsWith('memory-training-test.js'))return {config:()=>({token:'PRIVATE_TOKEN',expectedId:'123'})};
  if(id.endsWith('test-bot-identity.js'))return identity;
  if(id.endsWith('api.js'))return {MaxApi:class{async request(method,endpoint){calls.push([method,endpoint]);assert.equal(method,'GET');if(endpoint==='/me')return me;if(endpoint.endsWith('/members/me'))return {user_id:123,is_bot:true};if(endpoint.startsWith('/chats/'))return {chat_id:POLL.chat,title:'ТАБАТА запись'};if(endpoint==='/messages')return {messages:full?Array(100).fill(message):[message]};if(missing)throw Error('MAX HTTP 404');return message}}};
  throw Error('Unexpected import '+id);
 };
 vm.runInNewContext(source,context);return {calls,logs,inspect:()=>context.module.exports.inspect({root:'/offline',env:ledger?{TRAINING_TEST_AUTOPOST_STATE_DIR:'/offline/ledger'}:{},log:x=>logs.push(x)})};
}
test('read-only inspector verifies exact message/history using GET only and redacts names/tokens',async()=>{
 const f=fixture(),r=await f.inspect();assert.equal(r.matchingPolls,1);assert.equal(r.mid,POLL.mid);assert(Object.values(r.checks).every(Boolean));assert.equal(f.calls.length,5);assert.doesNotMatch(f.logs.join(''),/PRIVATE_PARTICIPANT|PRIVATE_TOKEN/);assert.equal(r.ledger.reason,'state_dir_not_configured');
});
test('wrong test identity and foreign message cannot pass inspection',async()=>{
 for(const opts of [{patchMe:m=>({...m,username:'production_bot'})},{patchMessage:m=>({...m,recipient:{chat_id:'-1',chat_type:'chat'}})},{patchMessage:m=>({...m,body:{...m.body,mid:'mid.foreign'}})}]){const f=fixture(opts);await assert.rejects(f.inspect());assert.equal(f.logs.length,0)}
});
test('missing message is a blocker, never treated as deletion evidence',async()=>{const f=fixture({missing:true});await assert.rejects(f.inspect(),/404/);assert.equal(f.logs.length,0)});
test('incomplete 100-message history fails closed',async()=>{const f=fixture({full:true});await assert.rejects(f.inspect(),/COMPLETE_HISTORY/);assert.equal(f.logs.length,0)});
test('configured ledger is only read, with mid/status/hash and without participants',async()=>{const f=fixture({ledger:true}),r=await f.inspect();assert.equal(r.ledger.midMatches,true);assert.equal(r.ledger.status,'external');assert.match(r.ledger.sha256,/^[a-f0-9]{64}$/)});
