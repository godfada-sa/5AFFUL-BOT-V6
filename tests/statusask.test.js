'use strict';

// .astatus: when somebody replies to the owner's OWN status with a text that has
// "send" in it, that status is sent to them in the chat — once, and only theirs.

require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../whatsapp/store');
const presence = require('../whatsapp/presence');
const engine = require('../whatsapp/status');
const statusask = require('../whatsapp/statusask');
const commands = require('../commands/statuscmds');

const cmd = commands.find((c) => c.name === 'astatus');
const OWNER_ID = '27800000001:12@s.whatsapp.net';
const OWNER_LID = '199988877766655@lid';
const OWNER = { id: OWNER_ID, lid: OWNER_LID };
const OWNER_JID = '27800000001@s.whatsapp.net';
const ASKER = '2348000000001@s.whatsapp.net';
const OTHER = '2348000000002@s.whatsapp.net';
const STRANGER = '2348000000003@s.whatsapp.net';

const statusImage = { imageMessage: { url: 'https://mmg.whatsapp.net/x', mediaKey: 'k', caption: 'my photo' } };

// a reply written in ASKER's chat to the status S1
function reply(text, opts = {}) {
  const participant = opts.participant || OWNER_JID;
  return {
    key: { id: opts.id || 'R1', remoteJid: opts.jid || ASKER, fromMe: !!opts.fromMe },
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          remoteJid: opts.remoteJid || 'status@broadcast',
          stanzaId: opts.statusId || 'S1',
          participant,
          quotedMessage: opts.quoted || statusImage,
        },
      },
    },
  };
}

function fakeSock() {
  const sent = [];
  return {
    user: OWNER,
    sent,
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `out-${sent.length}` } };
    },
  };
}

function withSave(fn) {
  return async (t) => {
    const real = engine.saveStatus;
    const calls = [];
    engine.saveStatus = async (sock, msg, to, who, header) => {
      calls.push({ msg, to, who, header });
    };
    statusask.done.clear();
    store.updateStatusCfg((s) => {
      s.askSend = true;
    });
    try {
      await fn({ calls, t });
    } finally {
      engine.saveStatus = real;
      statusask.done.clear();
      store.updateStatusCfg((s) => {
        s.askSend = false;
      });
    }
  };
}

test('astatus: it is owner only, with its aliases', () => {
  assert.ok(cmd, 'the astatus command exists');
  assert.strictEqual(cmd.category, 'status');
  assert.strictEqual(cmd.ownerOnly, true);
  for (const alias of ['statussend', 'sendstatus', 'statusask']) assert.ok(cmd.aliases.includes(alias), alias);
  assert.doesNotMatch(cmd.description, /V6|5AFFUL|turbofex|tfx/i, 'the description names no bot');
});

test('astatus: it is OFF until the owner switches it on', () => {
  assert.strictEqual(store.statusCfg().askSend, false);
});

test('astatus: on and off are saved, and any other word shows the state', async () => {
  const replies = [];
  const reply1 = async (t) => replies.push(t);
  await cmd.run({ args: [], reply: reply1, prefix: '.' });
  assert.match(replies.at(-1), /Send my status when someone asks:\* OFF/);
  assert.match(replies.at(-1), /\.astatus on/);

  await cmd.run({ args: ['on'], reply: reply1, prefix: '.' });
  assert.strictEqual(store.statusCfg().askSend, true);
  assert.match(replies.at(-1), /ON/);

  await cmd.run({ args: [], reply: reply1, prefix: '.' });
  assert.match(replies.at(-1), /ON/);

  await cmd.run({ args: ['off'], reply: reply1, prefix: '.' });
  assert.strictEqual(store.statusCfg().askSend, false);
  assert.match(replies.at(-1), /OFF/);
});

test('astatus: nothing is sent while it is off', async () => {
  const real = engine.saveStatus;
  let called = 0;
  engine.saveStatus = async () => {
    called += 1;
  };
  try {
    const sock = fakeSock();
    const got = await statusask.maybe(sock, reply('send'));
    assert.strictEqual(got, false);
    assert.strictEqual(called, 0);
    assert.deepStrictEqual(sock.sent, []);
  } finally {
    engine.saveStatus = real;
  }
});

test(
  'astatus: a reply with "send" in it gets the status, in that chat, once',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    const got = await statusask.maybe(sock, reply('please send it'));
    assert.strictEqual(got, true);
    assert.strictEqual(calls.length, 1, 'one status sent');
    assert.strictEqual(calls[0].to, ASKER, 'to the person who asked');
    assert.strictEqual(calls[0].who, OWNER_JID, 'it is the owner status');
    assert.strictEqual(calls[0].msg.key.remoteJid, 'status@broadcast');
    assert.strictEqual(calls[0].msg.key.id, 'S1');
    assert.match(calls[0].header, /Status/, 'it carries its own header, not "Status saved"');
    assert.deepStrictEqual(sock.sent, [], 'nothing extra is posted');
  }),
);

test(
  'astatus: the same ask is answered once, a different person still gets it',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    await statusask.maybe(sock, reply('send'));
    await statusask.maybe(sock, reply('SEND', { id: 'R2' }));
    assert.strictEqual(calls.length, 1, 'no second copy for the same person and status');
    await statusask.maybe(sock, reply('send', { id: 'R3', jid: OTHER }));
    assert.strictEqual(calls.length, 2, 'the next person is answered');
    assert.strictEqual(calls[1].to, OTHER);
  }),
);

test(
  'astatus: a reply to somebody else status is never touched',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    const got = await statusask.maybe(sock, reply('send', { participant: OTHER }));
    assert.strictEqual(got, false);
    assert.strictEqual(calls.length, 0);
  }),
);

test(
  'astatus: the owner status is recognised by its hidden id too',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    const got = await statusask.maybe(sock, reply('send', { participant: OWNER_LID }));
    assert.strictEqual(got, true);
    assert.strictEqual(calls.length, 1);
  }),
);

test(
  'astatus: a reply without "send" is left alone',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    for (const text of ['nice one', '🔥🔥', 'hello there']) {
      assert.strictEqual(await statusask.maybe(sock, reply(text, { id: text })), false);
    }
    assert.strictEqual(calls.length, 0);
  }),
);

test(
  'astatus: groups, broadcasts and the owner own messages are ignored',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    assert.strictEqual(await statusask.maybe(sock, reply('send', { jid: '120363000000000000@g.us' })), false);
    assert.strictEqual(await statusask.maybe(sock, reply('send', { fromMe: true })), false);
    assert.strictEqual(calls.length, 0);
  }),
);

test(
  'astatus: whoever asks is allowed to write privately (the blocker steps aside)',
  withSave(async () => {
    const sock = fakeSock();
    await statusask.maybe(sock, reply('send', { jid: STRANGER }));
    assert.ok(presence.allowedList().includes('2348000000003'), 'the asker is on the allowed list');
  }),
);

test(
  'astatus: a quote WhatsApp left empty is reported, not sent as nothing',
  withSave(async ({ calls }) => {
    const sock = fakeSock();
    const got = await statusask.maybe(sock, reply('send', { quoted: {} }));
    assert.strictEqual(got, false);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(sock.sent.length, 1);
    assert.strictEqual(sock.sent[0].jid, ASKER);
    assert.match(sock.sent[0].content.text, /could not open that status/);
  }),
);

test(
  'astatus: a download failure is reported to the asker, never thrown',
  withSave(async ({ t }) => {
    const sock = fakeSock();
    const real = engine.saveStatus;
    engine.saveStatus = async () => {
      throw new Error('no file');
    };
    try {
      const got = await statusask.maybe(sock, reply('send', { jid: '2348000000009@s.whatsapp.net' }));
      assert.strictEqual(got, false);
      assert.strictEqual(sock.sent.length, 1);
      assert.match(sock.sent[0].content.text, /could not send that status/);
    } finally {
      engine.saveStatus = real;
    }
  }),
);

test('astatus: .statusinfo shows it, on and off', async () => {
  const info = commands.find((c) => c.name === 'statusinfo');
  const replies = [];
  store.updateStatusCfg((s) => {
    s.askSend = true;
  });
  try {
    await info.run({ reply: async (t) => replies.push(t), prefix: '.', sock: { user: { id: OWNER_ID } }, jid: ASKER, args: [] });
    assert.match(replies.at(-1), /Send on ask:\* ON/);
  } finally {
    store.updateStatusCfg((s) => {
      s.askSend = false;
    });
  }
});

test('astatus: a text status is sent as text, a photo as a photo', () => {
  assert.ok(statusask.contentOf({ conversation: 'hello' }));
  assert.ok(statusask.contentOf({ extendedTextMessage: { text: 'hello' } }));
  assert.ok(statusask.contentOf({ imageMessage: { url: 'u' } }));
  assert.strictEqual(statusask.contentOf({}), null);
  assert.strictEqual(statusask.contentOf(undefined), null);
});
