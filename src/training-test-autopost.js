'use strict';
// Dedicated capability; general MAX write flags and Firebase adapters stay unchanged.
const {randomUUID}=require('node:crypto');
const {at,mark,format}=require('./fitpp-direct-diagnostic');
const {MaxApi}=require('./api');
const {CHAT,config,body}=require('./memory-training-test');
const {checkTestBotIdentity,identityAccepted}=require('./test-bot-identity');
const {moscow,times}=require('./schedule');
const {POLL}=require('../direct-core/src/pilot-policy.cjs');
const MID=/^mid\.[a-zA-Z0-9]+$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function settings(env){
 if(env.TRAINING_TEST_AUTOPOST_ENABLED===undefined||env.TRAINING_TEST_AUTOPOST_ENABLED==='false')return null;
 if(env.TRAINING_TEST_AUTOPOST_ENABLED!=='true')throw Error('AUTOPOST_FLAG_REFUSED');
 const c=config(env);
 if(env.FIREBASE_PROJECT_ID!=='fitpp-test')throw Error('AUTOPOST_TEST_PROJECT_REQUIRED');
 if(env.TRAINING_TEST_AUTOPOST_STORAGE&&env.TRAINING_TEST_AUTOPOST_STORAGE!=='firestore')throw Error('AUTOPOST_STORAGE_REFUSED');
 if(['AUTO_PUBLISH','TEST_ALLOW_SEND','TEST_ALLOW_EDIT','TEST_ALLOW_DELETE'].some(k=>env[k]!=='false'))throw Error('AUTOPOST_GENERAL_WRITES_REFUSED');
 return c;
}
function training(date){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
 const d=new Date(date+'T12:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===date&&!!times[d.getUTCDay()];
}
function closesAt(date){const day=new Date(date+'T12:00:00Z').getUTCDay();return Date.parse(date+'T'+times[day]+':00+03:00')+60*60000}
async function capability(c,{raw=new MaxApi(c.token)}={}){
 async function verify(){
  if(!identityAccepted(checkTestBotIdentity(await raw.request('GET','/me'),c.expectedId)))throw Error('AUTOPOST_IDENTITY_REFUSED');
  const chat=await raw.request('GET',`/chats/${CHAT}`);
  if(String(chat.chat_id)!==CHAT||chat.title!=='Тест тренировок')throw Error('AUTOPOST_CHAT_REFUSED');
  const member=await raw.request('GET',`/chats/${CHAT}/members/me`);
  if(member.user_id!==Number(c.expectedId)||member.is_bot!==true)throw Error('AUTOPOST_MEMBERSHIP_REFUSED');
 }
 await verify();
 return {verify,
 async deleteCalendarPoll(p) {
  if (p?.status !== 'deletePending' ||
      !MID.test(p.mid) ||
      !UUID.test(p.id) ||
      !/^[a-f0-9]{64}$/.test(p.key) ||
      p.chat !== CHAT ||
      p.botId !== String(c.expectedId)) {
    throw Error('CALENDAR_DELETE_REFUSED');
  }

  await verify();

  const existing = await raw.request(
    'GET', '/messages/' + encodeURIComponent(p.mid)
  );

  if (existing?.body?.mid !== p.mid ||
      String(existing?.recipient?.chat_id) !== CHAT ||
      String(existing?.sender?.user_id) !== String(c.expectedId) ||
      existing?.sender?.is_bot !== true) {
    throw Error('CALENDAR_DELETE_SCOPE_REFUSED');
  }

  await raw.request('DELETE', '/messages', {message_id:p.mid});
 },

 async deleteAdminCommand(m, admins) {
  if (m?.body?.text !== '/опрос' ||
      !MID.test(m.body?.mid) ||
      String(m.recipient?.chat_id) !== CHAT ||
      m.recipient?.chat_type !== 'chat' ||
      m.sender?.is_bot !== false ||
      !Number.isSafeInteger(m.sender?.user_id) ||
      !Array.isArray(admins) ||
      !admins.includes(String(m.sender.user_id))) {
    throw Error('COMMAND_DELETE_REFUSED');
  }
  await verify();
  const existing = await raw.request(
    'GET', '/messages/' + encodeURIComponent(m.body.mid)
  );
  if (existing?.body?.mid !== m.body.mid ||
      existing?.body?.text !== '/опрос' ||
      String(existing?.recipient?.chat_id) !== CHAT ||
      existing?.sender?.user_id !== m.sender.user_id ||
      existing?.sender?.is_bot !== false) {
    throw Error('COMMAND_DELETE_SCOPE_REFUSED');
  }
  await raw.request('DELETE', '/messages', {message_id:m.body.mid});
 },
 async answer(id){if(typeof id!=='string'||!id.trim()||id.length>256)throw Error('CALLBACK_ID_REQUIRED');return raw.request('POST','/answers',{callback_id:id},{})},async editCalendar(p, {beforePut=async()=>{}}={}) {
  if (p?.status !== 'published' ||
      p.cancelled === true ||
      !MID.test(p.mid) ||
      !/^[a-f0-9]{64}$/.test(p.key) ||
      !UUID.test(p.id)) {
    throw Error('CALENDAR_EDIT_REFUSED');
  }

  await verify();

  const existing = await raw.request(
    'GET', '/messages/' + encodeURIComponent(p.mid)
  );

  const attachments = existing?.body?.attachments || [];
  const keyboards = attachments.filter(a => a.type === 'inline_keyboard');
  const buttons = keyboards.flatMap(a =>
    (a.payload?.buttons || []).flat()
  );

  const expectedButtons =
    attachments.length === 1 &&
    keyboards.length === 1 &&
    buttons.length === 2 &&
    ['yes', 'cancel'].every(action =>
      buttons.filter(b =>
        b.type === 'callback' &&
        b.payload === `cal:${p.key}:${p.id}:${action}`
      ).length === 1
    );

  const restoring =
    attachments.length === 0 &&
    typeof existing?.body?.text === 'string' &&
    existing.body.text.includes('Тренировка отменена') &&
    existing.body.text.includes('🔐 Опрос: ' + p.id);

  if (existing?.body?.mid !== p.mid ||
      String(existing?.recipient?.chat_id) !== CHAT ||
      existing?.sender?.user_id !== Number(c.expectedId) ||
      existing?.sender?.is_bot !== true ||
      (!expectedButtons && !restoring)) {
    throw Error('CALENDAR_EDIT_SCOPE_REFUSED');
  }

  const {calendarPollBody} = require('./training-test-calendar-body');
  const message = calendarPollBody(p);

  await beforePut();

  await raw.edit(p.mid, {
    text: message.text,
    format: message.format,
    ...(restoring ? {attachments: message.attachments} : {}),
    notify: false
  });
},
async cancelCalendar(p, {beforePut=async()=>{}}={}) {
  if (p?.status !== 'published' ||
      p.cancelled !== true ||
      !MID.test(p.mid) ||
      !/^[a-f0-9]{64}$/.test(p.key) ||
      !UUID.test(p.id)) {
    throw Error('CALENDAR_CANCEL_REFUSED');
  }

  await verify();

  const existing = await raw.request(
    'GET', '/messages/' + encodeURIComponent(p.mid)
  );

  if (existing?.body?.mid !== p.mid ||
      String(existing?.recipient?.chat_id) !== CHAT ||
      existing?.sender?.user_id !== Number(c.expectedId) ||
      existing?.sender?.is_bot !== true) {
    throw Error('CALENDAR_CANCEL_SCOPE_REFUSED');
  }

  const attachments = existing?.body?.attachments || [];
  const keyboards = attachments.filter(a => a.type === 'inline_keyboard');
  const buttons = keyboards.flatMap(a =>
    (a.payload?.buttons || []).flat()
  );

  const expectedButtons =
    keyboards.length === 1 &&
    buttons.length === 2 &&
    ['yes', 'cancel'].every(action =>
      buttons.filter(b =>
        b.type === 'callback' &&
        b.payload === `cal:${p.key}:${p.id}:${action}`
      ).length === 1
    );

  const alreadyCancelled =
    attachments.length === 0 &&
    existing?.body?.text?.includes('Тренировка отменена') &&
    existing.body.text.includes('🔐 Опрос: ' + p.id);

  if (!expectedButtons && !alreadyCancelled) {
    throw Error('CALENDAR_CANCEL_BUTTONS_REFUSED');
  }

  const {calendarPollBody} = require('./training-test-calendar-body');
  const message = calendarPollBody(p);

  await beforePut();

  await raw.edit(p.mid, {
    text: message.text,
    format: message.format,
    attachments: [],
    notify: false
  });
},
async sendCalendar(p, message){
    if (!p?.key || !p?.id || !p?.workout) {
      throw Error('CALENDAR_SEND_REFUSED');
    }
    if (!message?.text || message.format !== 'html' ||
        !Array.isArray(message.attachments)) {
      throw Error('CALENDAR_MESSAGE_REFUSED');
    }
    const buttons = message.attachments
      .filter(a => a.type === 'inline_keyboard')
      .flatMap(a => (a.payload?.buttons || []).flat());
    if (buttons.length !== 2 ||
        !['yes', 'cancel'].every(action =>
          buttons.some(b =>
            b.type === 'callback' &&
            b.payload === `cal:${p.key}:${p.id}:${action}`
          ))) {
      throw Error('CALENDAR_BUTTONS_REFUSED');
    }
    await verify();
    return raw.send(CHAT, message, {
      disableLinkPreview: p.workout.location === 'online'
    });
  },
  async send(p){
  await verify();return raw.send(CHAT,pollBody(p),{disableLinkPreview:[0,6].includes(new Date(p.date+'T12:00:00Z').getUTCDay())});
 },async edit(p,{beforePut=async()=>{}}={}){
  if(p.status!=='published'||!MID.test(p.mid))throw Error('AUTOPOST_EDIT_REFUSED');
  await verify();const m=await raw.request('GET','/messages/'+encodeURIComponent(p.mid));
  const keyboards=(m?.body?.attachments||[]).filter(a=>a.type==='inline_keyboard'),buttons=keyboards.flatMap(a=>(a.payload?.buttons||[]).flat());
  if(m?.body?.mid!==p.mid||String(m?.recipient?.chat_id)!==CHAT||m?.sender?.user_id!==Number(c.expectedId)||m?.sender?.is_bot!==true||keyboards.length!==1||buttons.length!==2||!['yes','cancel'].every(action=>buttons.filter(b=>b.type==='callback'&&b.payload===`poll:${p.id}:${action}`).length===1))throw Error('AUTOPOST_EDIT_SCOPE_REFUSED');
  const b=pollBody(p);await beforePut();await raw.edit(p.mid,{text:b.text,format:b.format,notify:false});
 }};
}
function pollBody(p){return body({...p,votes:new Map(p.order.map(uid=>[uid,p.votes[uid]]))})}
class Autopost{
 constructor({store,api,booking,calendar,calendarPollStore,calendarMode=false,admins=[],now=()=>new Date(),log=console.error}){
  Object.assign(this,{store,api,booking,calendar,calendarPollStore,calendarMode,admins,now,log});this.calendarCallbacks = calendar && calendarPollStore
      ? require('./training-test-calendar-callbacks').createCalendarCallbacks({
          store: calendarPollStore,
          calendar,
          now: () => +this.now(),
          render: require('./training-test-calendar-body').calendarPollBody
        })
      : null;
    this.tail=Promise.resolve();this.stopped=false;this.startedAt=+now();this.lastTick=this.startedAt;
 }
 run(job){const next=this.tail.then(()=>{if(!this.stopped)return job()});this.tail=next.catch(()=>{});return next}
 async publishCalendar(workout) {
   if (!this.calendarPollStore || !this.calendar) return false;

   const now = this.now();
   const today = moscow(now).date;
   if (workout.date !== today) return false;

   const startsAt = Date.parse(
     workout.date + 'T' + workout.time + ':00+03:00'
   );
   if (!Number.isFinite(startsAt) || +now >= startsAt) return false;

   const {workoutKey} = require('./fitpp-calendar-poll-plan');
   const key = workoutKey(workout);

   await this.api.verify();

   const candidate = {id: randomUUID(), createdAt: +now};
   const reserved = await this.calendarPollStore.reserve(workout, candidate);
   if (!reserved) return false;

   const poll = await this.calendarPollStore.read(key);
   if (poll?.id !== candidate.id || poll.status !== 'reserved') {
     throw Error('CALENDAR_RESERVATION_REFUSED');
   }

   const {calendarPollBody} = require('./training-test-calendar-body');

   try {
     const mid = await this.api.sendCalendar(poll, calendarPollBody(poll));
     await this.calendarPollStore.finish(key, poll.id, mid);
     this.log('Training Test: calendar poll published.');
     return true;
   } catch {
     await this.calendarPollStore.uncertain(key, poll.id);
     this.log('Training Test: calendar publication uncertain; retry blocked.');
     return false;
   }
 }

 async calendarPlan() {
   if (!this.calendar || !this.calendarPollStore) return [];
   const now = this.now();
   const today = moscow(now).date;
   const workouts = await this.calendar.day(today);
   const plan = require('./fitpp-calendar-poll-plan').planDay(workouts, now);
    const byId = new Map(workouts.map(w => [w.id, w]));
    return plan.map(item => {
      const workout = byId.get(item.workoutId);
      if (!workout) throw Error('CALENDAR_WORKOUT_NOT_FOUND');
      return {...workout, publishDue: item.publishDue};
    });
 }

 async publish(date){
  const t=moscow(this.now());
  // Existing exact FitPP pilot remains untouched, including its duplicate guard.
  if(!training(date)||date!==t.date||date===POLL.date||t.clock>=times[t.day])return;
  await this.api.verify();
  const candidate={id:randomUUID(),createdAt:+this.now()};
  // Only the confirmed winner may dispatch. SDK transaction retries contain NO MAX calls.
  // Lost transaction acknowledgement => no send, even if a reservation was committed.
  if(!await this.store.reserve(date,candidate))return;
  const p=await this.store.read(date);
  if(p?.id!==candidate.id||p.status!=='reserved')throw Error('AUTOPOST_RESERVATION_REFUSED');
  try{const mid=await this.api.send(p);await this.store.finish(date,p.id,mid);this.log('Training Test: scheduled poll published.')}
  catch{await this.store.uncertain(date,p.id);this.log('Training Test: publication uncertain; automatic retry blocked; inspect MAX and Firestore.')}
 }
 tick(){return this.run(async()=>{
  const now=this.now(),t=moscow(now),due=Date.parse(t.date+'T10:00:00+03:00'),previous=this.lastTick;this.lastTick=+now;
  if (this.calendarMode) {
    if (+now >= due) {
      const plan = await this.calendarPlan();
      for (const workout of plan) {
        if (workout.publishDue) {
          await this.publishCalendar(workout);
        }
      }
    }
  } else if (times[t.day] && this.startedAt <= due &&
             previous <= due && +now >= due && +now < due + 60000) {
    await this.publish(t.date);
  }
  if (this.calendarMode) {
    await this.cleanupCalendarPolls();
    await this.resumeCalendarDeletes();
    await this.refreshCalendarPolls();
    return;
  } // CALENDAR_REFRESH_TICK
  if(!times[t.day]||t.date===POLL.date||+this.now()>=closesAt(t.date))return;
  const p=await this.store.read(t.date);
  if(p?.status!=='published'||p.revision===p.displayedRevision)return;
  const claimed=await this.store.claimEdit(t.date);if(!claimed)return;
  const token=claimed.editLease.token;
  try{
   await this.api.edit(claimed,{beforePut:()=>this.store.checkEdit(t.date,token)});
   await this.store.finishEdit(t.date,token,claimed.revision);
  }catch{
   this.log('Training Test: PUT /messages failed; edit will retry.');
   await this.store.releaseEdit(t.date,token);
  }
 })}
 async cleanupCalendarPolls() {
  if (!this.calendarMode || !this.calendarPollStore) return;

  const now = +this.now();
  const polls = await this.calendarPollStore.listPublished();

  for (const poll of polls) {
    const date = poll.workout?.date;
    if (typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const deadline = Date.parse(date + 'T22:00:00+03:00');
    if (!Number.isFinite(deadline) || now < deadline) continue;

    try {
      const claimed = await this.calendarPollStore.beginDelete(
        poll.key, poll.id, poll.mid
      );
      if (!claimed) continue;
      await this.api.deleteCalendarPoll({...poll, status: 'deletePending'});
      await this.calendarPollStore.finishDelete(
        poll.key, poll.id, poll.mid
      );
      this.log('Training Test: expired calendar poll deleted.');
    } catch (error) {
      if (/^MAX HTTP 404$/.test(error?.message || '')) {
        try {
          await this.calendarPollStore.markDeleteNeedsReview(
            poll.key, poll.id, poll.mid
          );
          this.log('Training Test: calendar deletion requires manual review.');
        } catch {
          this.log('Training Test: failed to save deletion review flag.');
        }
      } else {
        this.log('Training Test: calendar poll deletion failed; retry later.');
      }
    }
  }
 }

 async resumeCalendarDeletes() {
    if (!this.calendarMode || !this.calendarPollStore ||
        typeof this.calendarPollStore.listPendingDeletes !== 'function') return;

    const pending = await this.calendarPollStore.listPendingDeletes();

    for (const poll of pending) {
      if (poll.deleteNeedsReview === true) continue;
      const date = poll.workout?.date;
      if (typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const deadline = Date.parse(date + 'T22:00:00+03:00');
      if (!Number.isFinite(deadline) || +this.now() < deadline) continue;

      try {
        await this.api.deleteCalendarPoll(poll);
        await this.calendarPollStore.finishDelete(
          poll.key, poll.id, poll.mid
        );
        this.log('Training Test: pending calendar deletion completed.');
      } catch (error) {
        if (/^MAX HTTP 404$/.test(error?.message || '')) {
          try {
            await this.calendarPollStore.markDeleteNeedsReview(
              poll.key, poll.id, poll.mid
            );
            this.log('Training Test: calendar deletion requires manual review.');
          } catch {
            this.log('Training Test: failed to save deletion review flag.');
          }
        } else {
          this.log('Training Test: pending deletion unresolved; retry later.');
        }
      }
    }
  }

  async refreshCalendarPolls() {
    if (!this.calendarMode || !this.calendar || !this.calendarPollStore) return;

    const polls = await at('CALENDAR_LIST', () => this.calendarPollStore.listPublished());

    for (const poll of polls) {
      const key = poll.key;

      // Never interpret a missing workout as a cancellation.
      const workout = await at('CALENDAR_FIND', () => this.calendar.findById(poll.workout.id));
      if (!workout) {
        this.log('Training Test: calendar workout not found; poll unchanged.');
        continue;
      }

      await at('CALENDAR_SYNC', () => this.calendarPollStore.syncWorkout(key, workout));

      const current = await this.calendarPollStore.read(key);
      if (!current || current.status !== 'published' ||
          current.revision === current.displayedRevision) continue;

      // Cancelled workouts must be updated even after their original start time.
      if (!current.cancelled &&
          +this.now() >= Date.parse(
            current.workout.date + 'T' + current.workout.time + ':00+03:00'
          ) + 3600000) continue;

      const claimed = await at('CALENDAR_CLAIM', () => this.calendarPollStore.claimEdit(key));
      if (!claimed) continue;

      const token = claimed.editLease.token;

      try {
        const beforePut = () =>
          this.calendarPollStore.checkEdit(key, token);

        if (claimed.cancelled) {
          await this.api.cancelCalendar(claimed, {beforePut});
        } else {
          await this.api.editCalendar(claimed, {beforePut});
        }

        await this.calendarPollStore.finishEdit(
          key, token, claimed.revision
        );
      } catch {
        this.log('Training Test: calendar poll edit failed; retry later.');
        await this.calendarPollStore.releaseEdit(key, token);
      }
    }
  }

 async publishTodayCalendar() {
   if (!this.calendarMode || !this.calendar || !this.calendarPollStore) return 0;
   const plan = await this.calendarPlan();
   let published = 0;
   for (const workout of plan) {
     if (await this.publishCalendar(workout)) published++;
   }
   return published;
 }

 receive(u){
   if (this.calendarMode &&
       this.calendarCallbacks &&
       u?.update_type === 'message_callback' &&
       typeof u?.callback?.payload === 'string' &&
       u.callback.payload.startsWith('cal:')) {
     return this.run(async () => {
       const result = await this.calendarCallbacks.receive(u);
       if (!result?.handled) return false;

       try {
         if (this.api.answer) {
           await this.api.answer(u.callback.callback_id);
         }
       } catch {
         this.log('Training Test: calendar callback answer failed.');
       }

       return true;
     });
   } // CALENDAR_CALLBACK_ROUTING


 if (this.calendarMode &&
     u?.update_type === 'message_created' &&
     u?.message?.body?.text === '/опрос') {
   return this.run(async () => {
     const m = u.message;
     if (String(m.recipient?.chat_id) !== CHAT ||
         m.recipient?.chat_type !== 'chat' ||
         m.sender?.is_bot !== false ||
         !Number.isSafeInteger(m.sender?.user_id) ||
         !this.admins.includes(String(m.sender.user_id)) ||
         typeof m.body?.mid !== 'string' ||
         !m.body.mid) return false;

     const timestamp = m.timestamp ?? u.timestamp;
     if (!Number.isSafeInteger(timestamp) ||
         Math.abs(+this.now() - timestamp) > 60000) return false;

     const published = await this.publishTodayCalendar();
     if (published > 0) {
       try {
         await this.api.deleteAdminCommand(m, this.admins);
       } catch {
         this.log('Training Test: admin command deletion failed.');
       }
     }
     return true;
   });
 } // CALENDAR_ADMIN_COMMAND


  const m=u?.message,cb=u?.callback;
  if(String(m?.recipient?.chat_id)!==CHAT||m.recipient.chat_type!=='chat'){if(u?.update_type==='message_callback')this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'chat_mismatch'}));return Promise.resolve(false);}
  const match=/^poll:([a-f0-9-]{36}):(yes|cancel)$/.exec(cb?.payload||'');
  // The exact old pilot and private/contact traffic never wait on our queue or database.
  if(match?.[1]===POLL.uuid){this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'historical_pilot_route'}));return Promise.resolve(false);}
  if(m?.body?.text!=='/тестопрос-сегодня'&&!match){if(u?.update_type==='message_callback')this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'payload_rejected'}));return Promise.resolve(false);}
  return this.run(async()=>{
   const t=moscow(this.now());
   if(u.update_type==='message_created'&&m.sender?.is_bot===false&&Number.isSafeInteger(m.sender.user_id)&&this.admins.includes(String(m.sender.user_id))&&typeof m.body?.mid==='string'&&m.body.mid&&m.body.text==='/тестопрос-сегодня'){
    const at=m.timestamp??u.timestamp;if(!Number.isSafeInteger(at)||Math.abs(+this.now()-at)>60000)return true;
    await this.publish(t.date);return true;
   }
   if(!match||u.update_type!=='message_callback'||t.date===POLL.date||+this.now()>=closesAt(t.date)||cb?.user?.is_bot!==false||!Number.isSafeInteger(cb.user.user_id)||cb.user.user_id<=0||typeof cb.callback_id!=='string'||!cb.callback_id.trim()||cb.callback_id.length>256){this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'callback_or_window_rejected'}));return false;}
   const at=cb.timestamp??u.timestamp;if(!Number.isSafeInteger(at)||Math.abs(+this.now()-at)>86400000||at>+this.now()+30000||(cb.timestamp!==undefined&&u.timestamp!==undefined&&cb.timestamp!==u.timestamp)){this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'timestamp_rejected'}));return true;}
   const p=await this.store.read(t.date);
   if(!p||p.status!=='published'||p.id!==match[1]||p.mid!==m.body?.mid){this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'current_poll_mismatch'}));return false;}
   const name=[cb.user.first_name,cb.user.last_name].filter(x=>typeof x==='string').join(' ').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100)||`Участник ${cb.user.user_id}`;
   let applied;try{applied=await this.store.vote(t.date,{id:cb.callback_id,uuid:match[1],mid:m.body.mid,uid:String(cb.user.user_id),at,action:match[2],name},pollBody);}catch(error){this.log(JSON.stringify({event:'training_test_callback',stage:'vote',reason:'transaction_failed'}));throw error}
   this.log(JSON.stringify({event:'training_test_callback',stage:'vote',applied:applied===true}));
   try{if(this.booking){const result=await this.booking.receive(u,p);this.log(JSON.stringify({event:'training_test_callback',stage:'fitpp_booking',applied:result.applied===true,duplicate:result.duplicate===true,skipped:result.reason==='outside_test_binding'}));}}catch(error){const safe=new Set(['DAILY_POLL_SCOPE_REJECTED','DAILY_STATE_MISSING','DAILY_MAIN_REJECTED','DAILY_WORKOUT_REJECTED','UNBOUND_OR_UNKNOWN_POLL','CLIENT_REJECTED','WORKOUT_CHANGED','POLL_CLOSED','EVENT_TIME','DIRECT_WRITES_DISABLED']);this.log(JSON.stringify({event:'training_test_callback',stage:'fitpp_booking',reason:safe.has(error?.message)?error.message:'transaction_failed'}));throw Error('DAILY_BOOKING_FAILED')}
   // Empty answer acknowledges the tap without replacing text or its keyboard.
   if(this.api.answer)try{await this.api.answer(cb.callback_id);this.log(JSON.stringify({event:'training_test_callback',stage:'answer',ok:true}));}catch{this.log(JSON.stringify({event:'training_test_callback',stage:'answer',ok:false}));}
   return true;
  })
 }
 close(){if(!this.closeFlight)this.closeFlight=(async()=>{await this.tail;this.stopped=true;await this.store.close()})();return this.closeFlight}
}
async function prepare({env=process.env,storeFactory,calendarPollStoreFactory,calendarStore,calendarDb,now,raw,booking}={}){
 const c=await at('AUTOPOST_SETTINGS',()=>settings(env));if(!c)return null;
 await at('AUTOPOST_STORE_FACTORY',()=>{if(typeof storeFactory!=='function')throw Error('AUTOPOST_FIRESTORE_REQUIRED')});
 const api=await at('AUTOPOST_MAX_IDENTITY',()=>capability(c,{raw}));
 const store=await at('AUTOPOST_STORE_FACTORY',()=>{
  if(typeof storeFactory!=='function')throw Error('AUTOPOST_FIRESTORE_REQUIRED');
  return storeFactory(c.expectedId,{writeEnabled:()=>env.TRAINING_TEST_AUTOPOST_ENABLED==='true'});
 });
 // Server-only read, no local cache fallback and no startup writes.
 await at('AUTOPOST_FIRST_READ',()=>store.read(moscow(now?now():new Date()).date));
 const calendarPollStore = calendarPollStoreFactory
  ? calendarPollStoreFactory(c.expectedId,{
      writeEnabled:()=>env.TRAINING_TEST_AUTOPOST_ENABLED==='true',
      bookingSyncEnabled:()=>env.TRAINING_TEST_BOOKING_SYNC_ENABLED==='true'
    })
  : null;
 const calendar = calendarStore && calendarDb
  ? require('./fitpp-combined-calendar').createCombinedCalendar({
      calendarStore,calendarDb
    })
  : calendarDb
    ? require('./fitpp-calendar-reader').createCalendar({db:calendarDb})
    : null;
 return new Autopost({
    store,api,booking,calendar,calendarPollStore,
    calendarMode:env.TRAINING_TEST_CALENDAR_POLLS_ENABLED==='true',
    admins:c.admins,now
  });
}
function attach(service,{schedule=setInterval,cancel=clearInterval}={}){
 let busy=false;const tick=()=>{if(busy)return;busy=true;void service.tick().catch(error=>service.log('Training Test: autopost tick refused '+format(mark(error,'RUNTIME_PREPARE')))).finally(()=>{busy=false})};
 const timer=schedule(tick,120000);tick();return async()=>{cancel(timer);await service.close()};
}
module.exports={settings,training,capability,pollBody,Autopost,prepare,attach};
