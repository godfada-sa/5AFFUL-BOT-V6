#!/usr/bin/env node
'use strict';

// The installer used to be called start.js. It is index.js now, so the normal
// panel start command works without any change. This file only forwards to it.
const fs = require('fs');
const path = require('path');

const installer = path.join(__dirname, 'index.js');
if (!fs.existsSync(installer)) {
  console.error('\nstart.js is now index.js: upload index.js instead (panel command: node index.js).\n');
  process.exit(1);
}
require(installer);
