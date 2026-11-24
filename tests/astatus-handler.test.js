'use strict';

// .astatus through the real message handler: the owner switches it on, a stranger
// replies to the owner's status with "send", and the status leaves in that chat —
// with the private message blocker stepping aside.

require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const baileys = require('../core/baileys');
const store = require('../whatsapp/store');
const media = require('../whatsapp/media');
const handler = require('../whatsapp/handler');
const statusask = require('../whatsapp/statusask');

baileys.setForTests({});
const logs = [];
const realLog = console.log;
const realErr = console.error;
console.log = () => {};
console.error = () => {};

const OWNER = '27800000001@s.whatsapp.net';
const ASKER = '2348000000001@s.whatsapp.net';
const OWNER_LID = '199988877766655@lid';

const sent = [];
let blocked = [];
const sock = {
  user: { id: '27800000001:1@s.whatsapp.net', lid: OWNER_LID },
  sendMessage: async (j, c) => {
    sent.push({ j, c });
    return { key: { id: `K${sent.length}` } };
  },
  sendPresenceUpdate: async () => {},
  presenceSubscribe: async () => {},
  readMessages: async () => {},
  updateProfileStatus: async () => {},
  updateBlockStatus: async (j, a) => {
    blocked.push({ j, a });
  },
  groupMetadata: async (j) => ({ id: j, subject: 'G', participants: [] }),
  groupFetchAllParticipating: async () => ({}),
};

let n = 0;
const now = () => Math.floor(Date.now() / 1000);
const dm = (text) => ({ key: { remoteJid: OWNER, id: `D${++n}`, fromMe: false }, message: { conversation: text }, messageTimestamp: now() });
// a reply written in ASKER's chat to the owner's status
const statusReply = (text, opts = {}) => ({
  key: { remoteJid: opts.jid || ASKER, id: `S${++n}`, fromMe: false },
  message: {
    extendedTextMessage: {
      text,
      contextInfo: {
        remoteJid: 'status@broadcast',
        stanzaId: opts.statusId || 'ST1',
        participant: opts.participant || OWNER,
        quotedMessage: opts.quoted || { imageMessage: { url: 'https://mmg.whatsapp.net/x', mediaKey: 'k', caption: 'my photo' } },
      },
    },
  },
  messageTimestamp: now(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 800) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

async function say(msg) {
  const before = sent.length;
  await handler.handleMessage(sock, msg);
  await handler.idle();
  return sent.slice(before);
}

const P = () => store.effectivePrefix();

test('astatus e2e: owner turns it on, the stranger reply gets the status, the blocker stays quiet', async () => {
  media.download = async () => Buffer.from('jpeg-bytes'); // the network is the only thing that is faked
  store.updateStatusCfg((s) => {
    s.askSend = false;
  });
  store.setAuto('pm', 'block'); // the strictest private message mode
  statusask.done.clear();
  blocked = [];

  const on = await say(dm(`${P()}astatus on`));
  assert.ok(on.some((x) => x.c.text && /Send on ask is ON/.test(x.c.text)), 'the owner is told it is on');

  const before = sent.length;
  await handler.handleMessage(sock, statusReply('send'));
  await waitFor(() => sent.length > before, 1500);
  const out = sent.slice(before);

  const toAsker = out.filter((x) => x.j === ASKER);
  assert.strictEqual(toAsker.length, 1, 'exactly one message goes to the asker');
  assert.ok(Buffer.isBuffer(toAsker[0].c.image), 'the photo status is sent as a photo');
  assert.match(toAsker[0].c.caption, /Status/, 'it carries the status header');
  assert.match(toAsker[0].c.caption, /my photo/, 'and the caption of the status');
  assert.deepStrictEqual(toAsker[0].c.mentions, [], 'no stray mention');
  assert.ok(!out.some((x) => /does not answer private messages/.test(x.c.text || '')), 'the private message notice never fires');
  assert.deepStrictEqual(blocked, [], 'nobody is blocked');

  const quiet = await say(dm(`${P()}astatus off`));
  assert.ok(quiet.some((x) => x.c.text && /Send on ask is OFF/.test(x.c.text)), 'the owner is told it is off');

  const mark = sent.length;
  await handler.handleMessage(sock, statusReply('send', { statusId: 'ST2' }));
  await sleep(200);
  assert.strictEqual(sent.length, mark, 'switched off, nothing is sent');
});

test('astatus e2e: a reply that does not ask is left alone, and a second ask is not repeated', async () => {
  media.download = async () => Buffer.from('jpeg-bytes');
  store.updateStatusCfg((s) => {
    s.askSend = true;
  });
  statusask.done.clear();

  const mark = sent.length;
  await handler.handleMessage(sock, statusReply('wow nice', { statusId: 'ST3' }));
  await sleep(150);
  assert.strictEqual(sent.length, mark, 'no "send" in the text, nothing is sent');

  await handler.handleMessage(sock, statusReply('send', { statusId: 'ST4' }));
  await waitFor(() => sent.length > mark, 1500);
  const first = sent.length;
  assert.strictEqual(first, mark + 1, 'the ask is answered');

  await handler.handleMessage(sock, statusReply('send it', { statusId: 'ST4' }));
  await sleep(200);
  assert.strictEqual(sent.length, first, 'the same status is not sent twice to the same person');

  store.updateStatusCfg((s) => {
    s.askSend = false;
  });
  console.log = realLog;
  console.error = realErr;
  void logs;
});
