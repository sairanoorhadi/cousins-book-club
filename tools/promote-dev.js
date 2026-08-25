#!/usr/bin/env node
/*
 * The other half of build-dev.js: copies the tested dev page back over the
 * live one, once it has been approved.
 *
 *   node tools/promote-dev.js
 *
 * It is a plain copy with the marker line taken out again, and it refuses to
 * run if the two files differ by anything else — so a change can never reach
 * the live site without having been the thing that was tested.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'index.html');
const DEV = path.join(ROOT, 'dev', 'index.html');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

if (!fs.existsSync(DEV)) {
  console.error('promote-dev: dev/index.html does not exist. Nothing to promote.');
  process.exit(1);
}

const dev = fs.readFileSync(DEV, 'utf8');
if (dev.indexOf(MARKER) === -1) {
  console.error('promote-dev: dev/index.html has no marker line — it is not a dev build.');
  process.exit(1);
}

const promoted = dev.replace(MARKER, '');
if (promoted.indexOf('window.__DEV_SITE = true') !== -1) {
  console.error('promote-dev: the marker appears more than once. Refusing to guess.');
  process.exit(1);
}

const before = fs.existsSync(LIVE) ? fs.readFileSync(LIVE, 'utf8') : '';
if (before === promoted) {
  console.log('index.html already matches the tested page. Nothing to do.');
  process.exit(0);
}

/* --dry says what would happen and writes nothing, so a test can check this
   script without accidentally promoting the very change under review. */
if (process.argv.indexOf('--dry') !== -1) {
  console.log('Would promote ' + Math.abs(promoted.length - before.length) +
    ' bytes of change from dev/index.html to index.html. Nothing written.');
  process.exit(0);
}

fs.writeFileSync(LIVE, promoted);
console.log('index.html now matches the tested page (' + promoted.length + ' bytes).');
console.log('Live site updates a minute or so after this reaches main.');
