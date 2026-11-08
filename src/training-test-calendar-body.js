'use strict';
const {payload}=require('./training-test-calendar-callbacks');
const LABELS={zarya:'мкр. Заря',pole:'Поле чудес',online:'Онлайн'};
const LINK='https://telemost.yandex.ru/j/35289250295816';
const escape=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function calendarPollBody(p){
 if(!p?.workout||!LABELS[p.workout.location]||!Array.isArray(p.order)||!p.votes)throw Error('CALENDAR_POLL_BODY_REFUSED');
 const w=p.workout;
 const date=new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(w.date+'T12:00:00Z'));
 const online=w.location==='online';
 const heading=online?'⚡ <b>ТАБАТА | ONLINE</b>':'📍 <b>'+LABELS[w.location]+'</b>';
 const dateBlock='┃ <b>'+escape(date.toUpperCase())+'</b>\n┃ <b>'+escape(w.time)+'</b>';
 const details=online?'\n\n🎥 <b>Яндекс Телемост</b>\n\n↗ <a href="'+LINK+'">Подключиться</a>':'';
 const names=p.order.map((uid,i)=>(i===p.order.length-1?'└─ ':'├─ ')+escape(p.votes[uid]));
 const participants=names.length?'<b>💪🏻 УЧАСТНИКИ ('+names.length+')</b>\n'+names.join('\n'):'🤨 Пока никто не записался!';
 return {text:(p.cancelled?'❌ <b>Тренировка отменена</b>\n\n':'')+heading+'\n\n'+dateBlock+details+'\n\n'+participants+(p.cancelled?'\n\n🔐 Опрос: '+escape(p.id):''),format:'html',
  attachments:p.cancelled?[]:[{type:'inline_keyboard',payload:{buttons:[[
   {type:'callback',text:'✅ Приду',payload:payload(p,'yes')},
   {type:'callback',text:'↩️ Отменить',payload:payload(p,'cancel')}
  ]]}}]};
}
module.exports={calendarPollBody};
