/* Every pop-up window closes by its cross or Escape, and by nothing else.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/modalclose.js [page.html]
 *
 * The one that started this: select text in a field, let go a few pixels
 * outside the box, and the browser calls that a click on the backdrop. It
 * used to close the panel and take what had been typed with it.
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
  const out = path.join(os.tmpdir(), 'modalclose-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

/* Every panel on the page, by the id its scrim carries. */
const SCRIMS = ['rateScrim', 'dropScrim', 'bulkScrim', 'lightbox', 'loginScrim', 'meScrim',
  'memberScrim', 'getScrim', 'bookScrim', 'meetScrim', 'badgeScrim', 'adminScrim',
  'tourPickScrim', 'howScrim'];

(async () => {
  const PAGE = pageFile();
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const ME = truth.members[0];
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
  await new Promise(r => srv.listen(8461, r));
  const b = await chromium.launch();
  const open = async (signedIn) => {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', async r => {
      const q = JSON.parse(r.request().postData() || '{}');
      const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(o) });
      if (q.kind === 'session') return reply(signedIn
        ? { ok: true, profile: { memberId: ME.id, name: ME.name, emailHint: 's@x',
            type: 'member', isMember: true, tourDone: true } }
        : { ok: false });
      if (q.kind === 'profile-get') return reply({ ok: true,
        profile: { name: ME.name, books: [], memberId: ME.id, emailHint: 's@x' } });
      if (q.kind === 'notify-get') return reply({ ok: true, books: [] });
      if (q.kind === 'nom-mine' || q.kind === 'vote-mine') return reply({ ok: true, mine: null });
      return reply({ ok: false });
    });
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    if (signedIn) await p.addInitScript(() => { try {
      localStorage.setItem('marginNotes.session', 'tok');
      localStorage.setItem('marginNotes.tourDone', '1'); } catch (e) {} });
    await p.goto('http://localhost:8461/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1700);
    return p;
  };
  const shown = (p, id) => p.evaluate(i => !document.getElementById(i).hidden, id);

  console.log('=== every panel, backdrop pressed ===');
  {
    /* Shown straight from the DOM: how a panel is opened is not what is
       under test, and three of them (the rating prompt, the confirm box,
       the bulk-dismiss bar) need a state the club's file may not be in. */
    const p = await open(false);
    for (const id of SCRIMS) {
      await p.evaluate(i => {
        const s = document.getElementById(i);
        s.hidden = false;
        /* something in it, so the backdrop is the only thing a corner
           press can land on */
        if (!s.querySelector('.modal, .lightbox__inner')) {
          const m = document.createElement('div');
          m.className = 'modal'; m.style.cssText = 'width:200px;height:120px';
          s.appendChild(m);
        }
      }, id);
      await p.waitForTimeout(80);
      /* the top-left corner of the scrim: inside the backdrop, outside the box */
      await p.mouse.click(6, 6);
      await p.waitForTimeout(120);
      const still = await shown(p, id);
      check(id + ': the backdrop does nothing', still, still === true);
      /* Put it away again by hand. Escape is not used here: it closes the
         top of the stack openScrim keeps, and these were shown straight
         from the DOM without going through it. Escape is proved on panels
         opened the real way, below and in tests/modalstack.js. */
      await p.evaluate(i => { document.getElementById(i).hidden = true; }, id);
      await p.waitForTimeout(60);
    }
    await p.close();
  }

  console.log('\n=== the real panels, opened the real way ===');
  {
    const p = await open(false);
    const cases = [
      ['bookScrim', async () => { await p.evaluate(() => {
        const t = document.getElementById('tab-recs'); if (t) t.click(); });
        await p.waitForTimeout(400);
        await p.evaluate(() => document.querySelector('#recGrid [data-rec]').click()); }],
      ['loginScrim', async () => { await p.click('#loginOpen'); }],
      ['memberScrim', async () => { await p.click('#signupOpen'); }],
      ['badgeScrim', async () => { await p.evaluate(() => {
        const n = document.querySelector('#badges [data-badge]'); if (n) n.click(); }); }],
      ['howScrim', async () => { await p.click('#menuOpen'); await p.waitForTimeout(200);
        await p.click('#menuHow'); }],
      ['getScrim', async () => { await p.evaluate(() => {
        const n = document.getElementById('heroGet'); if (n) n.click(); }); }],
    ];
    for (const [id, go] of cases) {
      await go();
      await p.waitForTimeout(600);
      if (!await shown(p, id)) { check(id + ': could not be opened', id, false); continue; }
      await p.mouse.click(6, 6);
      await p.waitForTimeout(150);
      check(id + ': stays open on a backdrop press', await shown(p, id),
        (await shown(p, id)) === true);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(250);
      check('  but Escape closes it', await shown(p, id), (await shown(p, id)) === false);
      await go();
      await p.waitForTimeout(600);
      await p.click('[data-close="' + id + '"]');
      await p.waitForTimeout(250);
      check('  and so does the cross', await shown(p, id), (await shown(p, id)) === false);
    }
    await p.close();
  }

  console.log('\n=== the one that started it ===');
  {
    const p = await open(true);
    await p.click('#menuOpen'); await p.waitForTimeout(250);
    await p.click('#menuProfile'); await p.waitForTimeout(800);
    check('Edit profile is open', await shown(p, 'meScrim'), (await shown(p, 'meScrim')) === true);
    const box = await p.evaluate(() => {
      const n = document.getElementById('profGoodreads');
      if (!n) return null;
      n.value = 'https://www.goodreads.com/user/show/12345';
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2),
        right: Math.round(r.right) };
    });
    check('  a field to type in', !!box, !!box);
    if (box) {
      /* press inside the field, drag out past the panel, let go: the browser
         calls that a click on the backdrop */
      await p.mouse.move(box.x, box.y);
      await p.mouse.down();
      await p.mouse.move(box.x + 120, box.y, { steps: 6 });
      await p.mouse.move(8, box.y, { steps: 10 });
      await p.mouse.up();
      await p.waitForTimeout(250);
      check('  selecting out of the box leaves it open', await shown(p, 'meScrim'),
        (await shown(p, 'meScrim')) === true);
      check('  with what was typed still in it', await p.evaluate(() =>
        (document.getElementById('profGoodreads') || {}).value),
        (await p.evaluate(() => (document.getElementById('profGoodreads') || {}).value)) ===
          'https://www.goodreads.com/user/show/12345');
    }
    /* unsaved work is still asked about, on the cross */
    let asked = '';
    p.on('dialog', d => { asked = d.message(); d.dismiss(); });
    await p.evaluate(() => {
      const n = document.getElementById('profGoodreads');
      n.value = 'https://www.goodreads.com/user/show/999';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.waitForTimeout(200);
    await p.click('[data-close="meScrim"]');
    await p.waitForTimeout(350);
    check('the cross still asks about unsaved changes', asked.slice(0, 40),
      /aren.t saved/i.test(asked));
    check('  and no still means no', await shown(p, 'meScrim'),
      (await shown(p, 'meScrim')) === true);
    await p.close();
  }

  console.log('\n=== the menu is not a window ===');
  {
    const p = await open(false);
    await p.click('#menuOpen'); await p.waitForTimeout(250);
    check('it opens', await p.evaluate(() => !document.getElementById('menuPanel').hidden),
      await p.evaluate(() => !document.getElementById('menuPanel').hidden));
    await p.mouse.click(640, 700);
    await p.waitForTimeout(250);
    check('  and still closes on an outside click',
      await p.evaluate(() => document.getElementById('menuPanel').hidden),
      await p.evaluate(() => document.getElementById('menuPanel').hidden) === true);
    await p.close();
  }

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
