'use strict';

// Read-only resolution of existing MAX -> FitPP client bindings.

const {validateRegistry} = require('./contact-linking');

function resolveClient(registry, maxUserId, botId, validClientId) {
  if (!/^[1-9]\d*$/.test(String(maxUserId)) ||
      !/^[1-9]\d*$/.test(String(botId))) {
    throw Error('BOOKING_ID_REFUSED');
  }

  if (!registry || String(registry.botId) !== String(botId)) {
    throw Error('BOOKING_REGISTRY_REFUSED');
  }

  const checked = validateRegistry(registry, Number(botId), validClientId);

  const matches = checked.bindings.filter(
    binding => String(binding.maxUserId) === String(maxUserId)
  );

  if (matches.length > 1) {
    throw Error('BOOKING_BINDING_REFUSED');
  }

  return matches.length === 1 ? matches[0].clientId : null;
}

module.exports = {resolveClient};
