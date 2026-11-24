// The bot's name and links. Changing them here changes them everywhere, and updates carry the change to everyone.
module.exports = Object.freeze({
  botName: '5AFFUL V6',
  creator: 'Safful',
  links: {
    telegramSupport: 'https://t.me/+7PwU2Vo9czE1NTRk',
    telegramChannel: 'https://t.me/+e89lCBU2wLpjNWNk',
    whatsappChannel: 'https://whatsapp.com/channel/0029VbDpuKM8qIzkoQscOE2w',
    github: 'https://github.com/godfada-sa/5AFFUL-BOT',
  },
  // Added under the result of some commands once they SUCCEED (turn off or change it with the "watermark" command)
  watermark: {
    text: '⚡ 5AFFUL V6',
    categories: ['media', 'audio', 'video', 'editor'],
    commands: ['qr', 'fancy', 'play', 'mp3', 'calc', 'password'],
  },
});
