#!/usr/bin/env node
/*
 * Turns a note's free-text author into member references, once.
 *
 *   node tools/migrate-note-authors.js data/state.json          # report only
 *   node tools/migrate-note-authors.js data/state.json --write  # do it
 *
 * A note used to carry whoever typed their name into the box: "Saira",
 * "Filza, Eliza", "Summar", "Everyone". Each comma-separated name that matches
 * a member becomes that member's id in byIds. Anything left over stays in `by`
 * exactly as it was written, because not every name is a member — "Everyone"
 * is not a person at all, and someone can be in the notes before they are on
 * the list. Nothing is guessed and nothing is discarded.
 *
 * Safe to run twice: a note that already has ids is left alone.
 */
const fs = require('fs');

const file = process.argv[2];
const write = process.argv.indexOf('--write') !== -1;
if (!file) { console.error('usage: migrate-note-authors.js <state.json> [--write]'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const known = new Map();
(state.members || []).forEach(m => { if (m && m.name) known.set(m.name.trim().toLowerCase(), m.id); });

const rows = [];
let touched = 0, already = 0, blank = 0, nomatch = 0;

(state.meetings || []).forEach(meeting => {
  ['predictions', 'points'].forEach(field => {
    (meeting[field] || []).forEach(note => {
      if (Array.isArray(note.byIds) && note.byIds.length) { already++; return; }
      if (!Array.isArray(note.byIds)) note.byIds = [];
      const text = String(note.by || '').trim();
      if (!text) { blank++; note.by = ''; return; }

      const ids = [], rest = [];
      text.split(',').forEach(part => {
        const name = part.trim();
        if (!name) return;
        const id = known.get(name.toLowerCase());
        if (id) { if (!ids.includes(id)) ids.push(id); }
        else rest.push(name);
      });
      note.byIds = ids;
      note.by = rest.join(', ');
      /* Nothing matched, so nothing changed — the text is still the text. Say
         so rather than counting it as work done, or a second run reports the
         same notes again and reads as though it kept converting them. */
      if (!ids.length) { nomatch++; }
      else touched++;
      rows.push({ field, was: text,
        now: ids.map(id => (state.members.find(m => m.id === id) || {}).name).join(', ') || '—',
        kept: note.by || '—' });
    });
  });
});

const seen = new Map();
rows.forEach(r => {
  const k = r.was + ' | ' + r.now + ' | ' + r.kept;
  seen.set(k, (seen.get(k) || 0) + 1);
});
console.log(file);
console.log('  ' + blank + ' with nobody named, left alone');
if (already) console.log('  ' + already + ' already converted, left alone');
console.log('  ' + touched + ' converted to member references');
if (nomatch) console.log('  ' + nomatch + ' with no name that matches a member, kept as written');
console.log('');
console.log('   ' + 'was'.padEnd(30) + 'members'.padEnd(30) + 'kept as text');
console.log('   ' + '-'.repeat(74));
[...seen.entries()].forEach(([k, n]) => {
  const [was, now, kept] = k.split(' | ');
  console.log('   ' + (was + (n > 1 ? ' x' + n : '')).padEnd(30) + now.padEnd(30) + kept);
});

if (!write) { console.log('\nReport only. Pass --write to save.'); process.exit(0); }
fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
console.log('\nWritten to ' + file + '.');
