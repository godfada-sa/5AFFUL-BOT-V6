#!/usr/bin/env node
'use strict';

// Builds dist/obfuscated: a copy of the bot with the runtime modules
// obfuscated. The entry points and the pieces that load, update or repair
// the bot stay readable so a panel can always start it.
//
//   node tools/obfuscate.js
//
// Then publish that folder (see the end of this file).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'obfuscated');
const SKIP_DIRS = new Set(['node_modules', 'session', 'data', 'accounts', '.git', 'dist']);
const SKIP_FILES = new Set([
  'config.env', '.env', 'session_id.txt', 'accounts.json',
  '5afful-v6.log', '5afful-v6.prev.log', '5afful-md.log',
  // working files that must never travel with a build
  'qr.png', 'qr-url.txt', 'qr-live.html', 'PAIR-SITE.md',
]);

const READABLE_FILES = new Set([
  'start.js',
  'index.js',
  'supervisor.js',
  'launcher.js',
  'config.js',
  'core/boot.js',
  'core/brand.js',
  'core/envfile.js',
  'core/accounts.js',
  'core/paths.js',
  'core/restart.js',
  'core/integrity.js',
  'core/updater.js',
  'core/legacyclean.js',
]);
const READABLE_DIRS = ['core/plugins/', 'tests/', 'tools/', 'examples/', 'hosting/'];

const OPTIONS = {
  target: 'node',
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  transformObjectKeys: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  splitStrings: false,
  numbersToExpressions: false,
  unicodeEscapeSequence: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: 'variable',
  stringArrayEncoding: [],
  sourceMap: false,
  log: false,
};

function stripBom(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fs.writeFileSync(file, buf.subarray(3));
}

function copyTree(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...copyTree(from, rel));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(rel) || /\.log$/i.test(entry.name)) continue;
      const to = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      // a UTF-8 BOM in front of a .json file makes JSON.parse refuse it, and the
      // published zip then looks "broken" to the updater. Never ship one.
      if (rel.endsWith('.json')) stripBom(to);
      files.push(rel);
    }
  }
  return files;
}

function readable(rel) {
  return READABLE_FILES.has(rel) || READABLE_DIRS.some((dir) => rel.startsWith(dir));
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = copyTree(ROOT);
  const js = files.filter((rel) => rel.endsWith('.js'));
  const kept = [];
  const failed = [];
  let done = 0;

  for (const rel of js) {
    if (readable(rel)) {
      kept.push(rel);
      continue;
    }
    const file = path.join(OUT, rel);
    const source = fs.readFileSync(file, 'utf8');
    try {
      const output = JavaScriptObfuscator.obfuscate(source, OPTIONS).getObfuscatedCode();
      new vm.Script(output, { filename: rel });
      fs.writeFileSync(file, output);
      done += 1;
    } catch (err) {
      failed.push(`${rel}: ${err.message}`);
    }
  }

  for (const rel of js) {
    try {
      new vm.Script(fs.readFileSync(path.join(OUT, rel), 'utf8'), { filename: rel });
    } catch (err) {
      failed.push(`${rel}: syntax check failed (${err.message})`);
    }
  }

  console.log(`copied ${files.length} files`);
  console.log(`obfuscated ${done} modules`);
  console.log(`kept readable ${kept.length} files`);

  // the updater reads this file out of the published zip: a BOM here breaks .update
  const pkgPath = path.join(OUT, 'package.json');
  const pkgBuf = fs.readFileSync(pkgPath);
  if (pkgBuf[0] === 0xef && pkgBuf[1] === 0xbb && pkgBuf[2] === 0xbf) {
    failed.push('package.json in dist still starts with a UTF-8 BOM');
  }
  try {
    JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    failed.push(`package.json in dist is not valid JSON (${err.message})`);
  }

  if (failed.length) {
    console.error(`\n${failed.length} file(s) failed:`);
    for (const line of failed) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`\nready: ${OUT}`);
}

main();
