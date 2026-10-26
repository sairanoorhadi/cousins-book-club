/* The one tag a recommendation's cover carries, the nomination history in
   its modal, and the hover panel that used to hang below the card.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/rectags.js [page.html]
 *
 * The page defaults to dev/index.html with the dev marker taken out -- the
 * live shape, where signing in works, which is what the tag rules need. The
 * script is mocked; what is under test is the page.
 */
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {           /* a literal where the verdict goes
                                              passes every time; say so */
    bad++; console.log(' BUG  ' + String(label).padEnd(54),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(54), JSON.stringify(value));
};

function pageFile() {
  if (process.argv[2]) return process.argv[2];
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'index.html'), 'utf8');
  const out = path.join(os.tmpdir(), 'rectags-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

(async () => {
  const PAGE = pageFile();
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const ME = base.members[0];

  const rec = (id, title, o) => Object.assign({
    id, title, author: 'A Writer', status: 'approved', by: 'Someone', pages: 300,
    genres: ['Fantasy'], tropes: [], ageMin: 10, ageMax: 18, blurb: 'A book.',
    cover: '', ratings: [], endorsements: [], dislikes: [], shortlist: false }, o || {});

  /* One round gone by and one taking nominations now. */
  const AUG = { id: 'nom-aug', type: 'nomination', kind: 'nominate', candidates: [],
    opensAt: '2026-08-05T10:00:00Z', closesAt: '2026-08-10T10:00:00Z',
    cancelledAt: null, closedAt: '2026-08-10T10:01:00Z', turnout: 3,
    nominated: [{ id: 'r1', n: 1, org: false }, { id: 'r2', n: 2, org: false },
                { id: 'r5', n: 1, org: false }, { id: 'r7', n: 1, org: false }],
    totals: null, winner: null, tied: null };
  const OCT = { id: 'nom-oct', type: 'nomination', kind: 'nominate', candidates: [],
    opensAt: '2026-10-21T11:00:00Z', closesAt: '2026-10-26T00:00:00Z',
    cancelledAt: null, closedAt: null, turnout: 4,
    nominated: [{ id: 'r1', n: 1, org: false }, { id: 'r2', n: 1, org: false },
                { id: 'r3', n: 1, org: false }, { id: 'r4', n: 3, org: false },
                { id: 'r7', n: 1, org: false }],
    totals: null, winner: null, tied: null };

  const fresh = (rounds) => {
    const st = JSON.parse(JSON.stringify(base));
    st.members.forEach(m => { m.top5 = []; });
    st.books = []; st.meetings = [];
    st.recs = [
      rec('r1', 'The Shortlisted One', { shortlist: true }),
      rec('r2', 'The Returning One'),
      rec('r3', 'My Own Pick'),
      rec('r4', 'The Popular One'),
      rec('r5', 'The One From August'),
      rec('r6', 'The Unknown One'),
      rec('r7', 'Mine And Back Again'),
    ];
    st.votes = rounds;
    return st;
  };

  let truth, nomMine = null, signedIn = true;
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
  await new Promise(r => srv.listen(8411, r));
  const b = await chromium.launch();

  const open = async (w) => {
    const p = await b.newPage({ viewport: { width: w, height: 1200 }, hasTouch: w <= 700 });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    await p.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', async r => {
      const q = JSON.parse(r.request().postData() || '{}');
      const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(o) });
      if (q.kind === 'session') return reply(signedIn
        ? { ok: true, profile: { memberId: ME.id, name: ME.name, emailHint: 's@x' } }
        : { ok: false });
      if (q.kind === 'nom-mine') return reply({ ok: true, mine: nomMine });
      if (q.kind === 'vote-mine') return reply({ ok: true, mine: null });
      return reply({ ok: false });
    });
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    await p.addInitScript(() => { try { localStorage.setItem('marginNotes.session', 'tok'); }
      catch (e) {} });
    await p.goto('http://localhost:8411/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1700);
    await p.evaluate(() => { const t = document.getElementById('tab-recs'); if (t) t.click(); });
    await p.waitForTimeout(500);
    return p;
  };

  /* Every card's tags, as drawn. */
  const tags = p => p.evaluate(() => {
    const seen = {};
    document.querySelectorAll('#recGrid .reccard-wrap').forEach(w => {
      const id = w.querySelector('[data-rec]').getAttribute('data-rec');
      const pill = w.querySelector('.reccard__tag');
      const line = w.querySelector('.reccard__nomline');
      const vis = n => n ? getComputedStyle(n).display : 'absent';
      seen[id] = {
        pills: w.querySelectorAll('.reccard__tag').length,
        lines: w.querySelectorAll('.reccard__nomline').length,
        text: pill ? pill.textContent : (line ? line.textContent : null),
        pillShown: vis(pill) !== 'none' && vis(pill) !== 'absent',
        lineShown: vis(line) !== 'none' && vis(line) !== 'absent',
        cls: pill ? pill.className : (line ? line.className : ''),
        bg: pill ? getComputedStyle(pill).backgroundColor : null,
        colour: line ? getComputedStyle(line).color : null,
        /* nothing from the old stack of badges may be left anywhere */
        legacy: w.querySelectorAll('.reccard__nom,.reccard__mine,.reccard__short,.reccard__onshort').length,
      };
    });
    return seen;
  });

  const modal = async (p, id) => {
    await p.evaluate(i => { const c = document.querySelector('[data-rec="' + i + '"]'); if (c) c.click(); }, id);
    await p.waitForTimeout(450);
    const out = await p.evaluate(() => {
      const body = document.getElementById('bookModalBody');
      const h = body.querySelector('.nomhist');
      const endorse = body.querySelector('.endorse');
      return { hist: h ? h.textContent.trim() : null,
        histAfterEndorse: !!h && !!endorse &&
          (endorse.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
        nomBlocks: body.querySelectorAll('.endorse--nom').length,
        text: body.textContent };
    });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    return out;
  };

  console.log('=== a round open, one gone by, signed in as the owner of r3 and r7 ===');
  truth = fresh([AUG, OCT]); nomMine = 'r7';
  let p = await open(1280);
  let t = await tags(p);
  check('r1 shortlisted beats everything', t.r1 && t.r1.text, t.r1.text === 'Shortlisted');
  check('r2 stood before and stands again', t.r2 && t.r2.text, t.r2.text === 'Nominated again');
  check('r4 carries its count', t.r4 && t.r4.text, t.r4.text === 'Nominated ×3');
  check('r5 stood in August only', t.r5 && t.r5.text, t.r5.text === 'Prev. nominated Aug ’26');
  check('r6 has no history and no tag', t.r6 && [t.r6.pills, t.r6.lines],
    t.r6.pills === 0 && t.r6.lines === 0);
  check('r7 is mine, and stood before', t.r7 && t.r7.text, t.r7.text === 'Nominated again');
  check('exactly one tag on every card',
    Object.keys(t).map(k => t[k].pills), Object.keys(t).every(k => t[k].pills <= 1));
  check('  and none of the old badges survive',
    Object.keys(t).map(k => t[k].legacy), Object.keys(t).every(k => t[k].legacy === 0));
  check('the pill shows, the line does not', [t.r2.pillShown, t.r2.lineShown],
    t.r2.pillShown === true && t.r2.lineShown === false);
  check('Prev. nominated is a colour of its own', [t.r5.bg, t.r2.bg, t.r1.bg],
    t.r5.bg !== t.r2.bg && t.r5.bg !== t.r1.bg);
  check('  and says so quietly, in sentence case', t.r5.cls, /reccard__tag--prev/.test(t.r5.cls));

  console.log('\n--- the modal ---');
  let m = await modal(p, 'r2');
  check('both months, in order', m.hist, m.hist === 'Nominated in Aug ’26 and Oct ’26.');
  check('  under the endorse block', m.histAfterEndorse, m.histAfterEndorse === true);
  check('  and no names anywhere near it', m.hist, !/\b(Saira|Pareesa)\b/.test(m.hist || ''));
  check('the nominate prompt is drawn once', m.nomBlocks, m.nomBlocks === 1);
  m = await modal(p, 'r5');
  check('a book with one round says one month', m.hist, m.hist === 'Nominated in Aug ’26.');
  m = await modal(p, 'r6');
  check('a book with none says nothing', m.hist, m.hist === null);

  console.log('\n--- the hover panel ---');
  const rev = await p.evaluate(() => {
    const card = document.querySelector('#recGrid .reccard');
    const rv = card.querySelector('.reccard__reveal');
    const R = n => { const r = n.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom) }; };
    return { restVisibility: getComputedStyle(rv).visibility,
      cardOverflow: getComputedStyle(card).overflow,
      revealZ: getComputedStyle(rv).zIndex,
      footZ: getComputedStyle(card.querySelector('.reccard__foot')).zIndex,
      card: R(card), reveal: R(rv) };
  });
  check('at rest it cannot paint', rev.restVisibility, rev.restVisibility === 'hidden');
  check('the card clips it', rev.cardOverflow, rev.cardOverflow === 'hidden');
  check('and it passes behind the foot, not over it', [rev.revealZ, rev.footZ],
    Number(rev.revealZ) < Number(rev.footZ));
  await p.hover('#recGrid .reccard');
  await p.waitForTimeout(400);
  const rev2 = await p.evaluate(() => {
    const card = document.querySelector('#recGrid .reccard');
    const rv = card.querySelector('.reccard__reveal');
    const c = card.getBoundingClientRect(), r = rv.getBoundingClientRect();
    return { visibility: getComputedStyle(rv).visibility,
      inside: r.bottom <= c.bottom + 1 && r.top >= c.top - 1,
      over: Math.round(r.bottom - c.bottom) };
  });
  check('hovered, it shows', rev2.visibility, rev2.visibility === 'visible');
  check('  and stays inside the card', [rev2.over], rev2.inside === true);
  await p.close();

  console.log('\n=== the same, at 390px ===');
  nomMine = 'r3';
  p = await open(390);
  t = await tags(p);
  check('the line shows, the pill does not', [t.r2.pillShown, t.r2.lineShown],
    t.r2.pillShown === false && t.r2.lineShown === true);
  check('r1 reads Shortlisted under the cover', t.r1.text, t.r1.text === 'Shortlisted');
  check('r3 is mine this time', t.r3.text, t.r3.text === 'Your nomination');
  check('r4 keeps its count', t.r4.text, t.r4.text === 'Nominated ×3');
  check('r5 is still the quiet one', [t.r5.text, t.r5.colour !== t.r2.colour],
    t.r5.text === 'Prev. nominated Aug ’26' && t.r5.colour !== t.r2.colour);
  check('r6 draws nothing at all', [t.r6.pills, t.r6.lines],
    t.r6.pills === 0 && t.r6.lines === 0);
  check('one line to a card',
    Object.keys(t).map(k => t[k].lines), Object.keys(t).every(k => t[k].lines <= 1));
  const below = await p.evaluate(() => {
    /* the line goes under the foot, inside the card's own width */
    const w = document.querySelector('[data-rec="r4"]').closest('.reccard-wrap');
    const card = w.querySelector('.reccard'), line = w.querySelector('.reccard__nomline');
    const c = card.getBoundingClientRect(), l = line.getBoundingClientRect();
    return { under: l.top >= c.bottom - 1, within: l.left >= c.left - 1 && l.right <= c.right + 1 };
  });
  check('under the foot and inside the card', below, below.under === true && below.within === true);
  await p.close();

  console.log('\n=== signed out, and with no round open ===');
  signedIn = false; nomMine = null;
  p = await open(1280);
  t = await tags(p);
  check('nobody is told whose nomination it is',
    Object.keys(t).map(k => t[k].text), Object.keys(t).every(k => t[k].text !== 'Your nomination'));
  check('  r7 is still Nominated again', t.r7.text, t.r7.text === 'Nominated again');
  await p.close();

  signedIn = true;
  truth = fresh([AUG]);                       /* August only: nothing is live */
  p = await open(1280);
  t = await tags(p);
  check('with no open round, August is history', [t.r2.text, t.r5.text, t.r7.text],
    t.r2.text === 'Prev. nominated Aug ’26' && t.r5.text === 'Prev. nominated Aug ’26' &&
    t.r7.text === 'Prev. nominated Aug ’26');
  check('  and the shortlisted one is unmoved', t.r1.text, t.r1.text === 'Shortlisted');
  check('  a book that never stood still has nothing', t.r6.pills, t.r6.pills === 0);
  await p.close();

  truth = fresh([]);                          /* no rounds at all, ever */
  p = await open(1280);
  t = await tags(p);
  check('no rounds: only the shortlist speaks',
    Object.keys(t).map(k => t[k].text),
    t.r1.text === 'Shortlisted' && ['r2','r3','r4','r5','r6','r7'].every(k => t[k].pills === 0));
  await p.close();

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
