'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../max-poll-timestamp.cjs');
const { POLL } = require('../direct-core/src/pilot-policy.cjs');
const opened = Date.parse('2026-10-24T12:00:00Z');
const now = () => Date.parse('2026-10-25T12:00:00Z');
const env = { FITPP_DIRECT_ENABLED:'false', FITPP_DIRECT_WRITES_ENABLED:'false', OWNER_DIALOG_ENABLED:'false', BOT_MODE:'test', CHAT_IDS:POLL.chat, TEST_BOT_TOKEN:'private-test-token', TEST_EXPECTED_BOT_ID:'123', WEBHOOK_SECRET:'private-secret-123456' };
function fixture(mutate = () => {}) {
  const message = { timestamp:opened, sender:{user_id:123,is_bot:true}, recipient:{chat_id:POLL.chat,chat_type:'chat'}, body:{mid:POLL.mid,attachments:[{type:'inline_keyboard',payload:{buttons:[['yes','cancel'].map(action=>({type:'callback',payload:`poll:${POLL.uuid}:${action}`}))]}}]} };
  mutate(message);
  const calls = [], output = [];
  const fetch = async (url, options) => {
    calls.push([options.method,url.pathname]);
    assert.equal(options.method,'GET');
    const data = url.pathname === '/me' ? {user_id:123,is_bot:true,username:'id623401053090_1_bot'} : url.pathname.endsWith('/members/me') ? {user_id:123,is_bot:true} : url.pathname.startsWith('/chats/') ? {chat_id:POLL.chat,title:'ТАБАТА запись'} : message;
    return {ok:true,json:async()=>data};
  };
  return {calls,output,fetch};
}
test('reads only four GET endpoints and prints the actual message timestamp', async()=>{
  const f=fixture(); assert.equal(await run(env,f.fetch,now,x=>f.output.push(x)),0);
  assert.deepEqual(f.calls,[['GET','/me'],['GET',`/chats/${POLL.chat}`],['GET',`/chats/${POLL.chat}/members/me`],['GET',`/messages/${POLL.mid}`]]);
  assert.deepEqual(f.output,[`MAX_POLL_TIMESTAMP_OK\nFITPP_DIRECT_POLL_OPENED_AT=${opened}\nOPENED_AT_UTC=2026-10-24T12:00:00.000Z`]);
});
test('flags fail closed before network and never disclose errors',async()=>{
  for(const key of ['FITPP_DIRECT_ENABLED','FITPP_DIRECT_WRITES_ENABLED','OWNER_DIALOG_ENABLED']) for(const value of [undefined,'true','FALSE',false,'']) {
    const f=fixture(); assert.equal(await run({...env,[key]:value},f.fetch,now,x=>f.output.push(x)),1); assert.equal(f.calls.length,0); assert.deepEqual(f.output,['MAX_POLL_TIMESTAMP_READ_REJECTED']);
  }
});
test('rejects invalid timestamps and message scope',async()=>{
  const changes = [
    ...[undefined,0,-1,1.5,String(opened),NaN,Infinity,Number.MAX_SAFE_INTEGER+1,now()+1,POLL.closesAt].map(v=>m=>{m.timestamp=v;}),
    m=>{m.sender.user_id=456;},m=>{m.sender.is_bot=false;},m=>{m.recipient.chat_id='-1';},m=>{m.recipient.chat_type='dialog';},m=>{m.body.mid='mid.other';},
    m=>{m.body.attachments=[];},m=>{m.body.attachments[0].payload.buttons[0][0].payload='poll:foreign:yes';},m=>{m.body.attachments[0].payload.buttons[0].push({type:'callback',payload:`poll:${POLL.uuid}:yes`});}
  ];
  await Promise.all(changes.map(async change=>{const f=fixture(change); assert.equal(await run(env,f.fetch,now,x=>f.output.push(x)),1);assert.deepEqual(f.output,['MAX_POLL_TIMESTAMP_READ_REJECTED']);}));
});
test('HTTP and identity failures have sanitized output',async()=>{
  for(const fetch of [async()=>{throw Error(env.TEST_BOT_TOKEN);},async()=>({ok:false,status:403}),async()=>({ok:true,json:async()=>({user_id:456,is_bot:true,username:'wrong'})})]) {
    const output=[];assert.equal(await run(env,fetch,now,x=>output.push(x)),1);assert.deepEqual(output,['MAX_POLL_TIMESTAMP_READ_REJECTED']);
  }
});
