#!/usr/bin/env node
'use strict';

// Builds dist/5afful-v6.tar.gz and dist/5afful-v6.zip without secrets.
// The archive is what start.js downloads; upload it anywhere with a direct
// link, or let start.js read the GitHub repository directly.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const SKIP_DIRS = new Set(['node_modules', 'session', 'data', 'accounts', '.git', 'dist']);
const SKIP_FILES = new Set([
  'config.env', '.env', 'session_id.txt', 'update.json', 'accounts.json',
  '5afful-v6.log', '5afful-v6.prev.log', '5afful-md.log',
  // working files that must never travel with a build
  'qr.png', 'qr-url.txt', 'qr-live.html', 'PAIR-SITE.md',
]);
const VERSION = require(path.join(ROOT, 'package.json')).version;

function walk(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(rel) || /\.log$/i.test(entry.name)) continue;
      found.push(rel);
    }
  }
  return found;
}

function header(name, size, mode = 0o644) {
  const block = Buffer.alloc(512);
  let short = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split('/');
    while (parts.length > 1 && Buffer.byteLength(parts.slice(-1)[0]) <= 100) {
      const tail = parts.pop();
      if (Buffer.byteLength(parts.join('/')) <= 155) {
        prefix = parts.join('/');
        short = tail;
        break;
      }
    }
  }
  block.write(short, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
  block.write('0000000\0', 108, 8);
  block.write('0000000\0', 116, 8);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  block.write('        ', 148, 8);
  block.write('0', 156, 1);
  block.write('ustar\0', 257, 6);
  block.write('00', 263, 2);
  if (prefix) block.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function tarball(files) {
  const chunks = [];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    chunks.push(header(rel, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function zip(files) {
  let AdmZip;
  try {
    AdmZip = require('adm-zip');
  } catch (err) {
    return null;
  }
  const archive = new AdmZip();
  for (const rel of files) archive.addLocalFile(path.join(ROOT, rel), path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
  return archive.toBuffer();
}

const files = walk(ROOT).sort();
fs.mkdirSync(OUT, { recursive: true });

const tar = tarball(files);
const tarFile = path.join(OUT, `5afful-v6-v${VERSION}.tar.gz`);
fs.writeFileSync(tarFile, tar);

const zipped = zip(files);
let zipFile = null;
if (zipped) {
  zipFile = path.join(OUT, `5afful-v6-v${VERSION}.zip`);
  fs.writeFileSync(zipFile, zipped);
}

const show = (file) => {
  const data = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  console.log(`${path.basename(file)}  ${(data.length / 1024).toFixed(0)} KB  sha256 ${hash}`);
};

console.log(`${files.length} files, version ${VERSION}`);
show(tarFile);
if (zipFile) show(zipFile);
