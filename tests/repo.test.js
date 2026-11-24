'use strict';

// .repo: the deploy card sends the Safful image and the deploy link in one message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cmd = require('../commands/repo');

const run = (sock) => cmd.run({
  sock,
  msg: { key: { id: 'REPO1' } },
  jid: '123@g.us',
  prefix: '.',
  reply: async () => { throw new Error('the card should not fall back to text when the image exists'); },
});

test('repo: one card with the Safful image and the deploy link', async () => {
  const sent = [];
  await run({ sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); } });
  assert.strictEqual(sent.length, 1);
  const { jid, content, opts } = sent[0];
  assert.strictEqual(jid, '123@g.us');
  assert.ok(Buffer.isBuffer(content.image), 'the picture is attached');
  assert.strictEqual(content.image[0], 0xff, 'it is a JPEG (first byte)');
  assert.strictEqual(content.image[1], 0xd8, 'it is a JPEG (second byte)');
  assert.strictEqual(content.mimetype, 'image/jpeg');
  assert.match(content.caption, /GRANTED/, 'the terminal look');
  assert.match(content.caption, /DEPLOY-5AFFUL-V6/);
  assert.match(content.caption, /git clone https:\/\/github\.com\/godfada-sa\/DEPLOY-5AFFUL-V6\.git/);
  assert.strictEqual(opts.quoted.key.id, 'REPO1', 'the card answers the command');
});

test('repo: the picture is shipped with the bot and the card names itself', () => {
  const img = path.join(__dirname, '..', 'assets', 'safful-repo.jpg');
  assert.ok(fs.existsSync(img), 'assets/safful-repo.jpg travels with the code');
  assert.ok(fs.statSync(img).size > 10 * 1024, 'a real picture, not a placeholder');
  assert.strictEqual(cmd.name, 'repo');
  assert.ok(cmd.aliases.includes('deploy'), '.deploy opens the same card');
  assert.strictEqual(cmd.category, 'general');
  assert.match(cmd.caption('.'), /type \.repo/);
  assert.match(cmd.caption('!'), /type !repo/);
});
