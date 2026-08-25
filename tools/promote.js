#!/usr/bin/env node
/*
 * Promotes the tested test-site page to the live one.
 *
 *   node tools/promote.js
 *
 * dev/index.html is index.html plus one marker line, so this is that copy in
 * reverse: strip the marker, write index.html. Nothing is re-applied by hand
 * and nothing can be forgotten, which is the whole reason the two files differ
 * by one line and not by a patch.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEV = path.join(ROOT, 'dev', 'index.html');
const LIVE = path.join(ROOT, 'index.html');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

if (!fs.existsSync(DEV)) {
  console.error('promote: dev/index.html does not exist. Run tools/build-dev.js first.');
  process.exit(1);
}
const dev = fs.readFileSync(DEV, 'utf8');
if (dev.indexOf(MARKER) === -1) {
  console.error('promote: dev/index.html has no marker line, so it was not built by build-dev.js.');
  console.error('Refusing to copy it over the live page.');
  process.exit(1);
}
const promoted = dev.replace(MARKER, '');
/* index.html legitimately mentions __DEV_SITE — that is the flag the marker
   sets. What must not survive is a second copy of the marker LINE itself. */
if (promoted.indexOf(MARKER) !== -1) {
  console.error('promote: the marker line appears more than once. Rebuild with build-dev.js.');
  process.exit(1);
}
if (!/var DEV = !!window\.__DEV_SITE;/.test(promoted)) {
  console.error('promote: the promoted page has no DEV flag, so the test site would');
  console.error('behave like the live one. Refusing.');
  process.exit(1);
}

const before = fs.existsSync(LIVE) ? fs.readFileSync(LIVE, 'utf8') : '';
if (before === promoted) {
  console.log('promote: the live page already matches the test one. Nothing to do.');
  process.exit(0);
}
fs.writeFileSync(LIVE, promoted);
console.log('index.html updated from dev/index.html (' + promoted.length + ' bytes).');
console.log('The live site changes as soon as this is on main.');
