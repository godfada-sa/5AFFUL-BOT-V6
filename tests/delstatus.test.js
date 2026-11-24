// Deleted-status copies: keep a status, and send a copy when its owner deletes it.
// A status is kept when it arrives (media on disk, a small record for the rest) and the copy is sent to
// the owner when the poster deletes it. The copy survives a restart, goes out once, and a failed send is
// kept for a retry. The keys on disk are sha256(status id + author), exactly like the reference.
require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { dir } = require('./_setup');
const store = require('../whatsapp/store');
const names = require('../whatsapp/names');
const statusmedia = require('../whatsapp/statusmedia');
const delstatus = require('../whatsapp/delstatus');
const cmds = require('../commands/statuscmds');

const KEEP = path.join(dir, 'deleted-status');
const OWNER_CHAT = '27800000001@s.whatsapp.net';
const WHO = '27811111111@s.whatsapp.net';

const makeSock = (state = { fail: false }) => {
  const sent = [];
  const sock = {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    user: { id: '27899999999:1@s.whatsapp.net' },
    sendMessage: async (to, content) => {
      if (state.fail) throw new Error('offline');
      sent.push({ to, content });
      return { key: { id: `S${sent.length}` } };
    },
    sendReceipt: async () => {},
    readMessages: async () => {},
    sendNode: async () => {},
  };
  return { sock, sent, state };
};

const sockWith = (state = { fail: false }) => {
  const made = makeSock(state);
  delstatus.attach(made.sock);
  return made;
};

const keyOf = (id) => ({ remoteJid: 'status@broadcast', participant: WHO, id, fromMe: false });
const statusText = (id, text) => ({
  key: keyOf(id),
  message: { conversation: text },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Ama',
});
const statusImage = (id) => ({
  key: keyOf(id),
  message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 7, caption: 'Campus' } },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'Ama',
});
const arrived = async (sock, status) => {
  sock.ev.emit('messages.upsert', { messages: [status], type: 'notify' });
  await delstatus.idle();
};
const deleted = async (sock, id) => {
  sock.ev.emit('messages.update', [{ key: keyOf(id), update: { message: null, messageStubType: 1 } }]);
  await delstatus.idle();
};

const reset = () => {
  store.updateStatusCfg((s) => {
    s.deleted = false;
  });
  delstatus.clearCache();
};

test('statusdeleted: aliases, panel, and on/off always answer with the state', async () => {
  const cmd = cmds.find((c) => c.name === 'statusdeleted');
  for (const a of ['savedelstat', 'savedelstatus', 'antistatusdelete']) assert.ok(cmd.aliases.includes(a), a);

  reset();
  const out = [];
  const run = (rest) => cmd.run({ args: rest ? [rest] : [], rest, reply: async (t) => out.push(t), prefix: '.' });

  await run('');
  assert.match(out.at(-1), /Deleted status copies:\* OFF/);
  assert.match(out.at(-1), /Kept right now: 0 statuses/);
  assert.match(out.at(-1), /first sudo/);

  await run('on');
  assert.match(out.at(-1), /are ON/);
  assert.match(out.at(-1), /24 hours/);
  assert.match(out.at(-1), /restart does not lose them/);
  assert.strictEqual(store.statusCfg().deleted, true);

  await run('');
  assert.match(out.at(-1), /Deleted status copies:\* ON/);

  await run('off');
  assert.match(out.at(-1), /are OFF/);
  assert.strictEqual(store.statusCfg().deleted, false);
});

test('a text status is copied once when it is deleted, with the saved name', async () => {
  reset();
  delstatus.setEnabled(true);
  names.remember(WHO, 'Ama Mensah');
  const { sock, sent } = sockWith();

  await arrived(sock, statusText('D1', 'Good morning friends'));
  assert.strictEqual(sent.length, 0, 'nothing is sent while the status is still up');
  assert.strictEqual(delstatus.keptCount(), 1);

  await deleted(sock, 'D1');
  assert.strictEqual(sent.length, 1, 'one copy goes out');
  assert.strictEqual(sent[0].to, OWNER_CHAT);
  assert.match(sent[0].content.text, /^Deleted status from Ama Mensah/);
  assert.match(sent[0].content.text, /Good morning friends/);

  await deleted(sock, 'D1');
  assert.strictEqual(sent.length, 1, 'the same delete notice twice sends only one copy');
  assert.strictEqual(delstatus.keptCount(), 0);
  assert.strictEqual(fs.readdirSync(KEEP).length, 0, 'the record and its media are removed after the copy went out');
});

test('a status deleted through a protocol message is copied too', async () => {
  reset();
  delstatus.setEnabled(true);
  const { sock, sent } = sockWith();

  await arrived(sock, statusText('D2', 'the second one'));
  await arrived(sock, { key: keyOf('D2'), message: { protocolMessage: { type: 0, key: keyOf('D2') } } });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].content.text, /the second one/);
});

test('a kept status survives a restart: the record and the media are on disk', async () => {
  reset();
  delstatus.setEnabled(true);
  const first = sockWith();
  await arrived(first.sock, statusText('D3', 'still here after a restart'));
  assert.strictEqual(delstatus.keptCount(), 1);

  delete require.cache[require.resolve('../whatsapp/delstatus')];
  const restarted = require('../whatsapp/delstatus');
  assert.strictEqual(restarted.keptCount(), 1, 'the new process loaded the kept status');

  const second = makeSock();
  restarted.attach(second.sock);
  second.sock.ev.emit('messages.update', [{ key: keyOf('D3'), update: { message: null, messageStubType: 'REVOKE' } }]);
  await restarted.idle();
  assert.strictEqual(second.sent.length, 1);
  assert.match(second.sent[0].content.text, /still here after a restart/);
  assert.strictEqual(restarted.keptCount(), 0);
});

test('a picture status is kept on disk and sent as a picture', async () => {
  reset();
  delstatus.setEnabled(true);
  const original = statusmedia.download;
  statusmedia.download = async () => Buffer.from('PICTURE');
  const { sock, sent } = sockWith();
  try {
    await arrived(sock, statusImage('D4'));
    assert.strictEqual(delstatus.keptCount(), 1);
    const files = fs.readdirSync(KEEP);
    assert.strictEqual(files.filter((f) => f.endsWith('.json')).length, 1, 'the record is on disk');
    assert.strictEqual(files.filter((f) => f.endsWith('.bin')).length, 1, 'the picture is on disk');

    await deleted(sock, 'D4');
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].content.image, Buffer.from('PICTURE'));
    assert.match(sent[0].content.caption, /^Deleted status from/);
    assert.match(sent[0].content.caption, /Campus/);
    assert.strictEqual(fs.readdirSync(KEEP).length, 0, 'the picture is removed after it went out');
  } finally {
    statusmedia.download = original;
  }
});

test('a failed send keeps the copy, and the next delete notice tries again', async () => {
  reset();
  delstatus.setEnabled(true);
  const { sock, sent, state } = sockWith({ fail: true });
  await arrived(sock, statusText('D5', 'send me again'));
  await deleted(sock, 'D5');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(delstatus.keptCount(), 1, 'the copy was not thrown away');

  state.fail = false;
  await deleted(sock, 'D5');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].content.text, /send me again/);
  assert.strictEqual(delstatus.keptCount(), 0);
});

test('statusdeleted off clears the kept statuses from the disk', async () => {
  reset();
  delstatus.setEnabled(true);
  const { sock } = sockWith();
  await arrived(sock, statusText('D6', 'clear me'));
  assert.strictEqual(delstatus.keptCount(), 1);
  assert.ok(fs.existsSync(KEEP));

  const cmd = cmds.find((c) => c.name === 'statusdeleted');
  const out = [];
  await cmd.run({ args: ['off'], rest: 'off', reply: async (t) => out.push(t), prefix: '.' });
  assert.match(out.at(-1), /cleared/);
  assert.strictEqual(delstatus.keptCount(), 0);
  assert.ok(!fs.existsSync(KEEP), 'the cache folder is gone');
});

test('nothing is kept or copied while statusdeleted is off', async () => {
  reset();
  const { sock, sent } = sockWith();
  await arrived(sock, statusText('D7', 'off please'));
  assert.strictEqual(delstatus.keptCount(), 0);
  await deleted(sock, 'D7');
  assert.strictEqual(sent.length, 0);
});
