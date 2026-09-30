import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createEmailDelivery } from '../cloud-skill-platform/lib/email-delivery.mjs';

assert.equal(createEmailDelivery({}).configured, false);
let accepted; let disconnected;
const acceptedPromise = new Promise((done) => { accepted = done; });
const disconnectedPromise = new Promise((done) => { disconnected = done; });
const connections = new Set();
const server = createServer((socket) => {
  connections.add(socket); accepted();
  socket.on('data', () => {}); // Deliberately never completes TLS. No SMTP auth is sent.
  socket.on('error', () => {});
  socket.on('close', () => { connections.delete(socket); disconnected(); });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const delivery = createEmailDelivery({ SHENSI_CLOUD_SMTP_USER: 'fixture@example.test', SHENSI_CLOUD_SMTP_PASSWORD: 'isolated-smtp-not-a-real-secret',
  SHENSI_CLOUD_SMTP_HOST: '127.0.0.1', SHENSI_CLOUD_SMTP_PORT: String(server.address().port), SHENSI_CLOUD_SMTP_FROM_NAME: '神思' });
let timer;
try {
  assert.equal(delivery.configured, true);
  const abort = new AbortController();
  const send = delivery.send({ to: 'fixture@example.test', code: '123456', purpose: 'login', signal: abort.signal });
  const rejected = assert.rejects(send, /cancelled|closed/);
  await Promise.race([acceptedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local SMTP connection missing')), 3000); })]);
  clearTimeout(timer); const started = Date.now(); abort.abort();
  await rejected;
  await Promise.race([disconnectedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SMTP socket was not closed')), 1000); })]);
  assert.ok(Date.now() - started < 1000, 'Cancellation really closes the TLS socket');
  console.log('SMTP adapter: pinned Nodemailer loads; TLS connection abort closes socket promptly PASS (loopback only, zero mail).');
} finally {
  clearTimeout(timer); delivery.close(); for (const connection of connections) connection.destroy();
  await new Promise((done) => server.close(done));
}
