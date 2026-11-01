'use strict';

const counts = { set: 0, update: 0, delete: 0 };

function wrapTransaction(tx) {
  return new Proxy(tx, {
    get(target, property) {
      if (['set', 'update', 'delete'].includes(property)) {
        return (...args) => {
          const ref = args[0];
          counts[property]++;

          console.log('[FIRESTORE_WRITE_ATTEMPT]', JSON.stringify({
            operation: property,
            path: ref?.path ?? '(unknown)',
            count: counts[property],
            stack: new Error().stack.split('\n').slice(2, 7)
          }));

          return target[property](...args);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function wrapSdk(sdk) {
  return {
    ...sdk,
    runTransaction(database, callback, options) {
      return sdk.runTransaction(
        database,
        tx => callback(wrapTransaction(tx)),
        options
      );
    }
  };
}

module.exports = { wrapSdk, counts };
