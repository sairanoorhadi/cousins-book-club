/* Pop-ups opened from inside pop-ups.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/modalstack.js [page.html]
 *
 * There used to be a z-index per kind of panel -- badges 110, notes 120, the
 * book 130 -- so the order was decided by what a panel WAS rather than by
 * when it was opened. Open the book and then a meeting from inside it and
 * the notes came up behind the book. They are a stack now.
 */
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {
    bad++; console.log(' BUG  ' + String(label).padEnd(52),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(52), JSON.stringify(value));
};
function pageFile() {
  if (process.argv[2]) return process.argv[2];
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'index.html'), 'utf8');
  const out = path.join(os.tmpdir(), 'modalstack-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}
const IDS = ['rateScrim', 'dropScrim', 'bulkScrim', 'lightbox', 'loginScrim', 'meScrim',
  'memberScrim', 'getScrim', 'bookScrim', 'meetScrim', 'badgeScrim', 'adminScrim',
  'tourPickScrim', 'howScrim'];

(async () => {
  const PAGE = pageFile();
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const ME = truth.members[0];
  /* The photo block only draws on a party meeting, so the three-deep chain
     is picked out of the club's own file rather than written down here. */
  const party = (truth.meetings || []).filter(m => m.kind === 'party')[0];
  const srv = http.createServer((q, r) => {
    let u = q.url.split('?')[0]; if (u === '/') u = '/index.html';
    if (/state\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(truth)); }
    if (/inbox\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end('{"items":[]}'); }
    const f = /index\.html$/.test(u) ? PAGE : path.join(ROOT, u);
    if (!fs.existsSync(f)) { r.writeHead(404); return r.end('x'); }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(fs.readFileSync(f));
  });
  await new Promise(r => srv.listen(8473, r));
  const b = await chromium.launch();

  const open = async (w) => {
    const p = await b.newPage({ viewport: { width: w || 1280, height: 900 },
      hasTouch: (w || 1280) <= 700 });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', async r => {
      const q = JSON.parse(r.request().postData() || '{}');
      const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(o) });
      if (q.kind === 'session') return reply({ ok: true, profile: { memberId: ME.id,
        name: ME.name, emailHint: 's@x', type: 'member', isMember: true, tourDone: true } });
      if (q.kind === 'nom-mine' || q.kind === 'vote-mine') return reply({ ok: true, mine: null });
      if (q.kind === 'profile-get') return reply({ ok: true,
        profile: { name: ME.name, books: [], memberId: ME.id } });
      if (q.kind === 'notify-get') return reply({ ok: true, books: [] });
      /* one photo on every meeting, so the lightbox is reachable from the
         notes and a three-deep chain can be walked */
      if (q.kind === 'photo-list') return reply({ ok: true, photos: [
        { id: 'ph-1', url: 'https://example.invalid/p.jpg', by: 'Saira', caption: 'The table' }] });
      return reply({ ok: false });
    });
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    await p.route('https://example.invalid/**', r => r.fulfill({ status: 200,
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64') }));
    await p.addInitScript(() => { try {
      localStorage.setItem('marginNotes.session', 'tok');
      localStorage.setItem('marginNotes.tourDone', '1'); } catch (e) {} });
    await p.goto('http://localhost:8473/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    return p;
  };
  /* What is open, in painting order, and which one a press in the middle of
     the screen would land on. */
  const look = (p) => p.evaluate(ids => {
    const open = ids.filter(i => !document.getElementById(i).hidden)
      .map(i => ({ id: i, z: Number(getComputedStyle(document.getElementById(i)).zIndex),
        under: document.getElementById(i).classList.contains('scrim--under') }))
      .sort((a, c) => a.z - c.z);
    const mid = document.elementFromPoint(window.innerWidth / 2, 60);
    const host = mid && mid.closest ? mid.closest('.scrim') : null;
    return { open, ids: open.map(o => o.id), top: host ? host.id : null,
      locked: getComputedStyle(document.body).overflow === 'hidden',
      focus: document.activeElement ? (document.activeElement.id ||
        document.activeElement.className || document.activeElement.tagName) : null };
  }, IDS);
  const clickIn = (p, sel) => p.evaluate(s => {
    const n = document.querySelector(s); if (n) n.click(); return !!n; }, sel);
  const closeTop = async (p) => {
    const id = (await look(p)).ids.slice(-1)[0];
    await p.click('#' + id + ' [data-close]');
    await p.waitForTimeout(300);
  };

  for (const w of [1280, 390]) {
    console.log('\n=== the reported chain, ' + w + 'px ===');
    const p = await open(w);
    /* the hero cover opens the book this club is reading */
    await clickIn(p, '#heroCover');
    await p.waitForTimeout(600);
    let s = await look(p);
    check('the book is open', s.ids, s.ids.length === 1 && s.ids[0] === 'bookScrim');
    /* scrolled down to Meetings, which is where the press comes from */
    /* .modal is a column with its body scrolling inside it, so the body is
       the scroller -- which is what "still scrolled to Meetings" means. */
    await p.evaluate(() => { document.getElementById('bookModalBody').scrollTop = 200; });
    await p.waitForTimeout(150);
    const was = await p.evaluate(() => document.getElementById('bookModalBody').scrollTop);
    check('  and scrolled down it', was, was > 0);
    const got = await clickIn(p, '#bookModalBody [data-meet]');
    check('  it has a meeting to open', got, got === true);
    await p.waitForTimeout(600);
    s = await look(p);
    check('the notes open ON TOP of the book', [s.ids, s.top],
      s.ids.length === 2 && s.top === 'meetScrim');
    check('  the book is still open underneath', s.ids.indexOf('bookScrim'), s.ids[0] === 'bookScrim');
    check('  and only the top one dims', s.open.map(o => [o.id, o.under]),
      s.open[0].under === true && s.open[1].under === false);
    await closeTop(p);
    s = await look(p);
    check('its cross closes only itself', s.ids, s.ids.length === 1 && s.ids[0] === 'bookScrim');
    check('  the book is back on top, undimmed', s.open[0].under, s.open[0].under === false);
    const now = await p.evaluate(() => document.getElementById('bookModalBody').scrollTop);
    check('  still scrolled where it was', [was, now], now === was);
    check('  and the page is still held', s.locked, s.locked === true);
    await closeTop(p);
    s = await look(p);
    check('the last one lets the page go', [s.ids, s.locked],
      s.ids.length === 0 && s.locked === false);
    await p.close();
  }

  console.log('\n=== the same from Previous Books ===');
  {
    const p = await open(1280);
    await clickIn(p, '#shelfList [data-book]');
    await p.waitForTimeout(600);
    await clickIn(p, '#bookModalBody [data-meet]');
    await p.waitForTimeout(600);
    const s = await look(p);
    check('book then notes, notes on top', [s.ids, s.top],
      s.ids.length === 2 && s.ids[0] === 'bookScrim' && s.top === 'meetScrim');
    await p.close();
  }

  console.log('\n=== three deep, closed back one at a time ===');
  if (!party) {
    check('no party meeting in the file to chain through', !!party, false);
  } else {
    const p = await open(1280);
    await clickIn(p, '#shelfList [data-book="' + party.bookId + '"]');
    await p.waitForTimeout(600);
    await clickIn(p, '#bookModalBody [data-meet="' + party.id + '"]');
    await p.waitForTimeout(1200);
    const shot = await clickIn(p, '#meetModalBody [data-photoview]');
    check('the notes have a photo to open', shot, shot === true);
    await p.waitForTimeout(600);
    let s = await look(p);
    check('three open, newest on top', [s.ids, s.top],
      s.ids.length === 3 && s.top === 'lightbox' &&
      s.ids[0] === 'bookScrim' && s.ids[1] === 'meetScrim');
    check('  the two underneath are both undimmed',
      s.open.map(o => o.under), s.open[0].under && s.open[1].under && !s.open[2].under);
    await closeTop(p);
    s = await look(p);
    check('back to two, the notes on top', [s.ids, s.top],
      s.ids.length === 2 && s.top === 'meetScrim');
    await closeTop(p);
    s = await look(p);
    check('back to one, the book on top', [s.ids, s.top],
      s.ids.length === 1 && s.top === 'bookScrim');
    await closeTop(p);
    s = await look(p);
    check('and back to the page', [s.ids, s.locked], s.ids.length === 0 && s.locked === false);
    await p.close();
  }

  console.log('\n=== Escape takes one layer ===');
  {
    const p = await open(1280);
    await clickIn(p, '#heroCover');
    await p.waitForTimeout(600);
    await clickIn(p, '#bookModalBody [data-meet]');
    await p.waitForTimeout(600);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(350);
    let s = await look(p);
    check('the notes go, the book stays', s.ids, s.ids.length === 1 && s.ids[0] === 'bookScrim');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(350);
    s = await look(p);
    check('  and then the book', s.ids, s.ids.length === 0);
    await p.close();
  }

  console.log('\n=== one already in the stack is raised, not repeated ===');
  {
    const p = await open(1280);
    await clickIn(p, '#shelfList [data-badge]');
    await p.waitForTimeout(600);
    await clickIn(p, '#badgeModalBody [data-meet]');
    await p.waitForTimeout(600);
    let s = await look(p);
    check('the badge, then its notes', [s.ids, s.top],
      s.ids.length === 2 && s.ids[0] === 'badgeScrim' && s.top === 'meetScrim');
    /* the same panel asked for again from underneath */
    await clickIn(p, '#shelfList [data-badge]');
    await p.waitForTimeout(600);
    s = await look(p);
    check('asking for the badge again raises it', [s.ids, s.top],
      s.ids.length === 2 && s.top === 'badgeScrim' && s.ids[0] === 'meetScrim');
    check('  rather than opening a second one', s.ids.length, s.ids.length === 2);
    await p.close();
  }

  console.log('\n=== focus goes back to what opened each one ===');
  {
    const p = await open(1280);
    await p.evaluate(() => {
      const n = document.querySelector('#shelfList [data-book]');
      n.id = 'theOpener'; n.focus(); n.click();
    });
    await p.waitForTimeout(700);
    check('the cross takes the focus first', (await look(p)).focus,
      /xbtn/.test((await look(p)).focus || ''));
    await closeTop(p);
    await p.waitForTimeout(200);
    check('  and closing gives it back to the opener', (await look(p)).focus,
      (await look(p)).focus === 'theOpener');
    await p.close();
  }

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
