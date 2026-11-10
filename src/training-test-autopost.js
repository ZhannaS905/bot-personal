'use strict';
// Dedicated capability; general MAX write flags and Firebase adapters stay unchanged.
const {randomUUID}=require('node:crypto');
const {at,mark,format}=require('./fitpp-direct-diagnostic');
const {MaxApi}=require('./api');
const {CHAT,config,body}=require('./memory-training-test');
const {checkTestBotIdentity,identityAccepted}=require('./test-bot-identity');
const {moscow,times}=require('./schedule');
const {POLL}=require('../direct-core/src/pilot-policy.cjs');
const {projectId: personalProjectId}=require('./fitpp-personal/runtime-config');
const MID=/^mid\.[a-zA-Z0-9]+$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function settings(env){
 if(env.TRAINING_TEST_AUTOPOST_ENABLED===undefined||env.TRAINING_TEST_AUTOPOST_ENABLED==='false')return null;
 if(env.TRAINING_TEST_AUTOPOST_ENABLED!=='true')throw Error('AUTOPOST_FLAG_REFUSED');
 const c=config(env);
 if(env.FIREBASE_PROJECT_ID!=='fitpp-test'&&env.FIREBASE_PROJECT_ID!==personalProjectId)throw Error('AUTOPOST_TEST_PROJECT_REQUIRED');
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
  if(String(chat.chat_id)!==CHAT||chat.title!=='ТАБАТА запись')throw Error('AUTOPOST_CHAT_REFUSED');
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
      (existing?.sender != null &&
        (String(existing.sender.user_id) !== String(c.expectedId) ||
         existing.sender.is_bot !== true))) {
    throw Error('CALENDAR_DELETE_SCOPE_REFUSED');
  }

  await raw.request('DELETE', '/messages', {message_id:p.mid});
 },

 async deleteAdminCommand(m, admins) {
  if (m?.body?.text !== '/опрос' ||
      !MID.test(m.body?.mid) ||
      String(m.recipient?.chat_id) !== CHAT ||
      m.recipient?.chat_type !== 'channel' ||
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
 async answer(id){if(typeof id!=='string'||!id.trim()||id.length>256)throw Error('CALLBACK_ID_REQUIRED');return raw.request('POST','/answers',{callback_id:id},{notification:'Нажатие обработано'})},async editCalendar(p, {beforePut=async()=>{}}={}) {
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
    (existing?.sender != null &&
      (String(existing.sender.user_id) !== String(c.expectedId) ||
       existing.sender.is_bot !== true)) ||
    (!expectedButtons && !restoring)) {

  console.error('Training Test: calendar edit scope diagnostics ' + JSON.stringify({
    midMatches: existing?.body?.mid === p.mid,
    chatMatches: String(existing?.recipient?.chat_id) === CHAT,
    senderMatches: existing?.sender?.user_id === Number(c.expectedId),
    isBot: existing?.sender?.is_bot === true,
    senderFields: Object.keys(existing?.sender || {}).sort(),
    buttonsMatch: expectedButtons,
    restoring
  }));

  throw Error('CALENDAR_EDIT_SCOPE_REFUSED');
}

  const {calendarPollBody} = require('./training-test-calendar-body');
  const message = calendarPollBody(p);

  await beforePut();

  await raw.edit(p.mid, {
    text: message.text,
    format: message.format,
    ...(restoring ? {attachments: message.attachments} : {})
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
      (existing?.sender != null &&
        (String(existing.sender.user_id) !== String(c.expectedId) ||
         existing.sender.is_bot !== true))) {
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
    attachments: []
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
 },
 async sendPersonal(userId, text){
  if(!Number.isSafeInteger(Number(userId))||Number(userId)<=0)return false;
  try{
   await verify();
   await raw.request('POST','/messages',{user_id:Number(userId)},{text,format:'html',notify:true});
   return true;
  }catch{
   return false;
  }
 }};
}
function pollBody(p){return body({...p,votes:new Map(p.order.map(uid=>[uid,p.votes[uid]]))})}
class Autopost{
 constructor({store,api,booking,calendar,calendarPollStore,calendarMode=false,personalMode=false,admins=[],now=()=>new Date(),log=console.error,telegramBridge=null}){
  Object.assign(this,{store,api,booking,calendar,calendarPollStore,calendarMode,personalMode,admins,now,log,telegramBridge});this.calendarCallbacks = calendar && calendarPollStore
      ? require('./training-test-calendar-callbacks').createCalendarCallbacks({
          store: calendarPollStore,
          calendar,
          now: () => +this.now(),
          render: require('./training-test-calendar-body').calendarPollBody
        })
      : null;
    this.tail=Promise.resolve();this.stopped=false;this.startedAt=+now();this.lastTick=this.startedAt;this.lastBookingSync=0;this.lastCalendarMaintenance=0;this.lastCalendarCleanupDate=null;
    if (this.telegramBridge) {
      this.telegramBridge.start({
        onAdminPoll: async () => {
          await this.publishTodayCalendar();
        },
        onCallback: async (syntheticUpdate) => {
          await this.receive(syntheticUpdate);
        },
        getActivePoll: async (payload) => {
          const parts = (payload || '').split(':');
          const key = parts[1];
          if (key && this.calendarPollStore) {
            return this.calendarPollStore.read(key);
          }
          return null;
        }
      });
    }
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
     if (this.telegramBridge) {
       try {
         await this.telegramBridge.sendCalendar({...poll, key, mid}, calendarPollBody(poll));
       } catch (err) {
         this.log('Training Test: telegram publication failed: ' + (err?.message || err));
       }
     }
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
 async syncPendingBookings() {
  if (!this.calendarMode || !this.calendarPollStore) return 0;

  const pending = await this.calendarPollStore.listPendingBookingSync();
  let completed = 0;

  for (const poll of pending) {
    try {
      if (await this.calendarPollStore.syncBookings(poll.key)) {
        completed++;
      }
    } catch (error) {
      const {mark, format} = require('./fitpp-direct-diagnostic');
      this.log('Training Test: deferred booking sync failed; ' +
        format(mark(error, 'CALENDAR_SYNC')));
    }
  }

  return completed;
 }

 tick(){return this.run(async()=>{
  const now=this.now(),t=moscow(now),due=Date.parse(t.date+'T10:00:00+03:00'),previous=this.lastTick;this.lastTick=+now;
  if (this.calendarMode) {
    const hour = new Date(+now + 3 * 3600000).getUTCHours();
    const planDue = hour >= 10 && hour < 23 &&
      ((previous < due && +now >= due) ||
       (+now - (this.lastCalendarPlan || 0) >= 60 * 60 * 1000));
    if (planDue) {
      this.lastCalendarPlan = +now;
      const plan = await at('CALENDAR_PLAN', () => this.calendarPlan());
      for (const workout of plan) {
        if (workout.publishDue) {
          await at('CALENDAR_PUBLISH', () => this.publishCalendar(workout));
        }
      }
    }
  } else if (times[t.day] && this.startedAt <= due &&
             previous <= due && +now >= due && +now < due + 60000) {
    await this.publish(t.date);
  }
  if (this.calendarMode) {
    const moscowHour = new Date(+now + 3 * 3600000).getUTCHours();
    const daytime = moscowHour >= 10 && moscowHour < 23;
    const maintenanceDue =
      +now - this.lastCalendarMaintenance >= 5 * 60 * 1000;

    const deleteDue = moscowHour === 22 &&
      (previous < Date.parse(t.date + 'T22:00:00+03:00')) &&
      (+now >= Date.parse(t.date + 'T22:00:00+03:00'));

    if (!daytime || (!maintenanceDue && !deleteDue)) return;

    this.lastCalendarMaintenance = +now;

    const publishedPolls = await at('CALENDAR_POLL_LIST', () => this.calendarPollStore.listPublished());
    // Resolve moves before applying the deletion deadline from the stored date.
    const refreshedPolls = await at('CALENDAR_SYNC', () => this.refreshCalendarPolls(publishedPolls));
    await at('CALENDAR_CLEANUP', () => this.cleanupCalendarPolls(refreshedPolls));
    await at('CALENDAR_DELETE', () => this.resumeCalendarDeletes());

    if (+now - this.lastBookingSync >= 60 * 60 * 1000) {
      this.lastBookingSync = +now;
      try {
        await this.syncPendingBookings();
      } catch {
        this.log('Training Test: booking sync queue failed; retry later.');
      }
    }
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
 async cleanupCalendarPolls(prefetchedPolls) {
  if (!this.calendarMode || !this.calendarPollStore) return;

  const now = +this.now();
  const polls = Array.isArray(prefetchedPolls) ? prefetchedPolls : await this.calendarPollStore.listPublished();
  const remaining = [];

  for (const poll of polls) {
    const date = poll.workout?.date;
    if (typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)) { remaining.push(poll); continue; }

    const deadline = Date.parse(date + 'T22:00:00+03:00');
    if (!Number.isFinite(deadline) || now < deadline) { remaining.push(poll); continue; }

    try {
      const claimed = await this.calendarPollStore.beginDelete(
        poll.key, poll.id, poll.mid
      );
      if (!claimed) { remaining.push(poll); continue; }
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
        this.log('Training Test: calendar poll deletion failed: ' + (error?.message || error) + '; retry later.');
      }
    }
    remaining.push(poll);
  }
   return remaining;
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
          this.log('Training Test: pending deletion unresolved: ' + (error?.message || error) + '; retry later.');
        }
      }
    }
  }

  async refreshCalendarPolls(prefetchedPolls) {
    if (!this.calendarMode || !this.calendar || !this.calendarPollStore) return;

    const polls = Array.isArray(prefetchedPolls) ? prefetchedPolls : await at('CALENDAR_POLL_LIST', () => this.calendarPollStore.listPublished());

    for (const [index, poll] of polls.entries()) {
      const key = poll.key;

      // Never interpret a missing workout as a cancellation.
      const workout = await at('CALENDAR_FIND', () => this.calendar.findById(poll.workout.id));
      if (!workout) {
        this.log('Training Test: calendar workout not found; poll unchanged.');
        continue;
      }

      // Avoid a Firestore transaction when the workout has not changed.
      const changed =
        poll.workout?.date !== workout.date ||
        poll.workout?.time !== workout.time ||
        poll.workout?.location !== workout.location ||
        Boolean(poll.cancelled) !== Boolean(workout.cancelled);

      const isCancellation = Boolean(workout.cancelled) && !poll.cancelled;
      const isReschedule = !workout.cancelled && (
        poll.workout?.date !== workout.date ||
        poll.workout?.time !== workout.time ||
        poll.workout?.location !== workout.location
      );
      const oldWorkout = structuredClone(poll.workout);

      let current = poll;
      if (changed) {
        const synced = await at('CALENDAR_SYNC', () =>
          this.calendarPollStore.syncWorkout(key, workout));
        if (synced !== false) {
          current = await this.calendarPollStore.read(key);
        }
      }
      if (this.personalMode && typeof this.calendar?.bookedClients === 'function' && typeof this.calendarPollStore?.syncSiteAttendees === 'function') {
        try {
          const booked = await this.calendar.bookedClients(workout);
          const synced = await this.calendarPollStore.syncSiteAttendees(key, booked);
          if (synced) {
            current = await this.calendarPollStore.read(key);
          }
        } catch (err) {
          this.log('Training Test: site bookings sync error: ' + (err?.message || err));
        }
      }
      polls[index] = current || poll;
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
          if (this.telegramBridge) {
            try {
              const { calendarPollBody } = require('./training-test-calendar-body');
              await this.telegramBridge.cancelCalendar(claimed, calendarPollBody(claimed));
            } catch (err) {
              this.log('Training Test: telegram cancel failed: ' + (err?.message || err));
            }
          }
          if (isCancellation) {
            try {
              const registry = typeof this.calendarPollStore?.getRegistry === 'function'
                ? await this.calendarPollStore.getRegistry()
                : null;
              const { notifyAttendees } = require('./fitpp-workout-notifications');
              await notifyAttendees({
                poll: claimed,
                changeType: 'cancellation',
                oldWorkout,
                newWorkout: workout,
                calendar: this.calendar,
                api: this.api,
                telegramBridge: this.telegramBridge,
                registry,
                log: msg => this.log(msg)
              });
            } catch (err) {
              this.log('Training Test: cancellation notification failed: ' + (err?.message || err));
            }
          }
        } else {
          await this.api.editCalendar(claimed, {beforePut});
          if (this.telegramBridge) {
            try {
              const { calendarPollBody } = require('./training-test-calendar-body');
              await this.telegramBridge.editCalendar(claimed, calendarPollBody(claimed));
            } catch (err) {
              this.log('Training Test: telegram edit failed: ' + (err?.message || err));
            }
          }
          if (isReschedule) {
            try {
              const registry = typeof this.calendarPollStore?.getRegistry === 'function'
                ? await this.calendarPollStore.getRegistry()
                : null;
              const { notifyAttendees } = require('./fitpp-workout-notifications');
              await notifyAttendees({
                poll: claimed,
                changeType: 'reschedule',
                oldWorkout,
                newWorkout: workout,
                calendar: this.calendar,
                api: this.api,
                telegramBridge: this.telegramBridge,
                registry,
                log: msg => this.log(msg)
              });
            } catch (err) {
              this.log('Training Test: reschedule notification failed: ' + (err?.message || err));
            }
          }
        }

        await this.calendarPollStore.finishEdit(
          key, token, claimed.revision
        );
      } catch {
        this.log('Training Test: calendar poll edit failed; retry later.');
        await this.calendarPollStore.releaseEdit(key, token);
      }
    }
    return polls;
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
       let result;
       try {
         result = await this.calendarCallbacks.receive(u);
       } catch (error) {
         const allowed = new Set([
           'CALENDAR_CALLBACK_SCOPE_REFUSED',
           'CALENDAR_CALLBACK_TIME_REFUSED',
           'CALENDAR_CALLBACK_POLL_REFUSED',
           'CALENDAR_CALLBACK_WORKOUT_CHANGED',
           'CALENDAR_CALLBACK_CLOSED'
         ]);
         this.log(
           'Training Test: calendar callback failed: ' +
           (allowed.has(error?.message)
             ? error.message
             : error?.code === 'permission-denied'
               ? 'FIRESTORE_PERMISSION_DENIED'
               : 'UNKNOWN')
         );
         throw error;
       }
       if (!result?.handled) return false;
       // Acknowledge before the slow MAX verification/edit sequence. Failure
       // must never prevent the already committed vote or booking sync.
       try {
         if (this.api.answer) {
           await this.api.answer(u.callback.callback_id);
           this.log('Training Test: calendar callback answered.');
         }
       } catch (error) {
         const status = /^MAX HTTP ([1-5][0-9]{2})$/.exec(error?.message || '');
         this.log('Training Test: calendar callback answer failed; reason=' +
           (status ? 'MAX_HTTP_' + status[1] :
             error?.name === 'TimeoutError' || error?.name === 'AbortError'
               ? 'TIMEOUT_OR_ABORT' : 'UNKNOWN'));
       }

       const key = u.callback.payload.split(':')[1];
       const refreshPoll = async () => {
         if (result.applied !== true) return;
         try {
           const claimed = await this.calendarPollStore.claimEdit(key);
           if (claimed) {
             const token = claimed.editLease.token;
             try {
               await this.api.editCalendar(claimed, {
                 beforePut: () => this.calendarPollStore.checkEdit(key, token)
               });
               if (this.telegramBridge) {
                 try {
                   const { calendarPollBody } = require('./training-test-calendar-body');
                   await this.telegramBridge.editCalendar(claimed, calendarPollBody(claimed));
                 } catch (err) {
                   this.log('Training Test: telegram edit failed: ' + (err?.message || err));
                 }
               }
               await this.calendarPollStore.finishEdit(
                 key, token, claimed.revision
               );
             } catch (error) {
               await this.calendarPollStore.releaseEdit(key, token);
               throw error;
             }
           }
} catch (error) {
  const code = String(error?.message || error?.code || 'UNKNOWN');
  const safeCode = /^(CALENDAR_[A-Z_]+|MAX_HTTP_\d{3})$/.test(code)
    ? code
    : 'UNKNOWN';

  this.log(`Training Test: immediate poll refresh failed [${safeCode}]; retry later.`);
}
       };

       let refresh;
       if (this.personalMode && result.applied === true && result.action === 'yes') {
         refresh = refreshPoll();
         // The durable vote already marked both projections pending. Give MAX
         // a head start, then sync the booking even if the edit is still in flight.
         let timer;
         try {
           await Promise.race([refresh, new Promise(resolve => {
             timer = setTimeout(resolve, 3000);
           })]);
         } finally {
           clearTimeout(timer);
         }
       }

       // Also drain on redelivery: the receipt may exist after an earlier sync
       // failure. syncBookings reads the latest revision in one idempotent tx.
       if (typeof this.calendarPollStore.syncBookings === 'function') {
         for (let attempt = 0; attempt < 3; attempt++) {
           try {
             await this.calendarPollStore.syncBookings(key);
             break;
           } catch (error) {
             this.log('Training Test: immediate booking sync failed; ' +
               format(mark(error, 'CALENDAR_SYNC')));
             const code = (error?.code || '').replace(/^firestore\//, '');
             if (attempt === 2 || !['unavailable', 'deadline-exceeded', 'aborted',
                 'auth/network-request-failed'].includes(code)) break;
             await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
           }
         }
       }
       // Keep the callback queue serialized with maintenance and later edits.
       await (refresh ?? refreshPoll());

       return true;
     });
   } // CALENDAR_CALLBACK_ROUTING


 if (this.calendarMode &&
     u?.update_type === 'message_created' &&
     u?.message?.body?.text === '/опрос') {
   return this.run(async () => {
     const m = u.message;
     if (String(m.recipient?.chat_id) !== CHAT ||
         m.recipient?.chat_type !== 'channel' ||
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


  if(this.personalMode)return Promise.resolve(false);
  const m=u?.message,cb=u?.callback;
  if(String(m?.recipient?.chat_id)!==CHAT||m.recipient.chat_type!=='channel'){if(u?.update_type==='message_callback')this.log(JSON.stringify({event:'training_test_callback',stage:'filter',reason:'chat_mismatch'}));return Promise.resolve(false);}
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
 close(){if(!this.closeFlight)this.closeFlight=(async()=>{await this.tail;this.stopped=true;if(this.telegramBridge)await this.telegramBridge.stop();await this.store.close()})();return this.closeFlight}
}
async function prepare({env=process.env,storeFactory,calendarPollStoreFactory,calendarStore,calendarDb,personalCalendar,now,raw,booking}={}){
 const c=await at('AUTOPOST_SETTINGS',()=>settings(env));if(!c)return null;
 const personalMode=env.FIREBASE_PROJECT_ID===personalProjectId;
 if(personalMode&&(!personalCalendar||typeof calendarPollStoreFactory!=='function'||
    env.TRAINING_TEST_CALENDAR_POLLS_ENABLED!=='true'))throw Error('PERSONAL_CALENDAR_MODE_REQUIRED');
 await at('AUTOPOST_STORE_FACTORY',()=>{if(!personalMode&&typeof storeFactory!=='function')throw Error('AUTOPOST_FIRESTORE_REQUIRED')});
 const api=await at('AUTOPOST_MAX_IDENTITY',()=>capability(c,{raw}));
 const store=personalMode?{close(){}}:await at('AUTOPOST_STORE_FACTORY',()=>{
  if(typeof storeFactory!=='function')throw Error('AUTOPOST_FIRESTORE_REQUIRED');
  return storeFactory(c.expectedId,{writeEnabled:()=>env.TRAINING_TEST_AUTOPOST_ENABLED==='true'});
 });
 // Server-only read, no local cache fallback and no startup writes.
 if(!personalMode)await at('AUTOPOST_FIRST_READ',()=>store.read(moscow(now?now():new Date()).date));
 const calendarPollStore = calendarPollStoreFactory
  ? calendarPollStoreFactory(c.expectedId,{
      writeEnabled:()=>env.TRAINING_TEST_AUTOPOST_ENABLED==='true',
      bookingSyncEnabled:()=>env.TRAINING_TEST_BOOKING_SYNC_ENABLED==='true'
    })
  : null;
const calendarMode=env.TRAINING_TEST_CALENDAR_POLLS_ENABLED==='true';
 const calendar = personalMode ? personalCalendar : calendarMode
  ? (() => {
      if (!calendarDb) throw Error('CALENDAR_DB_REQUIRED');
      return require('./fitpp-calendar-reader').createCalendar({
        db:calendarDb
      });
    })()
  : calendarStore && calendarDb
    ? require('./fitpp-combined-calendar').createCombinedCalendar({
        calendarStore,calendarDb
      })
    : calendarDb
      ? require('./fitpp-calendar-reader').createCalendar({db:calendarDb})
      : null;
 let telegramBridge = null;
 if (env.TELEGRAM_BOT_TOKEN) {
   const { TelegramBridge } = require('./telegram-bridge');
   telegramBridge = new TelegramBridge({
     token: env.TELEGRAM_BOT_TOKEN,
     chatId: env.TELEGRAM_CHAT_ID,
     adminIds: env.TELEGRAM_ADMIN_IDS ? env.TELEGRAM_ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean) : c.admins,
     stateDir: env.STATE_DIR || (process.platform === 'linux' ? '/data' : 'data'),
     clientFinder: personalCalendar && typeof personalCalendar.findClientByPhone === 'function'
       ? phone => personalCalendar.findClientByPhone(phone)
       : null,
     onBindingsChanged: personalCalendar && typeof personalCalendar.syncTelegramBindings === 'function'
       ? bindings => personalCalendar.syncTelegramBindings(bindings)
       : null,
     log: console.log,
     onError: console.error
   });
 }
 return new Autopost({
    store,api,booking,calendar,calendarPollStore,
    calendarMode,personalMode,
    admins:c.admins,now,telegramBridge
  });
}
function attach(service,{schedule=setInterval,cancel=clearInterval}={}){
 let busy=false;const tick=()=>{if(busy)return;busy=true;void service.tick().catch(error=>service.log('Training Test: autopost tick refused '+format(mark(error,'RUNTIME_PREPARE')))).finally(()=>{busy=false})};
 const timer=schedule(tick,300000);tick();return async()=>{cancel(timer);await service.close()};
}
module.exports={settings,training,capability,pollBody,Autopost,prepare,attach};
