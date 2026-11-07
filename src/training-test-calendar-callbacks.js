'use strict';
// Standalone callback handler for calendar-scoped Training Test polls.
// Never routes the historical poll:<uuid>:yes/cancel payloads.
const {CHAT}=require('./training-test-firestore');
const {workoutKey}=require('./fitpp-calendar-poll-plan');
const PAYLOAD=/^cal:([a-f0-9]{64}):([a-f0-9-]{36}):(yes|cancel)$/;
function payload(p,action){
 if(!['yes','cancel'].includes(action))throw Error('CALENDAR_ACTION_REFUSED');
 return 'cal:'+p.key+':'+p.id+':'+action;
}
function createCalendarCallbacks({store,calendar,now=Date.now,render}){
 if(!store||!calendar||typeof calendar.day!=='function'||typeof render!=='function')throw Error('CALENDAR_CALLBACK_CONFIG');
 return {async receive(u){
  if(u?.update_type!=='message_callback')return false;
  const match=PAYLOAD.exec(u.callback?.payload||'');
  if(!match)return false;
  const [,key,uuid,action]=match,cb=u.callback,m=u.message;
  if(m?.recipient?.chat_type!=='channel'||String(m.recipient.chat_id)!==CHAT||cb?.user?.is_bot!==false||
   !Number.isSafeInteger(cb.user.user_id)||cb.user.user_id<=0||typeof cb.callback_id!=='string'||!cb.callback_id||
   cb.callback_id.length>256)throw Error('CALENDAR_CALLBACK_SCOPE_REFUSED');
  const at=cb.timestamp??u.timestamp;
  if(!Number.isSafeInteger(at)||Math.abs(now()-at)>86400000||at>now()+30000||
   (cb.timestamp!==undefined&&u.timestamp!==undefined&&cb.timestamp!==u.timestamp))throw Error('CALENDAR_CALLBACK_TIME_REFUSED');
  const p=await store.read(key);
  if(p?.status!=='published'||p.id!==uuid||p.mid!==m.body?.mid||workoutKey(p.workout)!==key)throw Error('CALENDAR_CALLBACK_POLL_REFUSED');
  const sessions=await calendar.day(p.workout.date);
  const active=sessions.find(w=>w.id===p.workout.id&&w.date===p.workout.date&&w.time===p.workout.time&&w.location===p.workout.location);
  if(!active)throw Error('CALENDAR_CALLBACK_WORKOUT_CHANGED');
  const closes=Date.parse(p.workout.date+'T'+p.workout.time+':00+03:00')+3600000;
  if(now()>=closes||at<p.createdAt||at>=closes)throw Error('CALENDAR_CALLBACK_CLOSED');
  const name=[cb.user.first_name,cb.user.last_name].filter(x=>typeof x==='string').join(' ').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100)||'Участник '+cb.user.user_id;
  const applied=await store.vote(key,{id:cb.callback_id,uuid,mid:p.mid,uid:String(cb.user.user_id),at,action,name},render);
  return {handled:true,applied,workoutId:p.workout.id,action};
 }};
}
module.exports={payload,createCalendarCallbacks,PAYLOAD};
