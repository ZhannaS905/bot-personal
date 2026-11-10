const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createHash, X509Certificate } = require('node:crypto');
const { CHAT, STATE_DIR, CA_PATH, loadBothostTestConfig, workerEnvironment } = require('../src/bothost-test-config');
const { validateCertificate } = require('../src/bothost-test-tls');
const { createBothostTestApi } = require('../src/bothost-test-api');
const { inspectStorage, openBothostStorage } = require('../src/bothost-test-storage');
const { startBothostTest } = require('../src/bothost-test-runtime');
const safe = { BOT_MODE: 'test', TEST_BOT_TOKEN: 'offline-test-token', TEST_EXPECTED_BOT_ID: '123',
  CHAT_IDS: CHAT, ADMIN_IDS: '456', WEBHOOK_SECRET: 'offline-test-secret',
  TEST_EXPECTED_STATE_SHA256: 'a'.repeat(64), PORT: '3000', HOST: '0.0.0.0', STATE_DIR };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bothost-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const state = { version: 1, polls: { [`${CHAT}/2026-10-21`]: {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', chat: CHAT, date: '2026-10-21',
    status: 'published', mid: 'mid.offline-test', dirty: true, votes: { 9: 'yes' }, names: { 9: 'Тестовый участник' }
  } }, inbox: {}, done: { offlineReceipt: true } };
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const config = { ...loadBothostTestConfig(safe), stateDir: dir, expectedStateHash: hash(), port: 0, host: '127.0.0.1' };
  return { dir, file, state, config, hash };
}
function fakeMax(mode = 'ok') {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([options.method, url.pathname]);
    assert.equal(url.origin, 'https://platform-api2.max.ru');
    assert.equal(options.method, 'GET');
    if (mode === 'unavailable') throw Object.assign(Error('PRIVATE_TOKEN'), { cause: { code: 'ECONNRESET' } });
    if (mode === 'bad_token') return { ok: false, status: 401 };
    if (mode === 'invalid_json') return { ok: true, json: async () => { throw Error('PRIVATE_TOKEN'); } };
    const me = { user_id: mode === 'wrong_id' ? 124 : 123, username: mode === 'wrong_name' ? 'another_bot' : 'id623401053090_1_bot', is_bot: mode !== 'not_bot' };
    const data = url.pathname === '/me' ? me : url.pathname.endsWith('/members/me') ?
      { user_id: mode === 'wrong_member' ? 124 : 123, is_bot: true } :
      { chat_id: mode === 'wrong_chat' ? -1 : Number(CHAT), title: 'ТАБАТА запись' };
    return { ok: true, json: async () => data };
  };
  return { fetchImpl, calls };
}
test('BotHost profile fixes 3000/0.0.0.0 and separate persistent storage', () => {
  const config = loadBothostTestConfig(safe);
  assert.equal(config.port, 3000); assert.equal(config.host, '0.0.0.0'); assert.equal(config.stateDir, STATE_DIR);
  assert.equal(config.autoPublish, false); assert(Object.isFrozen(config));
  assert.deepEqual(loadBothostTestConfig({ ...safe, ADMIN_IDS: '' }).adminIds, []);
  for (const patch of [{ PORT: '18081' }, { PORT: '0' }, { HOST: '127.0.0.1' }, { HOST: '::' },
    { CHAT_IDS: '-1' }, { CHAT_IDS: CHAT + ',-1' }, { ADMIN_IDS: 'invalid' }, { BOT_MODE: 'production' },
    { STATE_DIR: '/app/data' }, { TEST_EXPECTED_BOT_ID: '' }, { TEST_EXPECTED_BOT_ID: '123abc' },
    { TEST_EXPECTED_STATE_SHA256: '' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { NODE_EXTRA_CA_CERTS: '/tmp/other.pem' }, { NODE_OPTIONS: '--require unsafe.js' }]) {
    assert.throws(() => loadBothostTestConfig({ ...safe, ...patch }));
  }
});
test('BotHost BOT_TOKEN alias is accepted only consistently, without weakening identity', async () => {
  assert.equal(loadBothostTestConfig({ ...safe, TEST_BOT_TOKEN: undefined, BOT_TOKEN: safe.TEST_BOT_TOKEN }).token, safe.TEST_BOT_TOKEN);
  assert.equal(loadBothostTestConfig({ ...safe, BOT_TOKEN: safe.TEST_BOT_TOKEN }).token, safe.TEST_BOT_TOKEN);
  assert.throws(() => loadBothostTestConfig({ ...safe, BOT_TOKEN: 'different-token' }));
  assert.throws(() => loadBothostTestConfig({ ...safe, TEST_BOT_TOKEN: undefined, BOT_TOKEN: undefined }));
  for (const token of ['', 'two words', 'Bearer abc']) assert.throws(() => loadBothostTestConfig({ ...safe, TEST_BOT_TOKEN: token }));
  const bad = fakeMax('wrong_id');
  await assert.rejects(createBothostTestApi(loadBothostTestConfig({ ...safe, TEST_BOT_TOKEN: undefined, BOT_TOKEN: 'wrong-bot-token' }), bad.fetchImpl));
  assert.deepEqual(bad.calls, [['GET', '/me']]);
});
test('no environment switch can enable API writes or autopublication', () => {
  for (const name of ['AUTO_PUBLISH', 'TEST_ALLOW_SEND', 'TEST_ALLOW_EDIT', 'TEST_ALLOW_DELETE']) {
    assert.throws(() => loadBothostTestConfig({ ...safe, [name]: 'true' }));
    assert.throws(() => loadBothostTestConfig({ ...safe, [name]: '0' }));
    assert.equal(loadBothostTestConfig({ ...safe, [name]: 'false' }).autoPublish, false);
  }
  const env = workerEnvironment(loadBothostTestConfig(safe));
  assert.equal(env.BOT_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, CA_PATH); assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '1');
  assert.equal(env.TEST_ALLOW_DELETE, 'false');
});
test('send/edit/remove are blocked before transport, even for valid chat and message', async () => {
  const max = fakeMax(); const api = await createBothostTestApi(loadBothostTestConfig(safe), max.fetchImpl);
  const reads = max.calls.length;
  await assert.rejects(api.send(CHAT, { text: 'never send' }));
  await assert.rejects(api.send('-1', {}));
  await assert.rejects(api.edit('mid.offline-test', {}));
  await assert.rejects(api.remove('mid.offline-test', CHAT));
  assert.equal(max.calls.length, reads); assert.equal(api.request, undefined); assert.equal(api.token, undefined);
});
for (const mode of ['bad_token', 'wrong_id', 'wrong_name', 'not_bot', 'wrong_chat', 'wrong_member', 'unavailable', 'invalid_json']) {
  test(`identity/group preflight ${mode} prevents storage lock and listener`, async t => {
    const f = fixture(t), max = fakeMax(mode); let listeners = 0;
    await assert.rejects(startBothostTest(f.config, { fetchImpl: max.fetchImpl, createServer: () => { listeners++; throw Error('must not listen'); } }));
    assert.equal(listeners, 0); assert.equal(fs.existsSync(path.join(f.dir, '.lock')), false);
  });
}
test('missing, empty, corrupt, unexpected and foreign state is never initialized or reset', t => {
  const f = fixture(t);
  assert.throws(() => inspectStorage(path.join(f.dir, 'missing'), f.config.expectedStateHash));
  assert.equal(fs.existsSync(path.join(f.dir, 'missing')), false);
  assert.throws(() => openBothostStorage({ ...f.config, expectedStateHash: 'b'.repeat(64) }));
  assert.equal(fs.existsSync(path.join(f.dir, '.lock')), false);
  for (const value of ['', '{}', JSON.stringify({ version: 1, polls: {}, inbox: {}, done: {} }),
    JSON.stringify({ ...f.state, polls: { 'other/2026-10-21': { ...Object.values(f.state.polls)[0], chat: '-1' } } }),
    JSON.stringify({ ...f.state, inbox: { queued: {} } })]) {
    fs.writeFileSync(f.file, value);
    assert.throws(() => openBothostStorage({ ...f.config, expectedStateHash: f.hash() }));
    assert.equal(fs.readFileSync(f.file, 'utf8'), value);
    assert.equal(fs.existsSync(path.join(f.dir, '.lock')), false);
  }
});
test('linked directories/files and hard-linked state are rejected without modifying targets', t => {
  const f = fixture(t), link = f.dir + '-link';
  fs.symlinkSync(f.dir, link); t.after(() => fs.unlinkSync(link));
  assert.throws(() => inspectStorage(link, f.hash()));
  fs.linkSync(f.file, path.join(f.dir, 'second-copy')); assert.throws(() => inspectStorage(f.dir, f.hash()));
});
test('exclusive lock blocks another instance and data survive graceful close and reopening', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file);
  const store = openBothostStorage(f.config);
  try { assert.throws(() => openBothostStorage(f.config)); assert(fs.existsSync(path.join(f.dir, '.lock'))); }
  finally { store.close(); }
  const next = openBothostStorage(f.config); assert.deepEqual(next.state, f.state); next.close();
  assert(fs.readFileSync(f.file).equals(bytes));
});
function request(port, method, pathname, body, secret) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: secret ? { 'X-Max-Bot-Api-Secret': secret } : {} }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
}
test('read-only hosted listener binds requested host/port, authenticates webhook and never mutates state', async t => {
  const f = fixture(t), max = fakeMax(), bytes = fs.readFileSync(f.file); const bindings = [];
  const runtime = await startBothostTest(f.config, { fetchImpl: max.fetchImpl, createServer: handler => {
    const server = http.createServer(handler), listen = server.listen.bind(server);
    server.listen = (port, host, callback) => { bindings.push([port, host]); return listen(port, host, callback); };
    return server;
  } });
  t.after(() => runtime.stop());
  assert.deepEqual(bindings, [[0, '127.0.0.1']]);
  const port = runtime.server.address().port;
  assert.equal(await request(port, 'GET', '/health'), 200);
  assert.equal(await request(port, 'GET', '/webhook'), 404);
  assert.equal(await request(port, 'POST', '/webhook', '{'), 403);
  assert.equal(await request(port, 'POST', '/webhook', '{', safe.WEBHOOK_SECRET), 400);
  for (const chat of [CHAT, '-1']) {
    assert.equal(await request(port, 'POST', '/webhook', JSON.stringify({ update_type: 'message_created', message: {
      recipient: { chat_id: Number(chat) }, sender: { user_id: 456 }, body: { mid: 'offline.command', text: '/опрос' }
    } }), safe.WEBHOOK_SECRET), 503);
  }
  assert.deepEqual(max.calls, [['GET', '/me'], ['GET', `/chats/${CHAT}`], ['GET', `/chats/${CHAT}/members/me`]]);
  assert(fs.readFileSync(f.file).equals(bytes));
  await runtime.stop(); await runtime.stop();
  assert.equal(fs.existsSync(path.join(f.dir, '.lock')), false);
});
test('listener failure releases only its own lock without altering stored data', async t => {
  const f = fixture(t), max = fakeMax(), bytes = fs.readFileSync(f.file);
  await assert.rejects(startBothostTest(f.config, { fetchImpl: max.fetchImpl, createServer: () => { throw Error('offline bind failure'); } }));
  assert.equal(fs.existsSync(path.join(f.dir, '.lock')), false); assert(fs.readFileSync(f.file).equals(bytes));
});
test('hosted runtime passes precisely port 3000 and host 0.0.0.0 to its listener', async t => {
  const f = fixture(t), max = fakeMax(), bindings = [];
  const server = new (require('node:events').EventEmitter)();
  server.listen = (port, host, ready) => { bindings.push([port, host]); server.listening = true; ready(); };
  server.close = callback => { server.listening = false; callback(); };
  const runtime = await startBothostTest({ ...f.config, port: 3000, host: '0.0.0.0' }, {
    fetchImpl: max.fetchImpl, createServer: () => server
  });
  assert.deepEqual(bindings, [[3000, '0.0.0.0']]); await runtime.stop();
});
test('bundled public certificate is pinned, valid and never disables TLS verification', () => {
  const pem = fs.readFileSync(CA_PATH, 'utf8'), cert = new X509Certificate(pem);
  validateCertificate(pem); assert.throws(() => validateCertificate(pem, Date.parse(cert.validTo) + 1));
  assert.throws(() => validateCertificate(pem, Date.parse(cert.validFrom) - 1));
  assert.throws(() => validateCertificate(pem + pem)); assert.throws(() => validateCertificate('not a certificate'));
  assert(!pem.includes('PRIVATE KEY'));
});
test('entrypoint starts only a clean worker and forwards graceful shutdown; import has no effects', async () => {
  let spawns = 0, workerOptions, runtimeStarts = 0;
  const events = new Map(); const child = new (require('node:events').EventEmitter)();
  child.kill = signal => { assert.equal(signal, 'SIGTERM'); child.emit('exit', 0); };
  const sandbox = { module: { exports: {} }, __filename: path.resolve(__dirname, '../bothost-test.cjs'), console: { log() {} },
    process: { env: { ...safe, UNRELATED_SECRET: 'never inherit' }, versions: { node: process.versions.node }, argv: ['node', 'bothost-test.cjs'], execPath: process.execPath,
      on: (name, callback) => events.set(name, callback), removeListener: name => events.delete(name) } };
  sandbox.require = name => {
    if (name === 'node:child_process') return { spawn: (executable, args, options) => {
      spawns++; workerOptions = options; assert.equal(args[1], '--worker'); return child;
    } };
    if (name === './src/bothost-test-runtime') return { startBothostTest: async () => { runtimeStarts++; } };
    return require(path.resolve(__dirname, '..', name));
  };
  vm.runInNewContext(fs.readFileSync(sandbox.__filename, 'utf8'), sandbox);
  assert.equal(spawns, 0); assert.equal(runtimeStarts, 0);
  const pending = sandbox.module.exports.main();
  assert.equal(spawns, 1); assert.equal(workerOptions.env.UNRELATED_SECRET, undefined);
  assert.equal(workerOptions.env.BOT_TOKEN, undefined); assert.equal(workerOptions.env.NODE_EXTRA_CA_CERTS, CA_PATH);
  events.get('SIGTERM')(); await pending; assert.equal(sandbox.process.exitCode, 0);
});
