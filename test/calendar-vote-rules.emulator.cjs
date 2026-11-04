const { initializeTestEnvironment, assertSucceeds, assertFails } =
  require('@firebase/rules-unit-testing');
const { doc, setDoc, runTransaction, getDoc } = require('firebase/firestore');

const owner = 'lLlMAetSG1aEeJSeBl4F4ypydEh2';
const botId = '131384398';
const key = 'a'.repeat(64);
const base = `trainingTestCalendarPolls/${botId}/polls/${key}`;
const now = Date.now();

async function main() {
  const env = await initializeTestEnvironment({
    projectId: 'fitpp-test',
    firestore: { host: '127.0.0.1', port: 8080 }
  });

  try {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), base), {
        version: 1, botId, chat: '-80345864298680', key,
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: now - 60000,
        workout: { id: 'test-workout', date: '2026-11-03',
                   location: 'zarya', time: '20:00' },
        status: 'published', mid: 'mid.test123',
        votes: {}, last: {}, order: [],
        revision: 0, displayedRevision: 0
      });
    });

    const db = env.authenticatedContext(owner).firestore();
    const poll = doc(db, base);

    async function vote(action, timestamp, receiptId) {
      await assertSucceeds(runTransaction(db, async tx => {
        const snap = await tx.get(poll);
        const p = snap.data();
        const next = {
          ...p,
          votes: action === 'yes' ? { '12345': 'Тест' } : {},
          last: { '12345': timestamp },
          order: action === 'yes' ? ['12345'] : [],
          lastEventUid: '12345',
          revision: p.revision + 1,
          bookingSyncPending: true
        };
        tx.set(poll, next);
        tx.set(doc(db, `${base}/events/${receiptId}`), {
          digest: 'b'.repeat(64),
          at: timestamp
        });
      }));
      console.log(`✅ ${action === 'yes' ? 'Приду' : 'Отменить'}: разрешено`);
    }

    await vote('yes', now, 'c'.repeat(64));
    await vote('cancel', now + 1000, 'd'.repeat(64));

    const result = await getDoc(poll);
    if (result.data().revision !== 2 || result.data().order.length !== 0) {
      throw Error('Неверное итоговое состояние голосования');
    }
    console.log('✅ Итоговое состояние проверено');

    // Проверяем разрешение на подтверждение синхронизации.
    await assertSucceeds(runTransaction(db, async tx => {
      const snap = await tx.get(poll);
      const current = snap.data();

      tx.set(poll, {
        ...current,
        bookingSyncedRevision: current.revision,
        bookingSyncedClients: {},
        bookingSyncPending: false
      });
    }));

    console.log('✅ Подтверждение синхронизации разрешено');

  } finally {
    await env.cleanup();
  }
}

main().catch(error => {
  console.error('❌ Тест не прошёл:', error.message);
  process.exitCode = 1;
});
