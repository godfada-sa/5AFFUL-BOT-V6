const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAX_DEVICES = 2;
const SECOND_NAME = 'device-2';

const digits = (value) => String(value || '').replace(/\D/g, '');
const clean = (value) => (value === undefined || value === null ? '' : String(value).trim());

function deviceSettings(env, device) {
  const pick = (key) => clean(env[`${key}_${device}`]);
  return {
    number: digits(pick('NUMBER') || pick('PAIRING_NUMBER') || pick('OWNER_NUMBER')),
    sessionId: pick('SESSION_ID'),
    prefix: pick('PREFIX') || pick('BOT_PREFIX'),
    timezone: pick('TIMEZONE'),
    sudo: pick('SUDO'),
    ownerName: pick('OWNER_NAME'),
    botName: pick('BOT_NAME'),
  };
}

function deviceCount(value) {
  const parsed = Number.parseInt(String(value || '1'), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_DEVICES, parsed)) : 1;
}

function linkedNumber(sessionDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'));
    return digits(creds?.me?.id || creds?.me?.lid);
  } catch (err) {
    return '';
  }
}

function savedNumber() {
  try {
    return digits(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'setup.json'), 'utf8')).number);
  } catch (err) {
    return '';
  }
}

function firstFileId(root = ROOT) {
  try {
    return require('./core/sessionid').readFile(path.join(root, 'session_id.txt'));
  } catch (err) {
    return '';
  }
}

function normalizeId(value) {
  try {
    return require('./core/sessionid').normalize(value) || '';
  } catch (err) {
    return String(value || '').trim().toUpperCase();
  }
}

function plan(env = process.env, root = ROOT) {
  const count = deviceCount(env.DEVICE_COUNT);
  const one = deviceSettings(env, 1);
  const out = { count, env: {}, notes: [], error: null };

  if (one.number) {
    out.env.NUMBER = one.number;
    out.env.PAIRING_NUMBER = one.number;
  }
  if (one.sessionId) out.env.SESSION_ID = one.sessionId;
  if (one.prefix) out.env.BOT_PREFIX = one.prefix;
  if (one.timezone) out.env.TIMEZONE = one.timezone;
  if (one.sudo) out.env.SUDO = one.sudo;

  if (count < 2) return out;

  const two = deviceSettings(env, 2);

  const mainNumber = one.number
    || digits(env.NUMBER)
    || digits(env.PAIRING_NUMBER)
    || linkedNumber(path.join(root, 'session'))
    || savedNumber();
  const secondNumber = two.number || linkedNumber(path.join(root, 'accounts', SECOND_NAME, 'session'));
  if (mainNumber && secondNumber && mainNumber === secondNumber) {
    out.error = `device 2 uses the same WhatsApp number as device 1 (${mainNumber}). Give device 2 its own number (NUMBER_2=...) or leave NUMBER_2 empty and link it with SESSION_ID_2.`;
    return out;
  }

  const mainIds = [one.sessionId, env.SESSION_ID, firstFileId(root)].map(normalizeId).filter(Boolean);
  if (two.sessionId) {
    const id = normalizeId(two.sessionId);
    if (id && mainIds.includes(id)) {
      out.error = 'SESSION_ID_2 is the same login as device 1. Link the second number on the pairing site and use the NEW session ID for device 2.';
      return out;
    }
  }

  const hasFile = fs.existsSync(path.join(root, 'accounts.json'));
  if (!hasFile && !clean(env.ACCOUNTS)) out.env.ACCOUNTS = `main,${SECOND_NAME}`;

  if (two.number) out.env.NUMBER_DEVICE_2 = two.number;
  if (two.sessionId) out.env.SESSION_ID_DEVICE_2 = two.sessionId;
  if (two.prefix) out.env.PREFIX_DEVICE_2 = two.prefix;
  if (two.timezone) out.env.TIMEZONE_DEVICE_2 = two.timezone;
  if (two.sudo) out.env.SUDO_DEVICE_2 = two.sudo;
  if (two.ownerName) out.env.OWNER_NAME_DEVICE_2 = two.ownerName;
  if (two.botName) out.env.BOT_NAME_DEVICE_2 = two.botName;

  const hasLogin = !!two.sessionId || !!linkedNumber(path.join(root, 'accounts', SECOND_NAME, 'session'));
  if (!hasLogin) {
    out.notes.push(
      '👥 Device 2 has no login yet: it will ask for one (CONSOLE_LINK=1 for a pairing code/QR), '
      + 'or put its own SESSION_ID_2 in config.env and restart.'
    );
  }
  out.notes.push(`👥 Dual session: device 1 = main folders, device 2 = accounts/${SECOND_NAME}/ (separate data and login).`);
  return out;
}

function apply(env = process.env) {
  if (env.__SAFFUL_LAUNCH_PLAN === '1') return null;
  const built = plan(env);
  if (built.error) {
    console.error(`\n❌ Dual session is not safe to start:\n   ${built.error}\n`);
    process.exit(1);
  }
  for (const [key, value] of Object.entries(built.env)) env[key] = value;
  env.__SAFFUL_LAUNCH_PLAN = '1';
  for (const note of built.notes) console.log(note);
  return built;
}

module.exports = {
  MAX_DEVICES,
  SECOND_NAME,
  apply,
  deviceCount,
  deviceSettings,
  linkedNumber,
  normalizeId,
  plan,
};

if (require.main === module) {
  require('./core/envfile').load();
  apply(process.env);
  require('./supervisor.js');
}
