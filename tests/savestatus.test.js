'use strict';

// .save: reply to a status and only that status is kept (5AFFUL's command name for this).

require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../whatsapp/store');
const statusreply = require('../whatsapp/statusreply');
const engine = require('../whatsapp/status');
const { ownerChat } = require('../whatsapp/owner');
const commands = require('../commands/statuscmds');

const cmd = commands.find((c) => c.name === 'save');
const OWNER = { id: '27899999999:1@s.whatsapp.net' };
const POSTER = '2348000000000@s.whatsapp.net';

const run = (sock, reply) => cmd.run({
  sock,
  msg: { key: { id: 'M1', remoteJid: POSTER, fromMe: true } },
  jid: POSTER,
  prefix: '.',
  reply: reply || (async () => { throw new Error('no reply expected on success'); }),
});

test('save: it is the command 5AFFUL uses, owner only', () => {
  assert.ok(cmd, 'the save command exists');
  assert.strictEqual(cmd.category, 'status');
  assert.strictEqual(cmd.ownerOnly, true);
  assert.ok(cmd.aliases.includes('savethis'));
  assert.ok(cmd.aliases.includes('keepstatus'));
});

test('save: the replied status goes to the owner chat, nothing is posted to the poster', async () => {
  const realQuote = statusreply.statusQuote;
  const realSave = engine.saveStatus;
  const saved = [];
  const sent = [];
  const quote = { id: 'S1', who: POSTER, message: { imageMessage: { url: 'x', caption: 'hi' } } };
  statusreply.statusQuote = () => quote;
  engine.saveStatus = async (sock, msg, to, who) => { saved.push({ msg, to, who }); };
  try {
    const sock = { user: OWNER, sendMessage: async (j, c) => sent.push({ j, c }) };
    await run(sock);
    assert.strictEqual(saved.length, 1, 'one status saved');
    assert.strictEqual(saved[0].to, ownerChat(sock), 'it goes to the chat from statusjid (owner by default)');
    assert.strictEqual(saved[0].msg.key.remoteJid, 'status@broadcast');
    assert.strictEqual(saved[0].msg.key.id, 'S1');
    assert.strictEqual(saved[0].msg.key.participant, POSTER);
    assert.strictEqual(saved[0].who, POSTER);
    assert.deepStrictEqual(sent, [], 'the poster sees no command and no answer');
  } finally {
    statusreply.statusQuote = realQuote;
    engine.saveStatus = realSave;
  }
});

test('save: used on something that is not a status, it shows how to use it', async () => {
  const realQuote = statusreply.statusQuote;
  statusreply.statusQuote = () => null;
  try {
    const replies = [];
    await run({ user: OWNER }, async (t) => replies.push(t));
    assert.strictEqual(replies.length, 1);
    assert.match(replies[0], /Reply to a status with \*\.save\*/);
    assert.match(replies[0], /autosavestatus on/);
  } finally {
    statusreply.statusQuote = realQuote;
  }
});

test('save: with statusreply on, one reply never sends two copies', async () => {
  const realQuote = statusreply.statusQuote;
  const realSave = engine.saveStatus;
  statusreply.statusQuote = () => ({ id: 'S2', who: POSTER, message: { conversation: 'text' } });
  statusreply.done.set('S2', Date.now()); // the automatic save already took this one
  store.updateStatusCfg((s) => { s.saveReply = true; });
  let called = 0;
  engine.saveStatus = async () => { called += 1; };
  try {
    await run({ user: OWNER, sendMessage: async () => {} });
    assert.strictEqual(called, 0, 'no second copy');
  } finally {
    store.updateStatusCfg((s) => { s.saveReply = false; });
    statusreply.done.delete('S2');
    statusreply.statusQuote = realQuote;
    engine.saveStatus = realSave;
  }
});

test('save: a failure is reported to the owner chat, never to the poster', async () => {
  const realQuote = statusreply.statusQuote;
  const realSave = engine.saveStatus;
  statusreply.statusQuote = () => ({ id: 'S3', who: POSTER, message: { imageMessage: {} } });
  engine.saveStatus = async () => { throw new Error('no file'); };
  const sent = [];
  try {
    const sock = { user: OWNER, sendMessage: async (j, c) => sent.push({ j, c }) };
    await run(sock);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].j, ownerChat(sock));
    assert.match(sent[0].c.text, /could not save/);
  } finally {
    statusreply.statusQuote = realQuote;
    engine.saveStatus = realSave;
  }
});
