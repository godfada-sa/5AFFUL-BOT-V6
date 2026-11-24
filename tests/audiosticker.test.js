require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const sound = require('../whatsapp/audiosticker');

test('sound sticker: the wire carries Message.audioStickerMessage (134) and StickerMessage.audioMessage (26)', async () => {
  const lib = await sound.install();
  const wrapper = sound.wrapAudioSticker({
    stickerMessage: { mimetype: 'image/webp', audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 2 } },
  });
  const bytes = lib.proto.Message.encode(wrapper).finish();
  assert.ok(bytes.includes(Buffer.from([0xb2, 0x08])), 'field 134 (audioStickerMessage) is missing');
  assert.ok(bytes.includes(Buffer.from([0xd2, 0x01])), 'field 26 (StickerMessage.audioMessage) is missing');
  assert.strictEqual(wrapper.stickerMessage, undefined, 'no top-level stickerMessage (that tags the stanza mediatype=sticker)');
  assert.strictEqual(wrapper.messageContextInfo.messageSecret.length, 32);
});

test('sound sticker: the relay gets the same audio descriptor the shared handler sends', async () => {
  let relayed = null;
  const preparedSticker = { stickerMessage: { mimetype: 'image/webp', width: null, height: null } };
  const preparedAudio = { audioMessage: { url: 'https://x', seconds: 2, ptt: true, waveform: Buffer.from([1, 2]), fileLength: '12' } };
  const sock = { waUploadToServer: async () => ({}), relayMessage: async () => {} };

  await sound.sendSoundSticker(sock, '123@g.us', Buffer.from('sticker'), Buffer.from('audio'), {
    prepare: async (content) => (content.sticker ? preparedSticker : preparedAudio),
    relay: async (_sock, jid, message, options) => { relayed = { jid, message, options }; },
    messageId: 'MID',
  });

  const inner = relayed.message.audioStickerMessage.message.stickerMessage;
  assert.strictEqual(relayed.jid, '123@g.us');
  assert.strictEqual(relayed.options.messageId, 'MID');
  assert.strictEqual(inner.audioMessage.ptt, true, 'the shared handler marks the audio as a voice note');
  assert.strictEqual(inner.audioMessage.fileLength, 12);
  assert.strictEqual(inner.audioMessage.seconds, 2);
  assert.strictEqual(relayed.message.stickerMessage, undefined);

  const lib = await sound.install();
  const bytes = lib.proto.Message.encode(relayed.message).finish();
  assert.ok(bytes.includes(Buffer.from([0xb2, 0x08])), 'field 134 (audioStickerMessage) is missing from the relayed message');
  assert.ok(bytes.includes(Buffer.from([0xd2, 0x01])), 'field 26 (StickerMessage.audioMessage) is missing from the relayed message');
});

test('sound sticker: a replied voice note keeps its own descriptor and is not uploaded again', async () => {
  const descriptor = {
    url: 'https://mmg.whatsapp.net/voice',
    directPath: '/v/t62.7118-24/voice',
    mediaKey: Buffer.alloc(32, 1),
    ptt: true,
    seconds: '4',
    fileLength: '99',
  };
  const prepareCalls = [];
  let relayed = null;
  await sound.sendSoundSticker(
    { waUploadToServer: async () => ({}) },
    '123@g.us',
    Buffer.from('sticker'),
    undefined,
    {
      audioDescriptor: descriptor,
      mimetype: 'audio/ogg; codecs=opus',
      prepare: async (content) => {
        prepareCalls.push(Object.keys(content)[0]);
        return { stickerMessage: { url: 'sticker' } };
      },
      relay: async (_sock, _jid, message) => { relayed = message; },
    },
  );

  assert.deepStrictEqual(prepareCalls, ['sticker'], 'the voice note itself is not prepared/uploaded again');
  const inner = relayed.audioStickerMessage.message.stickerMessage.audioMessage;
  assert.strictEqual(inner.url, descriptor.url);
  assert.strictEqual(inner.mediaKey, descriptor.mediaKey);
  assert.strictEqual(inner.seconds, 4);
  assert.strictEqual(inner.ptt, true);
  assert.strictEqual(relayed.messageContextInfo.messageSecret.length, 32);
});

test('asticker command: save a voice note, put it on a sticker, and fall back to two messages', async () => {
  const media = require('../whatsapp/media');
  const cmd = require('../commands/audiosticker');
  const real = {
    findMedia: media.findMedia,
    download: media.download,
    toOpus: sound.toOpus,
    audioDuration: sound.audioDuration,
    fitSticker: sound.fitSticker,
    sendSoundSticker: sound.sendSoundSticker,
    sendSeparately: sound.sendSeparately,
  };
  const replies = [];
  let sent = null;
  let separately = null;
  const run = (args) => cmd.run({
    sock: { authState: { creds: { me: { id: '999:1@s.whatsapp.net' } } } },
    msg: { key: { id: 'CMD1' } },
    jid: '123@g.us',
    args,
    prefix: '.',
    botIds: [],
    reply: async (text) => { replies.push(text); },
  });

  try {
    media.findMedia = () => ({ kind: 'audio', source: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 2 } } } });
    media.download = async () => Buffer.from('voice');
    sound.toOpus = async (buffer) => ({ buffer, mimetype: 'audio/ogg; codecs=opus' });
    sound.audioDuration = async () => 2;

    await run(['save']);
    assert.match(replies.at(-1), /Sound saved/);

    media.findMedia = () => ({ kind: 'sticker', source: { message: { stickerMessage: {} } } });
    media.download = async () => Buffer.from('sticker');
    sound.fitSticker = async (buffer) => buffer;
    sound.sendSoundSticker = async (_sock, jid, sticker, audio, options) => { sent = { jid, sticker, audio, options }; };
    await run([]);
    assert.strictEqual(sent.jid, '123@g.us');
    assert.strictEqual(sent.sticker.toString(), 'sticker');
    assert.strictEqual(sent.audio.toString(), 'voice');
    assert.strictEqual(sent.options.seconds, 2);
    assert.strictEqual(sent.options.audioDescriptor, undefined, 'no voice-note descriptor was available here');

    sound.sendSeparately = async (_sock, jid, sticker, audio, options) => { separately = { jid, sticker, audio, options }; };
    await run(['all']);
    assert.strictEqual(separately.jid, '123@g.us');
    assert.match(replies.at(-1), /Sent separately/);
  } finally {
    Object.assign(media, { findMedia: real.findMedia, download: real.download });
    Object.assign(sound, {
      toOpus: real.toOpus,
      audioDuration: real.audioDuration,
      fitSticker: real.fitSticker,
      sendSoundSticker: real.sendSoundSticker,
      sendSeparately: real.sendSeparately,
    });
  }
});
