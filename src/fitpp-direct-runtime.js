'use strict';

const {at} = require('./fitpp-direct-diagnostic');
const {settings, connect} = require('./fitpp-direct-session');

async function prepare({env = process.env, sdk, now = Date.now}) {
  await at('SETTINGS', () => settings(env));

  const autopostEnabled =
    env.TRAINING_TEST_AUTOPOST_ENABLED === 'true';

  const session = await at('CONNECT', () => connect({env, sdk}));

  try {
    const contact = env.CONTACT_LINK_ENABLED === 'true'
      ? await at('CONTACT_CONFIG', () =>
          require('./contact-linking-runtime').prepare({
            env, sdk, now, session
          }))
      : null;

    const dailyBooking = autopostEnabled && !session.personalCalendar
      ? require('./fitpp-daily-booking').createDailyBooking({
          db: session.db,
          botId: env.TEST_EXPECTED_BOT_ID,
          now
        })
      : null;

    return {
      contact,
      dailyBooking,
      autopostStore: session.autopostStore,
      calendarPollStore: session.calendarPollStore,
      calendarStore: session.calendarStore,
      calendarDb: session.db,
      personalCalendar: session.personalCalendar,
      close: session.close
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

module.exports = {prepare};
