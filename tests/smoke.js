/* A wide, shallow pass over the page: every tab and section drawn, the big
 * modals opened, signed out and signed in, with any page error failing the
 * run. It is not a substitute for a suite per feature -- it is the net that
 * catches a change that breaks the page outright.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/smoke.js [page.html]
 */
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {
    bad++; console.log(' BUG  ' + String(label).padEnd(50),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(50), JSON.stringify(value));
};

function pageFile() {
  if (process.argv[2]) return process.argv[2];
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'index.html'), 'utf8');
  const out = path.join(os.tmpdir(), 'smoke-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

(async () => {
  const PAGE = pageFile();
  /* The real published state, so the pass runs over the club's own data. */
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const inbox = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'inbox.json'), 'utf8'));
  const ME = truth.members[0];

  const srv = http.createServer((q, r) => {
    let u = q.url.split('?')[0]; if (u === '/') u = '/index.html';
    if (/state\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(truth)); }
    if (/inbox\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(inbox)); }
    const f = /index\.html$/.test(u) ? PAGE : path.join(ROOT, u);
    if (!fs.existsSync(f)) { r.writeHead(404); return r.end('x'); }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(fs.readFileSync(f));
  });
  await new Promise(r => srv.listen(8413, r));
  const b = await chromium.launch();

  for (const w of [1280, 390]) {
    for (const signedIn of [false, true]) {
      const who = w + 'px ' + (signedIn ? 'signed in' : 'signed out');
      console.log('\n=== ' + who + ' ===');
      const errs = [];
      const p = await b.newPage({ viewport: { width: w, height: 1200 }, hasTouch: w <= 700 });
      p.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
      await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
        contentType: 'application/json', body: '{"docs":[]}' }));
      await p.route('https://script.google.com/**', async r => {
        const q = JSON.parse(r.request().postData() || '{}');
        const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(o) });
        if (q.kind === 'session') return reply(signedIn
          ? { ok: true, profile: { memberId: ME.id, name: ME.name, emailHint: 's@x' } }
          : { ok: false });
        if (q.kind === 'nom-mine' || q.kind === 'vote-mine') return reply({ ok: true, mine: null });
        return reply({ ok: false });
      });
      await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
      if (signedIn) await p.addInitScript(() => {
        try { localStorage.setItem('marginNotes.session', 'tok'); } catch (e) {} });
      await p.goto('http://localhost:8413/', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1800);

      check('the hero drew a book', await p.evaluate(() =>
        (document.querySelector('#heroTitle,.hero__head h1,.hero h1') || {}).textContent || ''),
        await p.evaluate(() => !!document.querySelector('.hero__cover')));
      /* every tab in the recommendations section */
      const tabs = await p.evaluate(() => [...document.querySelectorAll('[id^="tab-"]')].map(t => t.id));
      for (const id of tabs) {
        await p.evaluate(i => { const t = document.getElementById(i); if (t) t.click(); }, id);
        await p.waitForTimeout(250);
      }
      check('every tab clicks through', tabs.length, tabs.length > 0);
      await p.evaluate(() => { const t = document.getElementById('tab-recs'); if (t) t.click(); });
      await p.waitForTimeout(300);
      /* a recommendation's modal */
      const recId = await p.evaluate(() => {
        const c = document.querySelector('#recGrid [data-rec]');
        return c ? c.getAttribute('data-rec') : null; });
      if (recId) {
        await p.evaluate(i => document.querySelector('[data-rec="' + i + '"]').click(), recId);
        await p.waitForTimeout(500);
        check('a book modal opens', await p.evaluate(() =>
          (document.getElementById('bookModalBody') || {}).childElementCount || 0),
          await p.evaluate(() => {
            const m = document.getElementById('bookModalBody');
            return !!m && m.textContent.trim().length > 20; }));
        await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      }
      /* the long sections below */
      const counts = await p.evaluate(() => ({
        members: document.querySelectorAll('.memhead').length,
        shelf: document.querySelectorAll('.shelfrow').length,
        five: document.querySelectorAll('.memtiles--five').length,
      }));
      check('members, shelf and the fives are drawn', counts,
        counts.members > 0 && counts.five > 0);
      /* the menu */
      await p.evaluate(() => { const m = document.getElementById('menuOpen'); if (m) m.click(); });
      await p.waitForTimeout(350);
      check('the menu opens', await p.evaluate(() => {
        const pa = document.querySelector('.menu__panel');
        return !!pa && getComputedStyle(pa).display !== 'none'; }),
        await p.evaluate(() => {
          const pa = document.querySelector('.menu__panel');
          return !!pa && getComputedStyle(pa).display !== 'none'; }));
      await p.keyboard.press('Escape'); await p.waitForTimeout(250);
      /* nothing may scroll sideways */
      const side = await p.evaluate(() =>
        document.documentElement.scrollWidth - window.innerWidth);
      check('no sideways scroll', side, side <= 1);
      check('no page errors', errs.slice(0, 3), errs.length === 0);
      await p.close();
    }
  }
  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
