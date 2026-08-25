#!/usr/bin/env node
/*
 * Builds dev/index.html from index.html.
 *
 * The only difference between the two files is one marker line, inserted just
 * before the page's script. Everything it changes — the data file the dev copy
 * reads and commits, the endpoint being switched off, the warning band — is
 * decided inside index.html by the DEV flag, not here.
 *
 * That is the point: promoting a tested change to the live site is a plain
 * copy of index.html, with nothing to re-apply and nothing to forget.
 *
 *   node tools/build-dev.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'dev', 'index.html');
const SEED = path.join(ROOT, 'data', 'state.json');
const DEV_DATA = path.join(ROOT, 'dev', 'data', 'state.json');

const MARKER = '<script>window.__DEV_SITE = true;</script>\n';
/* the page has one <script> block of its own; the marker goes ahead of it */
const ANCHOR = '<script>\n(function(){\n"use strict";';

const src = fs.readFileSync(SRC, 'utf8');

const at = src.indexOf(ANCHOR);
if (at === -1) {
  console.error('build-dev: could not find the page script to insert before.');
  console.error('If index.html was restructured, update ANCHOR in this file.');
  process.exit(1);
}
if (!/var DEV = !!window\.__DEV_SITE;/.test(src)) {
  console.error('build-dev: index.html has no DEV flag — the marker would do nothing.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, src.slice(0, at) + MARKER + src.slice(at));

/* Seed the dev data from the live data the first time only. After that it is
 * the test site's own copy and gets to drift — that is what it is for. */
let seeded = 'kept the existing dev data';
if (!fs.existsSync(DEV_DATA) && fs.existsSync(SEED)) {
  const live = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  live.club = live.club || {};
  live.club.formEndpoint = '';          // belt as well as braces; the page clears it too
  live.club.name = live.club.name || 'Book Club';
  fs.mkdirSync(path.dirname(DEV_DATA), { recursive: true });
  fs.writeFileSync(DEV_DATA, JSON.stringify(live, null, 2));
  seeded = 'seeded dev/data/state.json from the live data';
}

const bytes = fs.statSync(OUT).size;
console.log('dev/index.html written (' + bytes + ' bytes), ' + seeded + '.');
console.log('Difference from index.html: one line — ' + MARKER.trim());
