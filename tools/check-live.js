#!/usr/bin/env node
/*
 * Answers the only question that matters after a promote: is the live site
 * actually carrying the page that was tested?
 *
 *   node tools/check-live.js
 *
 * promote-dev.js writes index.html in the working tree, and that is as far as
 * it can see. GitHub Pages serves main, so a promote that is committed to a
 * branch and never merged leaves the live site on the old page while every
 * local check says the promote worked. This script looks at origin/main
 * instead, which is what Pages publishes, and says plainly whether the tested
 * page is there.
 *
 * It only reads. It never writes, commits or pushes.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function gitQuiet(args) {
  try { return git(args); } catch (e) { return null; }
}

/* The dev page as it would look once promoted. */
const devPath = path.join(ROOT, 'dev', 'index.html');
if (!fs.existsSync(devPath)) {
  console.error('check-live: dev/index.html does not exist.');
  process.exit(1);
}
const dev = fs.readFileSync(devPath, 'utf8');
if (dev.indexOf(MARKER) === -1) {
  console.error('check-live: dev/index.html has no marker line — it is not a dev build.');
  process.exit(1);
}
const tested = dev.replace(MARKER, '');

/* What main is carrying. Fetch first, so this is not answered from a stale
   copy of the ref — the exact mistake the script exists to catch. */
if (gitQuiet(['fetch', 'origin', 'main']) === null) {
  console.log('Could not reach origin — answering from the last fetched copy of main.');
}
const onMain = gitQuiet(['show', 'origin/main:index.html']);
if (onMain === null) {
  console.error('check-live: could not read index.html from origin/main.');
  process.exit(1);
}

const mainSha = (gitQuiet(['rev-parse', '--short', 'origin/main']) || '?').trim();
const headSha = (gitQuiet(['rev-parse', '--short', 'HEAD']) || '?').trim();
const branch = (gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']) || '?').trim();

if (onMain === tested) {
  console.log('Live is carrying the tested page. origin/main is ' + mainSha + '.');
  process.exit(0);
}

/* It is not there. Say which of the two ways it went wrong, because the fix
   differs: an unmerged commit needs a merge, an unpromoted one needs a
   promote first. */
const live = fs.existsSync(path.join(ROOT, 'index.html'))
  ? fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') : '';
const merged = gitQuiet(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']) !== null;

console.log('LIVE IS NOT CARRYING THE TESTED PAGE.');
console.log('  origin/main is ' + mainSha + ', you are on ' + branch + ' at ' + headSha + '.');
if (live !== tested) {
  console.log('  index.html here does not match dev/index.html either.');
  console.log('  Run: node tools/promote-dev.js, commit, then merge into main.');
} else if (!merged) {
  console.log('  index.html here is correct, so the promote ran — but ' + headSha +
    ' is not on main, and main is what Pages serves.');
  console.log('  Merge ' + branch + ' into main and push. Nothing else is missing.');
} else {
  console.log('  ' + headSha + ' is on main, so something else changed index.html on main since.');
  console.log('  Compare: git diff origin/main -- index.html');
}
process.exit(1);
