// autoviewoncereply: a view-once is copied to the owner's chat when somebody replies
// to it with any message, or reacts to it with any emoji (not only when "vv" is typed)
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const baileys = require('../core/baileys');
const store = require('../whatsapp/store');
const handler = require('../whatsapp/handler');
const watchers = require('../whatsapp/watchers');
const cmds = require('../commands/watchcmds');

baileys.setForTests({ downloadMediaMessage: async (m) => Buffer.from(`FILE-${m.key.id}`) });

const OWNER_CHAT = '27800000001@s.whatsapp.net'; // tests/_setup.js sets the owner number
const FRIEND = '27833333333@s.whatsapp.net';
const GROUP = '120363000000000123@g.us';
const FULL = { mediaKey: 'k', url: 'https://x', directPath: '/d', mimetype: 'image/jpeg', caption: 'look' };

let sent;
const mkSock = (extra = {}) => {
  sent = [];
  return {
    user: { id: '27899999999:1@s.whatsapp.net' },
    sendMessage: async (j, c) => { sent.push({ j, c }); return { key: { id: `K${sent.length}` } }; },
    groupMetadata: async () => ({ subject: 'G', participants: [] }),
    requestPlaceholderResend: async () => {},
    ...extra,
  };
};
const settle = async () => { await handler.idle(); await new Promise((r) => setTimeout(r, 120)); };
const copies = () => sent.filter((s) => s.c.image);
const once = (id, node, extra = {}) => ({
  key: { remoteJid: FRIEND, id, fromMe: false, ...extra },
  message: { viewOnceMessageV2: { message: { imageMessage: node } } },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Ada',
});
const replyTo = (id, target, text = 'nice one') => ({
  key: { remoteJid: FRIEND, id, fromMe: false },
  message: {
    extendedTextMessage: {
      text,
      contextInfo: {
        stanzaId: target,
        participant: FRIEND,
        quotedMessage: { viewOnceMessageV2: { message: { imageMessage: FULL } } },
      },
    },
  },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Ada',
});
const reactTo = (id, target, text = '🔥') => ({
  key: { remoteJid: FRIEND, id, fromMe: false },
  message: { reactionMessage: { key: { remoteJid: FRIEND, id: target, fromMe: false, participant: FRIEND }, text, senderTimestampMs: Date.now() } },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Ada',
});

const cmd = cmds.find((c) => c.name === 'autoviewoncereply');
const run = async (args) => {
  const out = [];
  await cmd.run({ args, prefix: '.', sock: {}, jid: FRIEND, reply: async (t) => out.push(t) });
  return out.join('\n');
};
const on = () => store.updateWatch('viewonce', (w) => { w.reply = true; });
const off = () => store.updateWatch('viewonce', (w) => { w.reply = false; });

test('autoviewoncereply: it is off by default, owner only, and the panel explains both ways', async () => {
  store.updateWatch('viewonce', (w) => { w.reply = false; });
  assert.strictEqual(store.watchCfg('viewonce').reply, false, 'off until the owner switches it on');
  assert.strictEqual(cmd.ownerOnly, true);
  assert.deepStrictEqual(cmd.aliases, ['autovvreply', 'voreply']);

  const text = await run([]);
  assert.match(text, /is \*OFF\*/);
  assert.match(text, /autoviewoncereply on/);
  assert.match(text, /autoviewoncereply off/);
});

test('autoviewoncereply: on and off change the setting and say so', async () => {
  const onText = await run(['on']);
  assert.match(onText, /now ON/);
  assert.strictEqual(store.watchCfg('viewonce').reply, true);

  const offText = await run(['off']);
  assert.match(offText, /now OFF/);
  assert.strictEqual(store.watchCfg('viewonce').reply, false);

  const other = await run(['banana']);
  assert.match(other, /is \*OFF\*/, 'a word that is neither on nor off shows the panel');
  assert.strictEqual(store.watchCfg('viewonce').reply, false, 'and changes nothing');
});

test('autoviewoncereply: a reply with any text copies the view-once to the owner chat', async () => {
  store.setCmdReact('off');
  off();
  store.updateWatch('viewonce', (w) => { w.mode = 'off'; });
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, replyTo('A1', 'VO1'));
  await settle();
  assert.strictEqual(copies().length, 1);
  assert.strictEqual(copies()[0].j, OWNER_CHAT);
  assert.match(copies()[0].c.caption, /View-once picture/);
  assert.match(copies()[0].c.caption, /replied to/);
  assert.match(copies()[0].c.caption, /look/);
  assert.strictEqual(copies()[0].c.image.toString(), 'FILE-VO1');
});

test('autoviewoncereply: a reply to something that is not a view-once does nothing', async () => {
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, {
    key: { remoteJid: FRIEND, id: 'A2', fromMe: false },
    message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'TXT1', participant: FRIEND, quotedMessage: { conversation: 'hello there' } } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  await settle();
  assert.strictEqual(copies().length, 0);
});

test('autoviewoncereply: a reaction on a view-once the bot kept copies it too', async () => {
  store.updateWatch('viewonce', (w) => { w.mode = 'off'; });
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, once('VO2', FULL)); // arrives, kept, no automatic copy (mode off)
  await settle();
  assert.strictEqual(copies().length, 0, 'nothing is copied just because it arrived');
  assert.ok(watchers.recentViewOnce('VO2'), 'the file is kept for a reply or a reaction');

  await handler.handleMessage(sock, reactTo('A3', 'VO2', '🔥'));
  await settle();
  assert.strictEqual(copies().length, 1);
  assert.strictEqual(copies()[0].j, OWNER_CHAT);
  assert.match(copies()[0].c.caption, /reacted to/);
  assert.strictEqual(copies()[0].c.image.toString(), 'FILE-VO2');
});

test('autoviewoncereply: taking a reaction back is not a request', async () => {
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, reactTo('A4', 'VO2', ''));
  await settle();
  assert.strictEqual(copies().length, 0);
});

test('autoviewoncereply: one copy per view-once, however many replies and reactions it gets', async () => {
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, replyTo('A5', 'VO3', 'first'));
  await settle();
  await handler.handleMessage(sock, replyTo('A6', 'VO3', 'second'));
  await handler.handleMessage(sock, reactTo('A7', 'VO3', '❤️'));
  await settle();
  assert.strictEqual(copies().length, 1);
});

test('autoviewoncereply: switched off, a reply copies nothing', async () => {
  off();
  const sock = mkSock();
  await handler.handleMessage(sock, replyTo('A8', 'VO4'));
  await settle();
  assert.strictEqual(copies().length, 0);
});

test('autoviewoncereply: a group reply is copied with the group name', async () => {
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, {
    key: { remoteJid: GROUP, id: 'A9', fromMe: false, participant: FRIEND },
    message: { extendedTextMessage: { text: 'wow', contextInfo: { stanzaId: 'VO5', participant: FRIEND, quotedMessage: { viewOnceMessageV2: { message: { imageMessage: FULL } } } } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Ada',
  });
  await settle();
  assert.strictEqual(copies().length, 1);
  assert.strictEqual(copies()[0].j, OWNER_CHAT, 'the copy goes to the owner, not into the group');
  assert.match(copies()[0].c.caption, /the group "G"/);
  assert.match(copies()[0].c.caption, /@27833333333/);
});

test('autoviewoncereply: a quoted copy without the file asks the phone once, and the file is copied when it arrives', async () => {
  on();
  const asked = [];
  const sock = mkSock({ requestPlaceholderResend: async (key) => { asked.push(key.id); } });
  await handler.handleMessage(sock, {
    key: { remoteJid: FRIEND, id: 'A10', fromMe: false },
    message: { extendedTextMessage: { text: 'open it', contextInfo: { stanzaId: 'VO6', participant: FRIEND, quotedMessage: { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true } } } } } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  await settle();
  assert.deepStrictEqual(asked, ['VO6'], 'the phone was asked for that message');
  assert.strictEqual(copies().length, 0, 'nothing to copy yet');

  await handler.handleMessage(sock, once('VO6', FULL)); // the phone sends the real file
  await settle();
  assert.strictEqual(copies().length, 1, 'the file was copied when it arrived');
  assert.strictEqual(copies()[0].c.image.toString(), 'FILE-VO6');
});

test('autoviewoncereply: replying with vv (or a heart) is the manual way, so the watcher adds no second copy', async () => {
  on();
  const sock = mkSock();
  const base = { key: { remoteJid: FRIEND, id: 'A12', fromMe: true } };
  const quoted = { contextInfo: { stanzaId: 'VO8', participant: FRIEND, quotedMessage: { viewOnceMessageV2: { message: { imageMessage: FULL } } } } };
  await watchers.viewOnceReply(sock, { ...base, message: { extendedTextMessage: { text: '.vv', ...quoted } } });
  await watchers.viewOnceReply(sock, { ...base, key: { ...base.key, id: 'A13' }, message: { extendedTextMessage: { text: '❤️', ...quoted } } });
  await settle();
  assert.strictEqual(copies().length, 0, 'vv and the heart already send the file themselves');
});

test('autoviewoncereply: the automatic copy still wins; a reply after it does not send a second file', async () => {
  store.updateWatch('viewonce', (w) => { w.mode = 'all'; });
  on();
  const sock = mkSock();
  await handler.handleMessage(sock, once('VO7', FULL));
  await settle();
  assert.strictEqual(copies().length, 1, 'the automatic copy arrived');
  await handler.handleMessage(sock, replyTo('A11', 'VO7'));
  await settle();
  assert.strictEqual(copies().length, 1, 'and the reply did not duplicate it');
  store.updateWatch('viewonce', (w) => { w.mode = 'off'; });
});
