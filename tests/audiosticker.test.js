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

    separately = null;
    await run(['ios']); // the iPhone way: two messages
    assert.strictEqual(separately.jid, '123@g.us');
    assert.match(replies.at(-1), /Every phone plays this/);

    // a video becomes an animated sticker (its first 8 seconds) with the saved sound
    let kindSeen = null;
    media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 30 } } } });
    media.download = async () => Buffer.from('clip');
    sound.fitSticker = async (buffer, kind) => { kindSeen = kind; return Buffer.from('animated'); };
    sent = null;
    await run([]);
    assert.strictEqual(kindSeen, 'video');
    assert.strictEqual(sent.sticker.toString(), 'animated');
    assert.strictEqual(sent.audio.toString(), 'voice');
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

// ---- 8 second limit, and a video's own sound in one step -------------------

// the command keeps the saved sound in module state, so each new test starts
// from a clean module: no test inherits a sound from another
const freshCommand = () => {
  const file = require.resolve('../commands/audiosticker');
  delete require.cache[file];
  return require(file);
};

const stubs = (sound) => {
  const real = {
    toOpus: sound.toOpus,
    audioDuration: sound.audioDuration,
    extractAudio: sound.extractAudio,
    makeWaveformSticker: sound.makeWaveformSticker,
    fitSticker: sound.fitSticker,
    sendSoundSticker: sound.sendSoundSticker,
    sendSeparately: sound.sendSeparately,
  };
  const media = require('../whatsapp/media');
  const realMedia = { findMedia: media.findMedia, download: media.download };
  const put = (over) => Object.assign(sound, over);
  const restore = () => {
    Object.assign(sound, real);
    Object.assign(media, realMedia);
  };
  return { media, put, restore };
};

test('sound sticker: the limit is 8 seconds, and a longer voice note is cut down instead of reused', async () => {
  const media = require('../whatsapp/media');
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  const seen = {};
  let sent = null;
  const replies = [];

  assert.strictEqual(sound.MAX_SOUND_SECONDS, 8, 'the sound sticker carries 8 seconds');

  try {
    s.media.findMedia = () => ({ kind: 'audio', source: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 45, url: 'https://mmg.whatsapp.net/long', mediaKey: Buffer.alloc(32, 2) } } } });
    s.media.download = async () => Buffer.from('long-voice');
    s.put({
      toOpus: async (buffer, options) => { seen.toOpus = options; return { buffer: Buffer.from('cut'), mimetype: 'audio/ogg; codecs=opus' }; },
      audioDuration: async () => 7.6,
      makeWaveformSticker: async () => Buffer.from('wave'),
      sendSoundSticker: async (_sock, jid, sticker, audio, options) => { sent = { jid, sticker, audio, options }; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'C1' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(seen.toOpus.maxSeconds, 8, 'a 45 second voice note is cut to the sticker limit');
    assert.strictEqual(sent.audio.toString(), 'cut');
    assert.strictEqual(sent.options.seconds, 8, 'the phone is told the length it actually gets');
    assert.strictEqual(sent.options.audioDescriptor, undefined, 'the long original descriptor is not reused');
  } finally {
    s.restore();
  }
});

test('asticker: replying to a video that has sound uses the video own sound, no save step', async () => {
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  const seen = {};
  let sent = null;
  const replies = [];

  try {
    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 30 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async (buffer, options) => {
        seen.extract = { buffer: buffer.toString(), options };
        return { buffer: Buffer.from('vidsound'), mimetype: 'audio/ogg; codecs=opus', seconds: 8 };
      },
      fitSticker: async (buffer, kind) => { seen.kind = kind; return Buffer.from('animated'); },
      sendSoundSticker: async (_sock, jid, sticker, audio, options) => { sent = { sticker, audio, options }; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'C2' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(seen.extract.buffer, 'clip', 'the sound comes out of the video itself');
    assert.strictEqual(seen.extract.options.maxSeconds, 8);
    assert.strictEqual(seen.kind, 'video');
    assert.strictEqual(sent.sticker.toString(), 'animated');
    assert.strictEqual(sent.audio.toString(), 'vidsound');
    assert.strictEqual(sent.options.seconds, 8);
    assert.match(replies.join('\n'), /Reading the sound/);
  } finally {
    s.restore();
  }
});

test('asticker: a video with no sound, and nothing saved, says so and sends nothing', async () => {
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  let sent = null;
  const replies = [];

  try {
    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 12 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async () => { throw Object.assign(new Error('no audio stream'), { code: 'NO_AUDIO' }); },
      fitSticker: async () => Buffer.from('animated'),
      sendSoundSticker: async () => { sent = 'sent'; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'C3' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(sent, null, 'no sticker is sent without a sound');
    assert.match(replies.at(-1), /no sound of its own/);
    assert.match(replies.at(-1), /asticker save/);
  } finally {
    s.restore();
  }
});

test('asticker: saved on a video uses the sound you saved instead of the video own sound', async () => {
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  let sent = null;
  let extracted = 0;
  const replies = [];

  try {
    s.media.findMedia = () => ({ kind: 'audio', source: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 2 } } } });
    s.media.download = async () => Buffer.from('voice');
    s.put({ toOpus: async (buffer) => ({ buffer, mimetype: 'audio/ogg; codecs=opus' }), audioDuration: async () => 2 });
    await cmd.run({ sock: {}, msg: { key: { id: 'C4' } }, jid: '123@g.us', args: ['save'], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });
    assert.match(replies.at(-1), /Sound saved/);

    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 20 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async () => { extracted += 1; return { buffer: Buffer.from('vidsound'), mimetype: 'audio/ogg; codecs=opus', seconds: 8 }; },
      fitSticker: async () => Buffer.from('animated'),
      sendSoundSticker: async (_sock, jid, sticker, audio, options) => { sent = { audio, options }; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'C5' } }, jid: '123@g.us', args: ['saved'], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(extracted, 0, 'the video is not read for sound');
    assert.strictEqual(sent.audio.toString(), 'voice', 'the saved sound is used');
    assert.strictEqual(sent.options.seconds, 2);
  } finally {
    s.restore();
  }
});

test('asticker save: a video gives up its own sound, ready to put on another sticker', async () => {
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  let sent = null;
  const replies = [];

  try {
    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 40 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async () => ({ buffer: Buffer.from('vidsound'), mimetype: 'audio/ogg; codecs=opus', seconds: 8 }),
      fitSticker: async () => Buffer.from('still'),
      sendSoundSticker: async (_sock, jid, sticker, audio, options) => { sent = { audio, options }; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'C6' } }, jid: '123@g.us', args: ['save'], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });
    assert.match(replies.at(-1), /Sound saved\*? \(8s from the video/);

    s.media.findMedia = () => ({ kind: 'image', source: { message: { imageMessage: {} } } });
    s.media.download = async () => Buffer.from('picture');
    await cmd.run({ sock: {}, msg: { key: { id: 'C7' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(sent.audio.toString(), 'vidsound', 'the saved video sound lands on the picture');
    assert.strictEqual(sent.options.seconds, 8);
  } finally {
    s.restore();
  }
});

// ---- how the sound travels: sticker / music / two messages -----------------

test('sound sticker: a music clip goes in as a music clip, not a voice note (no waveform, ptt off)', async () => {
  const sound = require('../whatsapp/audiosticker');
  let relayed = null;
  await sound.sendSoundSticker({ waUploadToServer: async () => ({}) }, '123@g.us', Buffer.from('sticker'), undefined, {
    audioDescriptor: { url: 'https://mmg/music', mediaKey: Buffer.alloc(32, 3), ptt: true, waveform: Buffer.from([1, 2, 3]), seconds: 8, fileLength: '99' },
    mimetype: 'audio/mp4',
    ptt: false,
    prepare: async () => ({ stickerMessage: { url: 'sticker' } }),
    relay: async (_sock, _jid, message) => { relayed = message; },
  });
  const inner = relayed.audioStickerMessage.message.stickerMessage.audioMessage;
  assert.strictEqual(inner.ptt, false, 'a music clip is not a voice note');
  assert.strictEqual(inner.waveform, undefined, 'a voice-note waveform would keep the mute badge');
  assert.strictEqual(inner.mimetype, 'audio/mp4');
  assert.strictEqual(inner.seconds, 8);
});

test('asticker: "music" with no file sets the mode, and the next video goes out as a music clip', async () => {
  const store = require('../whatsapp/store');
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  const seen = {};
  let sent = null;
  const replies = [];

  store.updateAsticker((a) => { a.mode = 'sticker'; });
  try {
    await cmd.run({ sock: {}, msg: { key: { id: 'M1' } }, jid: '123@g.us', args: ['music'], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });
    assert.match(replies.at(-1), /Sound stickers: music/);
    assert.strictEqual(store.astickerCfg().mode, 'music', 'the mode is remembered');

    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 20 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async (_buffer, options) => {
        seen.extract = options;
        return { buffer: Buffer.from('music'), mimetype: 'audio/mp4', seconds: 8 };
      },
      fitSticker: async () => Buffer.from('animated'),
      sendSoundSticker: async (_sock, jid, sticker, audio, options) => { sent = { audio, options }; },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'M2' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.strictEqual(seen.extract.music, true, 'the video sound is encoded as a music clip');
    assert.strictEqual(sent.options.mimetype, 'audio/mp4');
    assert.strictEqual(sent.options.ptt, false);
  } finally {
    store.updateAsticker((a) => { a.mode = 'sticker'; });
    s.restore();
  }
});

test('asticker: "sticker" puts the plain sound sticker back', async () => {
  const store = require('../whatsapp/store');
  const cmd = freshCommand();
  const replies = [];
  store.updateAsticker((a) => { a.mode = 'iphone'; });
  try {
    await cmd.run({ sock: {}, msg: { key: { id: 'S1' } }, jid: '123@g.us', args: ['sticker'], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });
    assert.strictEqual(store.astickerCfg().mode, 'sticker');
    assert.match(replies.at(-1), /Sound stickers: sticker/);
  } finally {
    store.updateAsticker((a) => { a.mode = 'sticker'; });
  }
});

test('asticker: in iphone mode every send is two messages, without typing "ios"', async () => {
  const store = require('../whatsapp/store');
  const sound = require('../whatsapp/audiosticker');
  const cmd = freshCommand();
  const s = stubs(sound);
  let separately = null;
  const replies = [];

  store.updateAsticker((a) => { a.mode = 'iphone'; });
  try {
    s.media.findMedia = () => ({ kind: 'video', source: { message: { videoMessage: { seconds: 15 } } } });
    s.media.download = async () => Buffer.from('clip');
    s.put({
      extractAudio: async () => ({ buffer: Buffer.from('vidsound'), mimetype: 'audio/ogg; codecs=opus', seconds: 8 }),
      fitSticker: async () => Buffer.from('animated'),
      sendSeparately: async (_sock, jid, sticker, audio, options) => { separately = { sticker, audio, options }; },
      sendSoundSticker: async () => { throw new Error('the embedded path must not run in iphone mode'); },
    });

    await cmd.run({ sock: {}, msg: { key: { id: 'I1' } }, jid: '123@g.us', args: [], prefix: '.', botIds: [], reply: async (text) => replies.push(text) });

    assert.ok(separately, 'two messages were sent');
    assert.strictEqual(separately.audio.toString(), 'vidsound');
    assert.strictEqual(separately.options.seconds, 8);
    assert.match(replies.at(-1), /Sent separately/);
  } finally {
    store.updateAsticker((a) => { a.mode = 'sticker'; });
    s.restore();
  }
});

test('sound sticker: the two-message way hangs the sound under the sticker it belongs to', async () => {
  const sound = require('../whatsapp/audiosticker');
  const calls = [];
  const sock = {
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      return { key: { id: 'STICKER1', remoteJid: jid, fromMe: true } };
    },
  };
  await sound.sendSeparately(sock, '123@g.us', Buffer.from('s'), Buffer.from('a'), { quoted: { key: { id: 'CMD' } } });
  assert.strictEqual(calls.length, 2);
  assert.ok(Buffer.isBuffer(calls[0].content.sticker), 'the sticker goes first');
  assert.strictEqual(calls[1].content.ptt, true, 'the sound is a voice note');
  assert.strictEqual(calls[1].options.quoted.key.id, 'STICKER1', 'the sound is quoted to the sticker, not to the command');
});

// ---- the shape a phone itself uses when it forwards a sound sticker --------

const readVarint = (buf, start) => {
  let shift = 0;
  let value = 0;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, i];
    shift += 7;
  }
  throw new Error('truncated varint');
};

const topFields = (buf) => {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    i = afterKey;
    const field = key >>> 3;
    const wire = key & 7;
    out.push(field);
    if (wire === 2) {
      const [len, afterLen] = readVarint(buf, i);
      i = afterLen + len;
    } else if (wire === 0) {
      const [, afterValue] = readVarint(buf, i);
      i = afterValue;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error(`unexpected wire type ${wire}`);
  }
  return out;
};

test('sound sticker: the native shape is a plain sticker message carrying the sound, with no field 134', async () => {
  const lib = await sound.install();
  let relayed = null;
  const result = await sound.sendSoundSticker({ waUploadToServer: async () => ({}) }, '123@g.us', Buffer.from('sticker'), undefined, {
    audioDescriptor: { url: 'https://mmg/sound', mediaKey: Buffer.alloc(32, 5), ptt: true, seconds: 6, fileLength: '10' },
    mimetype: 'audio/ogg; codecs=opus',
    shape: 'plain',
    prepare: async () => ({ stickerMessage: { url: 'sticker' } }),
    relay: async (_sock, _jid, message) => { relayed = message; },
  });

  assert.strictEqual(relayed.audioStickerMessage, undefined, 'no future-proof wrapper');
  assert.ok(relayed.stickerMessage && relayed.stickerMessage.audioMessage, 'the sound rides in the sticker message');
  const fields = topFields(lib.proto.Message.encode(relayed).finish());
  assert.ok(!fields.includes(134), 'field 134 must not be on the wire');
  assert.ok(fields.includes(26), 'the plain sticker message is on the wire');
  assert.strictEqual(result.shape, 'plain');
});

test('sound sticker: if the server refuses the plain shape, the wrapped one still goes out', async () => {
  const shapes = [];
  let calls = 0;
  const result = await sound.sendSoundSticker({ waUploadToServer: async () => ({}) }, '123@g.us', Buffer.from('sticker'), undefined, {
    audioDescriptor: { url: 'https://mmg/sound', mediaKey: Buffer.alloc(32, 6), ptt: true, seconds: 6, fileLength: '10' },
    mimetype: 'audio/ogg; codecs=opus',
    shape: 'plain',
    prepare: async () => ({ stickerMessage: { url: 'sticker' } }),
    relay: async (_sock, _jid, message) => {
      calls += 1;
      shapes.push(message.audioStickerMessage ? 'wrapped' : 'plain');
      if (calls === 1) throw new Error('the server did not accept that message');
      return 'ID2';
    },
  });

  assert.deepStrictEqual(shapes, ['plain', 'wrapped'], 'the plain shape is tried first, then the wrapper');
  assert.strictEqual(result.shape, 'wrapped');
  assert.strictEqual(result.key.id, 'ID2');
});
