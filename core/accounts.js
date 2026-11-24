// Several WhatsApp accounts (several bots) on the same server.
// Every account is its own bot process with its own login, settings and data, started by the same launcher (index.js).
// Nothing is shared between accounts except the program files, so one account can never overwrite the data of another.
//
// How to turn it on (nothing changes for people who do not):
//   1) a file accounts.json in the main folder:   { "accounts": [ { "name": "main" }, { "name": "shop", "prefix": "!" } ] }
//   2) or the variable ACCOUNTS=main,shop   (for hosts where you cannot edit files)
// The account called "main" keeps using the old places (data/, session/, session_id.txt), so a bot that already runs is not
// linked again. Every other account has its own folder: accounts/<name>/ (data, session and its own session_id.txt).
const fs = require('fs');
const path = require('path');

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // a runtime without SharedArrayBuffer: no pause, just try again
  }
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const MAIN = 'main';

function readEntries(root, env) {
  const file = path.join(root, 'accounts.json');
  if (fs.existsSync(file)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { entries: [], problems: [`accounts.json is not valid JSON (${err.message}). Fix it or delete it.`], source: 'accounts.json' };
    }
    const list = Array.isArray(json) ? json : Array.isArray(json?.accounts) ? json.accounts : [];
    return { entries: list, problems: [], source: 'accounts.json' };
  }
  const names = String(env.ACCOUNTS || '').split(/[\s,;]+/).filter(Boolean);
  if (names.length) return { entries: names, problems: [], source: 'ACCOUNTS' };
  return null;
}

const upper = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

// A per-account setting from the host: NUMBER_DEVICE_2, PREFIX_DEVICE_2,
// TIMEZONE_DEVICE_2, SUDO_DEVICE_2 (the launcher turns NUMBER_2
// into these names). An entry in accounts.json always wins.
const fromEnv = (env, key, name) => String((env && env[`${key}_${upper(name)}`]) || '').trim();

const build = (root, env, name, e = {}) => {
  const main = name === MAIN;
  const dir = main ? root : path.join(root, 'accounts', name);
  const pick = (field, key) => (e[field] !== undefined && String(e[field]).trim() !== '' ? String(e[field]).trim() : fromEnv(env, key, name));
  return {
    name,
    main,
    dataDir: main ? path.join(root, 'data') : path.join(dir, 'data'),
    sessionDir: main ? path.join(root, 'session') : path.join(dir, 'session'),
    sessionIdFile: main ? path.join(root, 'session_id.txt') : path.join(dir, 'session_id.txt'),
    prefix: pick('prefix', 'PREFIX'),
    timezone: pick('timezone', 'TIMEZONE'),
    number: String(pick('number', 'NUMBER')).replace(/\D/g, ''),
    sudo: pick('sudo', 'SUDO'),
    ownerName: pick('ownerName', 'OWNER_NAME'),
    botName: pick('botName', 'BOT_NAME'),
    sessionId: String(e.sessionId || '').trim() || fromEnv(env, 'SESSION_ID', name),
  };
};

// Returns null when the person did not set up accounts (the bot then starts exactly as before).
// Accounts come from accounts.json / ACCOUNTS, and from the session IDs in session_id.txt (see core/autoaccounts.js).
function load(root, env = process.env) {
  const read = readEntries(root, env);
  const problems = read ? [...read.problems] : [];
  const seen = new Set();
  const accounts = [];
  for (const raw of read ? read.entries : []) {
    const e = typeof raw === 'string' ? { name: raw } : raw && typeof raw === 'object' ? raw : null;
    const name = String(e?.name || '').trim().toLowerCase();
    if (!e || !NAME_RE.test(name)) {
      problems.push(`Account name "${e?.name ?? raw}" is not allowed: use 1-20 letters, digits, - or _ (for example "shop").`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`Account "${name}" is listed twice: the second one is ignored.`);
      continue;
    }
    seen.add(name);
    if (e.enabled === false) continue;
    accounts.push(build(root, env, name, e));
  }

  // accounts made from several session IDs in session_id.txt
  const notes = [];
  const auto = require('./autoaccounts').resolve(root, env, seen, (n) => NAME_RE.test(n));
  if (auto) {
    if (!accounts.some((a) => a.main) && !seen.has(MAIN)) accounts.unshift(build(root, env, MAIN));
    for (const name of auto.names) if (!accounts.some((a) => a.name === name) && !seen.has(name)) accounts.push(build(root, env, name));
    for (const acc of accounts) {
      const id = auto.assigned[acc.name];
      if (acc.main) acc.idAssigned = true; // main must not read the other accounts' lines in the shared file
      if (id && !acc.sessionId) {
        acc.sessionId = id;
        acc.autoId = !acc.main; // other accounts get it in their own session_id.txt
      }
    }
    for (const name of auto.news) notes.push(`➕ New session ID found: the account "${name}" was created (folder accounts/${name}/) and is starting.`);
  }
  if (!read && !auto) return null;
  if (!accounts.length) problems.push('No account is switched on, so the bot starts in the normal single way.');
  return { source: read ? read.source : 'session_id.txt', accounts: accounts.length ? accounts : null, problems, notes };
}

// the environment of the bot process of one account (index = its place in the list; the first one updates the shared files)
function envFor(acc, index, base = process.env) {
  const env = {
    ...base,
    FLASH_CHILD: '1',
    ACCOUNT_NAME: acc.name,
    TURBOFEX_DATA: acc.dataDir,
    SESSION_DIR: acc.sessionDir,
    SESSION_ID_FILE: acc.sessionIdFile,
  };
  if (index > 0) env.TURBOFEX_NO_UPDATE = '1';
  if (!acc.main) {
    env.TURBOFEX_ISOLATED = '1'; // config.env must not hand this account the login or number of the main one
    env.SESSION_ID = acc.autoId ? '' : acc.sessionId; // an ID found in the shared file is written in the account's own file instead (prepare)
    env.NUMBER = acc.number;
    env.PAIRING_NUMBER = '';
    env.OWNER_NUMBER = '';
  } else {
    if (acc.sessionId) env.SESSION_ID = acc.sessionId;
    if (acc.number) {
      env.NUMBER = acc.number;
      env.PAIRING_NUMBER = acc.number;
    }
    if (acc.idAssigned) env.TURBOFEX_ID_ASSIGNED = '1'; // the shared file has several IDs: main only uses its own
  }
  if (acc.prefix) env.BOT_PREFIX = acc.prefix;
  if (acc.timezone) env.TIMEZONE = acc.timezone;
  if (acc.sudo) env.SUDO = acc.sudo;
  return env;
}

// The account id saved in a session folder ('' when that folder is not linked).
function sessionIdentity(sessionDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'));
    const id = String(creds?.me?.id || '').replace(/:\d+@/, '@');
    return creds?.registered && id ? id : '';
  } catch (err) {
    return '';
  }
}

// Device 2 must never run with a copy of device 1's login: WhatsApp would
// log device 1 out. The copy is renamed, never deleted, so nothing is lost.
function quarantineDuplicateSession(acc, root = path.join(__dirname, '..')) {
  if (acc.main) return '';
  const main = sessionIdentity(path.join(root, 'session'));
  const mine = sessionIdentity(acc.sessionDir);
  if (!main || !mine || main !== mine) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = path.join(path.dirname(acc.sessionDir), `session-duplicate-${stamp}`);
  fs.renameSync(acc.sessionDir, aside);
  return aside;
}

function prepare(acc) {
  const duplicate = quarantineDuplicateSession(acc);
  if (duplicate) {
    console.log(`⚠️ Account "${acc.name}" had a copy of the main login. It was moved aside to ${duplicate}; that device needs its own SESSION_ID.`);
  }
  for (const d of [acc.dataDir, acc.sessionDir]) fs.mkdirSync(d, { recursive: true });
  try {
    const sessionid = require('./sessionid');
    const site = process.env.PAIR_SITE_URL || 'https://fiveafful-pair.onrender.com';
    sessionid.ensureFile(acc.sessionIdFile, site);
    // an ID that was added in the main file for this account is also written in the account's own file (if that has none).
    // The write is checked and tried again: on a busy server (a virus scanner reading the new file) one write can fail.
    if (acc.autoId && acc.sessionId && !sessionid.readFile(acc.sessionIdFile)) {
      const body = sessionid.TEMPLATE(site).replace(/^SESSION_ID=$/m, `SESSION_ID=${acc.sessionId}`);
      for (let attempt = 0; attempt < 3 && !sessionid.readFile(acc.sessionIdFile); attempt += 1) {
        if (attempt) sleepSync(30);
        try {
          fs.writeFileSync(acc.sessionIdFile, body);
        } catch (err) {
          // tried again below
        }
      }
      if (!sessionid.readFile(acc.sessionIdFile)) {
        console.log(`⚠️ Could not write the session ID of account "${acc.name}" to ${acc.sessionIdFile}.`);
      }
    }
  } catch (err) {
    // the bot makes the file itself when it starts
  }
}

module.exports = { load, envFor, prepare, quarantineDuplicateSession, sessionIdentity, NAME_RE, MAIN };
