'use strict';

// The notification guard: no global "available", no read receipts in private
// chats, and "unavailable" re-asserted while the socket is open.

const test = require('node:test');
const assert = require('node:assert');
const notifications = require('../whatsapp/notifications');

function fakeSocket() {
  const handlers = new Map();
  const sock = {
    sent: [],
    receipts: [],
    reads: [],
    ev: {
      on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
      },
    },
    readMessages(keys) {
      sock.reads.push(keys);
      return Promise.resolve();
    },
    sendReceipts(keys, type) {
      sock.receipts.push({ keys, type });
      return Promise.resolve();
    },
    sendReceipt(jid, participant, ids, type) {
      sock.receipts.push({ jid, participant, ids, type });
      return Promise.resolve();
    },
    sendPresenceUpdate(type, jid) {
      sock.sent.push({ type, jid });
      return Promise.resolve();
    },
    fire(name, payload) {
      for (const fn of handlers.get(name) || []) fn(payload);
    },
  };
  return sock;
}

const DM = { remoteJid: '27821234567@s.whatsapp.net', id: 'AAA' };
const LID = { remoteJid: '1234567890@lid', id: 'BBB' };
const GROUP = { remoteJid: '120363000000000000@g.us', id: 'CCC' };

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('read receipts are dropped for private chats and kept for groups', async () => {
  const sock = notifications.attach(fakeSocket());

  await sock.readMessages([DM, GROUP]);
  assert.deepStrictEqual(sock.reads[0], [GROUP], 'only the group is marked read');

  await sock.readMessages([DM, LID]);
  assert.strictEqual(sock.reads.length, 1, 'nothing to send when every chat is private');

  await sock.sendReceipts([DM, GROUP], 'read');
  assert.deepStrictEqual(sock.receipts[0].keys, [GROUP]);

  // delivery receipts are not read receipts: they pass through untouched
  await sock.sendReceipts([DM], 'delivery');
  assert.deepStrictEqual(sock.receipts[1].keys, [DM]);

  await sock.sendReceipt(DM.remoteJid, undefined, ['AAA'], 'read');
  assert.strictEqual(sock.receipts.length, 2, 'the single-chat read receipt never leaves');

  // a status view addresses the sender with status@broadcast as participant
  await sock.sendReceipt(DM.remoteJid, 'status@broadcast', ['AAA'], 'read');
  assert.strictEqual(sock.receipts.length, 3, 'status auto-view still works');
});

test('a global "available" becomes "unavailable", per-chat presence is untouched', async () => {
  const sock = notifications.attach(fakeSocket());

  await sock.sendPresenceUpdate('available');
  assert.deepStrictEqual(sock.sent.pop(), { type: 'unavailable', jid: undefined });

  await sock.sendPresenceUpdate('composing', DM.remoteJid);
  assert.deepStrictEqual(sock.sent.pop(), { type: 'composing', jid: DM.remoteJid });

  await sock.sendPresenceUpdate('paused', DM.remoteJid);
  assert.deepStrictEqual(sock.sent.pop(), { type: 'paused', jid: DM.remoteJid });
});

test('it goes offline on connect and keeps saying so', async () => {
  const sock = notifications.attach(fakeSocket());

  sock.fire('connection.update', { connection: 'open' });
  await tick();
  assert.deepStrictEqual(sock.sent, [{ type: 'unavailable', jid: undefined }]);

  // WhatsApp reporting the device as online gets corrected
  sock.fire('connection.update', { isOnline: true });
  await tick();
  assert.strictEqual(sock.sent.length, 2);

  // the profile name arriving after linking (presence is ignored until it does)
  sock.fire('creds.update', { me: { name: '5AFFUL' } });
  await tick();
  assert.strictEqual(sock.sent.length, 3);

  // a closed socket is left alone
  sock.fire('connection.update', { connection: 'close' });
  sock.fire('connection.update', { isOnline: true });
  await tick();
  assert.strictEqual(sock.sent.length, 3);
});

test('the typing indicator may go online inside its window, and only there', async () => {
  const sock = notifications.attach(fakeSocket());

  notifications.typingWindow(true);
  try {
    await sock.sendPresenceUpdate('available');
    assert.deepStrictEqual(sock.sent.pop(), { type: 'available', jid: undefined }, 'the indicator needs the device online');
    notifications.typingWindow(true); // two indicators at once
  } finally {
    notifications.typingWindow(false);
  }
  assert.strictEqual(notifications.typingNow(), true, 'still one open');

  await sock.sendPresenceUpdate('available');
  assert.deepStrictEqual(sock.sent.pop(), { type: 'available', jid: undefined });

  notifications.typingWindow(false);
  assert.strictEqual(notifications.typingNow(), false);

  await sock.sendPresenceUpdate('available');
  assert.deepStrictEqual(sock.sent.pop(), { type: 'unavailable', jid: undefined }, 'back to offline');

  // a stray close never goes negative
  notifications.typingWindow(false);
  assert.strictEqual(notifications.typingNow(), false);
});

test('SAFFUL_PRESERVE_DM_NOTIFICATIONS=false leaves the socket alone', async () => {
  const before = process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS;
  process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS = 'false';
  try {
    const sock = fakeSocket();
    const read = sock.readMessages;
    notifications.attach(sock);
    assert.strictEqual(sock.readMessages, read, 'nothing was wrapped');
    assert.strictEqual(sock.__saffulNotificationGuard, undefined);
  } finally {
    if (before === undefined) delete process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS;
    else process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS = before;
  }
});

test('the re-assert interval honours the env and never goes below 30s', () => {
  const before = process.env.SAFFUL_PRESENCE_REASSERT_MS;
  try {
    process.env.SAFFUL_PRESENCE_REASSERT_MS = '5000';
    assert.strictEqual(notifications.period(), 30000);
    process.env.SAFFUL_PRESENCE_REASSERT_MS = '120000';
    assert.strictEqual(notifications.period(), 120000);
    delete process.env.SAFFUL_PRESENCE_REASSERT_MS;
    assert.strictEqual(notifications.period(), 60000);
  } finally {
    if (before === undefined) delete process.env.SAFFUL_PRESENCE_REASSERT_MS;
    else process.env.SAFFUL_PRESENCE_REASSERT_MS = before;
  }
});
