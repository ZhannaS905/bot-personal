const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
function createWebhook(service, secret, {log=()=>{}}={}) {
  const note=reason=>log({event:'training_test_webhook',reason});
  return http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers['x-max-bot-api-secret'] || '');
    const expected = Buffer.from(secret);
    if (req.method !== 'POST' || req.url !== '/webhook') { note('route_rejected'); res.writeHead(404).end(); return; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { note('secret_rejected'); res.writeHead(403).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { note('body_limit'); res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let update;
      try { update = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { note('json_rejected'); res.writeHead(400).end(); return; }
      // Await serialized handling, including durable reservation for manual publication.
      note('accepted');
      await service.receive(update);
      note('processed');
      res.writeHead(200).end();
    } catch (error) {
      const allowed = ['resource-exhausted', 'permission-denied', 'unavailable',
        'deadline-exceeded', 'failed-precondition', 'aborted'];
      const code = allowed.includes(error?.code) ? error.code : 'UNKNOWN';
      note('handler_failed_' + code);
      res.writeHead(503).end();
    }
  });
}
module.exports = { createWebhook };
