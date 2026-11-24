// Silent tags (5AFFUL style) and the status auto-view command.
// The tag commands must NEVER echo text back: everybody is notified through the
// mentions, the body stays invisible. The autostatus command must always answer,
// so the owner can see that it took the 1-10 minute delay.
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../whatsapp/store');
const cmds = require('../commands/statuscmds');
const tags = require('../commands/hidetag');
const autoview = require('../whatsapp/autoview');
const EventEmitter = require('events');

const GROUP = '120363000000000181@g.us';
const ADMIN = '27800000001@s.whatsapp.net';
const MEMBER = '27811111111@s.whatsapp.net';
const OTHER = '27822222222@s.whatsapp.net';
const meta = {
  participants: [
    { id: ADMIN, admin: 'superadmin' },
    { id: '27899999999@s.whatsapp.net', admin: 'admin' },
    { id: MEMBER },
    { id: OTHER },
  ],
};

const runTag = async (name, extra = {}) => {
  const sent = [];
  const replies = [];
  const cmd = tags.find((c) => c.name === name);
  await cmd.run({
    sock: { sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); return { key: { id: 'T1' } }; } },
    jid: GROUP, msg: { key: { remoteJid: GROUP, id: 'Q1' } }, reply: async (t) => replies.push(t),
    prefix: '.', cmdName: name, groupMetadata: meta, isGroup: true, args: [], rest: '',
    ...extra,
  });
  return { sent, replies };
};

const mentioned = (m) => [...m.content.mentions].map((j) => j.split('@')[0]).sort();

test('silent tags: three commands, all for group admins', () => {
  assert.deepStrictEqual(tags.map((c) => c.name), ['hidetag', 'tagadmin', 'tagnotadmin']);
  assert.deepStrictEqual(tags[0].aliases, ['tag']);
  assert.deepStrictEqual(tags[2].aliases, ['tagmembers', 'tagallmembers']);
  for (const c of tags) {
    assert.strictEqual(c.category, 'group');
    assert.strictEqual(c.groupOnly, true);
    assert.strictEqual(c.adminOnly, true);
  }
});

test('.tag tags everybody and prints nothing: the typed text is never echoed', async () => {
  const { sent, replies } = await runTag('hidetag', { args: ['meeting', 'at', '8'], rest: 'meeting at 8' });
  assert.strictEqual(replies.length, 0, 'a tag is silent: no confirmation message');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].jid, GROUP);
  assert.deepStrictEqual(mentioned(sent[0]), ['27800000001', '27811111111', '27822222222', '27899999999']);
  assert.ok(!/meeting|hello/i.test(sent[0].content.text), 'the text typed after the command is not repeated');
  assert.strictEqual(sent[0].content.text, '\u200b', 'the body is invisible, only the mentions carry the notification');
  assert.ok(!sent[0].opts, 'nothing is quoted');
});

test('.tag does not reprint the message it answers', async () => {
  const msg = {
    key: { remoteJid: GROUP, id: 'Q2' },
    message: { extendedTextMessage: { text: '.tag', contextInfo: { stanzaId: 'Q1', participant: OTHER, quotedMessage: { conversation: 'a long message body' } } } },
  };
  const { sent } = await runTag('hidetag', { msg });
  assert.strictEqual(sent.length, 1);
  assert.ok(!/long message body/.test(sent[0].content.text), 'the quoted body stays where it is');
});

test('.tagadmin and .tagnotadmin tag the right people', async () => {
  const admin = await runTag('tagadmin');
  assert.deepStrictEqual(mentioned(admin.sent[0]), ['27800000001', '27899999999']);
  const rest = await runTag('tagnotadmin');
  assert.deepStrictEqual(mentioned(rest.sent[0]), ['27811111111', '27822222222']);
});

test('a group with no members loads nothing: the owner is told instead of an empty tag', async () => {
  const { sent, replies } = await runTag('hidetag', { groupMetadata: { participants: [] } });
  assert.strictEqual(sent.length, 0);
  assert.match(replies[0], /could not load the group members/);
});

// ---- autostatus (the same command as autoviewstatus)
const runStatus = async (rest) => {
  const out = [];
  const cmd = cmds.find((c) => c.name === 'autoviewstatus');
  await cmd.run({ args: rest ? rest.split(/\s+/) : [], rest, reply: async (t) => out.push(t), prefix: '.', cmdName: 'autostatus' });
  return out.join('\n');
};

test('autostatus is the same command as autoviewstatus', () => {
  const cmd = cmds.find((c) => c.name === 'autoviewstatus');
  for (const a of ['autostatus', 'autoview', 'autostatusview', 'viewstatus', 'statusview']) assert.ok(cmd.aliases.includes(a), a);
});

test('autostatus 1-10 sets the delay and always answers', async () => {
  store.updateStatusCfg((s) => { s.view = false; s.viewDelayMin = 0; });
  const answer = await runStatus('5');
  assert.match(answer, /Auto view status is ON/);
  assert.match(answer, /5 minutes after it arrives/);
  assert.strictEqual(store.statusCfg().view, true);
  assert.strictEqual(store.statusCfg().viewDelayMin, 5);

  const panel = await runStatus('');
  assert.match(panel, /Auto view status: ON \(5-minute delay\)/);
  assert.match(panel, /autostatus 5/);

  await runStatus('off');
  assert.strictEqual(store.statusCfg().view, false);
  assert.strictEqual(store.statusCfg().viewDelayMin, 0);
});

test('autostatus refuses 0 and 11 and says what to use', async () => {
  const answer = await runStatus('11');
  assert.match(answer, /between 1 and 10/);
  assert.match(await runStatus('0'), /between 1 and 10/);
  assert.strictEqual(store.statusCfg().viewDelayMin, 0);
});

// ---- the status receipt itself: a plain "read" receipt does not show a view, class="status" does
const viewSock = () => {
  const receipts = [];
  const nodes = [];
  const updates = [];
  const sock = {
    ev: new EventEmitter(),
    ws: { isOpen: true },
    user: { id: '27899999999:1@s.whatsapp.net' },
    sendReceipt: async (jid, who, ids, type) => receipts.push({ jid, who, ids, type }),
    sendNode: async (node) => nodes.push(node),
    readMessages: async () => {},
  };
  sock.ev.on('messages.update', (list) => updates.push(...list));
  autoview.attach(sock);
  return { sock, receipts, nodes, updates };
};

test('autostatus: the view is the native receipt with class="status" and the author as participant', async () => {
  const { sock, receipts, nodes, updates } = viewSock();
  const key = { remoteJid: 'status@broadcast', participant: '27833333333@s.whatsapp.net', id: 'AV1', fromMe: false };
  await autoview.markSeen(sock, key, {});
  assert.ok(receipts.some((r) => r.type === 'read' && r.jid === 'status@broadcast' && r.ids[0] === 'AV1'), 'the poster gets the read receipt');
  assert.strictEqual(nodes.length, 1);
  assert.deepStrictEqual(nodes[0], {
    tag: 'receipt',
    attrs: { id: 'AV1', type: 'read', class: 'status', to: 'status@broadcast', participant: '27833333333@s.whatsapp.net' },
  });
  assert.strictEqual(updates[0].update.statusAlreadyViewed, true, 'the bot store notes the view');
});

test('autostatus: a status arriving in instant mode is viewed at once', async () => {
  store.updateStatusCfg((s) => { s.view = true; s.viewDelayMin = 0; });
  const { sock, nodes } = viewSock();
  autoview.onMessages({ messages: [{ key: { remoteJid: 'status@broadcast', participant: '27844444444@s.whatsapp.net', id: 'AV2', fromMe: false } }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].attrs.id, 'AV2');
});

test('autostatus 5: the view waits five minutes, and off clears what is waiting', async () => {
  store.updateStatusCfg((s) => { s.view = true; s.viewDelayMin = 5; });
  autoview._pending.clear();
  const { sock } = viewSock();
  autoview.onMessages({ messages: [{ key: { remoteJid: 'status@broadcast', participant: '27855555555@s.whatsapp.net', id: 'AV3', fromMe: false } }] });
  const entry = autoview._pending.get('AV3');
  assert.ok(entry, 'the view is waiting');
  const wait = entry.dueAt - entry.queuedAt;
  assert.ok(wait >= 5 * 60000 - 1000 && wait <= 5 * 60000 + 1000, `about five minutes (${wait} ms)`);

  await runStatus('off');
  assert.strictEqual(autoview._pending.size, 0, 'switching off drops the waiting views');
  assert.strictEqual(autoview.mode(), 'off');
  void sock;
});

test('autostatus: the bot never views its own status or the owner\'s', async () => {
  store.updateStatusCfg((s) => { s.view = true; s.viewDelayMin = 0; });
  autoview._pending.clear();
  const { sock, nodes } = viewSock();
  autoview.onMessages({ messages: [
    { key: { remoteJid: 'status@broadcast', participant: '27899999999@s.whatsapp.net', id: 'AV4' } },
    { key: { remoteJid: 'status@broadcast', participant: '27800000001@s.whatsapp.net', id: 'AV5' } },
  ] });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(nodes.length, 0);
  assert.strictEqual(autoview._pending.size, 0);
  void sock;
});
