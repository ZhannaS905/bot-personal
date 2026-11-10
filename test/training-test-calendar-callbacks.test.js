'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {payload,createCalendarCallbacks}=require('../src/training-test-calendar-callbacks');
const {workoutKey}=require('../src/fitpp-calendar-poll-plan');
const workout={id:'session-123',date:'2026-11-02',location:'zarya',time:'20:00'};
const key=workoutKey(workout),uuid='12345678-1234-1234-1234-123456789012',mid='mid.abc123';
const timestamp=Date.parse('2026-11-02T17:00:00Z')-1000;
function event(action='yes'){return {update_type:'message_callback',timestamp,callback:{
 payload:'cal:'+key+':'+uuid+':'+action,callback_id:'evt-1',timestamp,
 user:{user_id:12,is_bot:false,first_name:'Test'}
 },message:{recipient:{chat_type:'channel',chat_id:'-79450912874680'},body:{mid}}};}
const poll={id:uuid,key,mid,status:'published',createdAt:timestamp-10000,workout};
test('calendar callback applies vote to exact workout and scope',async()=>{
 const calls=[];
 const handler=createCalendarCallbacks({store:{read:async()=>poll,vote:async(...args)=>{calls.push(args);return true}},
 calendar:{day:async()=>[workout]},now:()=>timestamp,render:()=>({text:'OK'})});
 const result=await handler.receive(event());
 assert.deepEqual(result,{handled:true,applied:true,workoutId:workout.id,action:'yes'});
 assert.equal(calls[0][0],key);
 assert.equal(payload(poll,'cancel'),'cal:'+key+':'+uuid+':cancel');
});
test('refuses changed or cancelled workout and mismatched message',async()=>{
 const handler=createCalendarCallbacks({store:{read:async()=>poll,vote:async()=>{throw Error('MUST_NOT_VOTE')}},
 calendar:{day:async()=>[]},now:()=>timestamp,render:()=>({text:'OK'})});
 await assert.rejects(()=>handler.receive(event()),/CALENDAR_CALLBACK_WORKOUT_CHANGED/);
 const altered=event();altered.message.body.mid='mid.wrong';
 await assert.rejects(()=>handler.receive(altered),/CALENDAR_CALLBACK_POLL_REFUSED/);
});
test('legacy poll payload is not intercepted',async()=>{
 const handler=createCalendarCallbacks({store:{},calendar:{day:async()=>[]},now:()=>timestamp,render:()=>({text:'OK'})});
 const u=event();u.callback.payload='poll:'+uuid+':yes';
 assert.equal(await handler.receive(u),false);
});
