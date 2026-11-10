'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  addDays,
  daysLabel,
  getNextWorkoutInfo,
  formatCancellationNotification,
  formatRescheduleNotification,
  notifyAttendees
} = require('../src/fitpp-workout-notifications');

test('Workout notifications: next workout calculation and Russian pluralization', async () => {
  assert.equal(daysLabel(1), 'день');
  assert.equal(daysLabel(2), 'дня');
  assert.equal(daysLabel(3), 'дня');
  assert.equal(daysLabel(4), 'дня');
  assert.equal(daysLabel(5), 'дней');
  assert.equal(daysLabel(11), 'дней');
  assert.equal(daysLabel(21), 'день');
  assert.equal(daysLabel(22), 'дня');

  // Static schedule check:
  // Mon (2026-10-19) -> next is Tue (2026-10-20): 1 day
  const monNext = await getNextWorkoutInfo('2026-10-19', null);
  assert.equal(monNext.days, 1);
  assert.equal(monNext.daysText, '1 день');
  assert.equal(monNext.date, '2026-10-20');

  // Thu (2026-10-22) -> Friday is off -> next is Sat (2026-10-24): 2 days
  const thuNext = await getNextWorkoutInfo('2026-10-22', null);
  assert.equal(thuNext.days, 2);
  assert.equal(thuNext.daysText, '2 дня');
  assert.equal(thuNext.date, '2026-10-24');

  // Dynamic calendar check:
  const mockCalendar = {
    day: async (date) => {
      if (date === '2026-10-25') {
        return [{ id: 'w-custom', date: '2026-10-25', time: '11:00', location: 'zarya', cancelled: false }];
      }
      return [];
    }
  };
  const customNext = await getNextWorkoutInfo('2026-10-22', mockCalendar);
  assert.equal(customNext.date, '2026-10-25');
  assert.equal(customNext.days, 3);
  assert.equal(customNext.daysText, '3 дня');
});

test('Workout notifications: text format contains subscription extension and required details', async () => {
  const workout = {
    date: '2026-10-22',
    time: '18:30',
    location: 'pole',
    cancelled: true
  };
  const nextInfo = await getNextWorkoutInfo(workout.date, null);
  const text = formatCancellationNotification({ workout, nextInfo });

  assert.match(text, /❌ <b>Тренировка отменена<\/b>/);
  assert.match(text, /Занятие <b>.*<\/b> в <b>18:30<\/b> \(Поле чудес\) отменено\./);
  assert.match(text, /🎟 Занятие сохранено на вашем абонементе\./);
  assert.match(text, /⏳ Срок действия абонемента автоматически продлён на <b>2 дня<\/b>/);
  assert.match(text, /до следующей тренировки/);
  assert.match(text, /🫶 Ждём вас на следующей тренировке!/);

  const oldWorkout = { date: '2026-10-22', time: '18:30', location: 'pole' };
  const newWorkout = { date: '2026-10-23', time: '19:00', location: 'zarya' };
  const reschedText = formatRescheduleNotification({ oldWorkout, newWorkout });

  assert.match(reschedText, /🔄 <b>Перенос тренировки<\/b>/);
  assert.match(reschedText, /📍 Место: <b>мкр\. Заря<\/b>/);
  assert.match(reschedText, /⏰ Было: <b>.* в 18:30<\/b>/);
  assert.match(reschedText, /⏰ Стало: <b>.* в 19:00<\/b>/);
  assert.match(reschedText, /Пожалуйста, проверьте свою запись в опросе группы!/);
});

test('Workout notifications: notifyAttendees dispatches across Telegram and MAX', async () => {
  const maxMessages = [];
  const tgMessages = [];

  const mockApi = {
    sendPersonal: async (userId, text) => {
      maxMessages.push({ userId, text });
      return true;
    }
  };

  const mockTelegramBridge = {
    isTelegramUser: (uid) => uid === '88888',
    sendPersonal: async (id, text) => {
      tgMessages.push({ id, text });
      return true;
    },
    bindings: {
      getClientId: (uid) => uid === '88888' ? 'client-tg' : null
    }
  };

  const registry = {
    bindings: [
      { clientId: 'client-max', maxUserId: 11111, notificationsEnabled: true }
    ]
  };

  const poll = {
    order: ['11111', '88888', '9000000042'],
    siteBookings: {
      '9000000042': 'client-max'
    }
  };

  const workout = {
    date: '2026-10-19',
    time: '20:00',
    location: 'zarya',
    cancelled: true
  };

  const result = await notifyAttendees({
    poll,
    changeType: 'cancellation',
    oldWorkout: workout,
    newWorkout: workout,
    calendar: null,
    api: mockApi,
    telegramBridge: mockTelegramBridge,
    registry
  });

  assert.equal(result.notified, 3);
  assert.match(result.text, /Тренировка отменена/);
  assert.match(result.text, /Срок действия абонемента автоматически продлён на <b>1 день<\/b>/);

  // MAX messages received for voter 11111 and site booking client-max (which maps to maxUserId 11111)
  assert.ok(maxMessages.some(m => String(m.userId) === '11111'));
  // Telegram message received for Telegram user 88888 / client-tg
  assert.ok(tgMessages.some(m => String(m.id) === 'client-tg' || String(m.id) === '88888'));
});
