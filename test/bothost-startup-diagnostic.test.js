const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { markStartup, safeStartupDiagnostic } = require('../src/bothost-test-config');
const { inspectStorage } = require('../src/bothost-test-storage');
const { createBothostTestApi } = require('../src/bothost-test-api');
const secret = 'PRIVATE_TOKEN secret personal-data https://private.invalid';
test('only fixed stages and codes escape; known protective reasons stay unchanged', () => {
  for (const [stage, code] of [['STATE_READ', 'EACCES'], ['STATE_LOCK', 'EEXIST'], ['HTTP_LISTEN', 'EADDRINUSE'], ['CA', 'ENOENT'], ['WORKER', 'ENOENT']]) {
    const error = Object.assign(Error(secret), { code, path: secret, stack: secret });
    assert.equal(safeStartupDiagnostic(markStartup(error, stage)), `STARTUP_REFUSED stage=${stage} code=${code}`);
  }
  const hostile = Object.assign(Error(secret), { code: secret, stage: 'STATE_LOCK', cause: { code: secret } });
  assert.equal(safeStartupDiagnostic(markStartup(hostile, secret)), 'STARTUP_REFUSED stage=UNKNOWN code=UNKNOWN');
  assert.equal(safeStartupDiagnostic(markStartup(Error('STATE_HASH_REFUSED'), 'STATE_READ')), 'STATE_HASH_REFUSED');
  assert.equal(safeStartupDiagnostic(markStartup(Error('MAX HTTP 401'), 'API_ME')), 'MAX HTTP 401');
  const nested = markStartup(new SyntaxError(secret), 'STATE_JSON');
  markStartup(nested, 'STATE_READ');
  assert.equal(safeStartupDiagnostic(nested), 'STARTUP_REFUSED stage=STATE_JSON code=INVALID_JSON');
});
test('MAX mock failures classify TLS, network, JSON and rejected responses without output data', async () => {
  for (const [error, code] of [
    [Object.assign(Error(secret), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    [Object.assign(Error(secret), { cause: { code: 'ENOTFOUND' } }), 'ENOTFOUND'],
    [Object.assign(Error(secret), { name: 'TimeoutError' }), 'TIMEOUT_OR_ABORT'],
    [new SyntaxError(secret), 'INVALID_JSON'], [Error('MAX rejected request'), 'API_REJECTED'], [Error(secret), 'API_ERROR']]) {
    await assert.rejects(createBothostTestApi({ token: secret, expectedBotId: '1' }, async () => { throw error; }), caught => {
      assert.equal(safeStartupDiagnostic(caught), `STARTUP_REFUSED stage=API_ME code=${code}`); return true;
    });
  }
});
test('MAX chat and membership failures retain their fixed stages using mocks only', async () => {
  const me = { user_id: 1, username: 'id623401053090_1_bot', is_bot: true };
  for (const [failedCall, stage] of [[2, 'API_CHAT'], [3, 'API_MEMBER']]) {
    let calls = 0;
    await assert.rejects(createBothostTestApi({ token: secret, expectedBotId: '1' }, async () => {
      if (++calls === failedCall) throw Error(secret);
      return { ok: true, json: async () => calls === 1 ? me : { chat_id: '-79450912874680', title: 'ТАБАТА запись' } };
    }), error => { assert.equal(safeStartupDiagnostic(error), `STARTUP_REFUSED stage=${stage} code=API_ERROR`); return true; });
  }
});
test('synthetic state distinguishes missing file and invalid JSON without changing bytes', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'startup-diagnostic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => inspectStorage(dir, 'a'.repeat(64)), error => {
    assert.equal(safeStartupDiagnostic(error), 'STARTUP_REFUSED stage=STATE_READ code=ENOENT'); return true;
  });
  const bytes = Buffer.from('{"private":"' + secret + '"');
  const file = path.join(dir, 'state.json'); fs.writeFileSync(file, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.throws(() => inspectStorage(dir, hash), error => {
    assert.equal(safeStartupDiagnostic(error), 'STARTUP_REFUSED stage=STATE_JSON code=INVALID_JSON'); return true;
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});
