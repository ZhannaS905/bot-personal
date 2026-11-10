'use strict';

const { times } = require('./schedule');

const LABELS = {
  zarya: 'мкр. Заря',
  pole: 'Поле чудес',
  online: 'Онлайн'
};

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

function formatWorkoutDate(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return String(isoDate || '');
  const d = new Date(isoDate + 'T12:00:00Z');
  try {
    const formatted = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      weekday: 'short',
      timeZone: 'Europe/Moscow'
    }).format(d);
    return formatted;
  } catch {
    return isoDate.split('-').reverse().join('.');
  }
}

async function getNextWorkoutInfo(currentDate, calendar) {
  // First, check with calendar if available
  if (calendar && typeof calendar.day === 'function') {
    for (let offset = 1; offset <= 14; offset++) {
      const nextDate = addDays(currentDate, offset);
      try {
        const workouts = await calendar.day(nextDate);
        const active = (workouts || []).filter(w => !w.cancelled);
        if (active.length > 0) {
          return {
            date: nextDate,
            days: offset,
            daysText: `${offset} ${daysLabel(offset)}`,
            dateFormatted: formatWorkoutDate(nextDate),
            workout: active[0]
          };
        }
      } catch {
        // Fall back to schedule table below
        break;
      }
    }
  }

  // Fallback to static weekly schedule from schedule.js
  for (let offset = 1; offset <= 14; offset++) {
    const nextDate = addDays(currentDate, offset);
    const dayOfWeek = new Date(nextDate + 'T12:00:00Z').getUTCDay();
    if (times[dayOfWeek]) {
      return {
        date: nextDate,
        days: offset,
        daysText: `${offset} ${daysLabel(offset)}`,
        dateFormatted: formatWorkoutDate(nextDate),
        time: times[dayOfWeek]
      };
    }
  }

  // Extreme fallback if schedule has no entries
  return {
    date: addDays(currentDate, 1),
    days: 1,
    daysText: '1 день',
    dateFormatted: formatWorkoutDate(addDays(currentDate, 1))
  };
}

function formatCancellationNotification({ workout, nextInfo }) {
  const loc = LABELS[workout.location] || workout.location || '';
  const curDateStr = formatWorkoutDate(workout.date);
  const nextDateStr = nextInfo.dateFormatted;
  const daysStr = nextInfo.daysText;

  return (
    `❌ <b>Тренировка отменена</b>\n\n` +
    `Занятие <b>${curDateStr}</b> в <b>${workout.time}</b> (${loc}) отменено.\n\n` +
    `🎟 Занятие сохранено на вашем абонементе.\n` +
    `⏳ Срок действия абонемента автоматически продлён на <b>${daysStr}</b> (до следующей тренировки ${nextDateStr}).\n\n` +
    `🫶 Ждём вас на следующей тренировке!`
  );
}

function formatRescheduleNotification({ oldWorkout, newWorkout }) {
  const loc = LABELS[newWorkout.location] || newWorkout.location || '';
  const oldDateStr = formatWorkoutDate(oldWorkout.date);
  const newDateStr = formatWorkoutDate(newWorkout.date);

  return (
    `🔄 <b>Перенос тренировки</b>\n\n` +
    `Внимание! Время или дата тренировки изменены:\n\n` +
    `📍 Место: <b>${loc}</b>\n` +
    `⏰ Было: <b>${oldDateStr} в ${oldWorkout.time}</b>\n` +
    `⏰ Стало: <b>${newDateStr} в ${newWorkout.time}</b>\n\n` +
    `Пожалуйста, проверьте свою запись в опросе группы!`
  );
}

async function notifyAttendees({
  poll,
  changeType,
  oldWorkout,
  newWorkout,
  calendar,
  api,
  telegramBridge,
  registry,
  log = console.log
}) {
  if (!poll || !Array.isArray(poll.order) || poll.order.length === 0) {
    return { notified: 0, text: '' };
  }

  let text = '';
  if (changeType === 'cancellation') {
    const nextInfo = await getNextWorkoutInfo(newWorkout.date, calendar);
    text = formatCancellationNotification({ workout: newWorkout, nextInfo });
  } else if (changeType === 'reschedule') {
    text = formatRescheduleNotification({ oldWorkout, newWorkout });
  } else {
    return { notified: 0, text: '' };
  }

  let count = 0;
  for (const uid of poll.order) {
    const siteClientId = poll.siteBookings?.[uid];
    let clientId = siteClientId || null;
    if (!clientId && telegramBridge?.bindings) {
      clientId = telegramBridge.bindings.getClientId(uid);
    }

    let notifiedAny = false;

    // 1. Send via Telegram if applicable
    if (telegramBridge && typeof telegramBridge.sendPersonal === 'function') {
      try {
        if (clientId) {
          const sent = await telegramBridge.sendPersonal(clientId, text);
          if (sent) notifiedAny = true;
        }
        if (!notifiedAny && telegramBridge.isTelegramUser?.(uid)) {
          const sent = await telegramBridge.sendPersonal(uid, text);
          if (sent) notifiedAny = true;
        }
      } catch (err) {
        log(`[Notification] Ошибка отправки в Telegram для ${uid}: ${err?.message || err}`);
      }
    }

    // 2. Send via MAX if applicable
    if (api && typeof api.sendPersonal === 'function') {
      try {
        let maxUserId = null;
        if (clientId && registry?.bindings) {
          const binding = registry.bindings.find(b => b.clientId === clientId && b.notificationsEnabled);
          if (binding?.maxUserId) maxUserId = binding.maxUserId;
        }
        // If not mapped via siteClientId or no binding, but uid is a MAX user ID
        if (!maxUserId && /^[1-9]\d*$/.test(String(uid)) && (!telegramBridge?.isTelegramUser?.(uid) || siteClientId)) {
          // Synthetic UIDs >= 9000000000 are not real MAX users
          if (Number(uid) < 9000000000) {
            maxUserId = uid;
          }
        }
        if (maxUserId) {
          const sent = await api.sendPersonal(maxUserId, text);
          if (sent) notifiedAny = true;
        }
      } catch (err) {
        log(`[Notification] Ошибка отправки в MAX для ${uid}: ${err?.message || err}`);
      }
    }

    if (notifiedAny) count++;
  }

  return { notified: count, text };
}

module.exports = {
  addDays,
  daysLabel,
  formatWorkoutDate,
  getNextWorkoutInfo,
  formatCancellationNotification,
  formatRescheduleNotification,
  notifyAttendees
};
