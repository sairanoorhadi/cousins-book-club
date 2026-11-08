/* Who is ready on the next-meeting card. The circles with initials in them
 * -- S, F, Z -- became name pills in each member's badge colour, moved into
 * the empty right side of the card body. The suite drives the real page over
 * the real state, with the ready list rewritten in the served JSON, because
 * the page's own functions are shut inside its closure.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/readypills.js [page.html]
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
  const out = path.join(os.tmpdir(), 'readypills-page.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

/* Which meeting the page puts on the card depends on today's date, so the
 * suite marks the same people ready on every meeting of the live book and
 * clears the rest: whichever one is drawn then carries the list under test. */
function liveMeetings(truth) {
  const live = truth.books.filter(b => b.status === 'current').map(b => b.id);
  const mine = truth.meetings.filter(m => live.indexOf(m.bookId) !== -1);
  return mine.length ? mine : truth.meetings;
}

(async () => {
  const PAGE = pageFile();
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const inbox = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'inbox.json'), 'utf8'));

  /* what the served state says this run; set per case before the page loads */
  let truth = JSON.parse(JSON.stringify(base));

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
  await new Promise(r => srv.listen(8419, r));
  const b = await chromium.launch();

  async function open(width, signedIn) {
    const p = await b.newPage({ viewport: { width, height: 1300 }, hasTouch: width <= 700 });
    const errs = [];
    p.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    const ME = truth.members[0];
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
    await p.goto('http://localhost:8419/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    p.errs = errs;
    return p;
  }

  /* ---- the names the suite puts on the card ----
     Real members where there are enough of them, each given a name long
     enough to make the column work, plus one deliberately long one. */
  const LONG = 'Bartholomewinnifred';
  function withReady(n, names) {
    truth = JSON.parse(JSON.stringify(base));
    const mem = truth.members;
    /* enough bodies to mark ready: clone the real ones if the club is small */
    while (mem.length < n) {
      const src = base.members[mem.length % base.members.length];
      mem.push(Object.assign({}, src, { id: src.id + '-x' + mem.length,
        name: src.name.split(/\s+/)[0] + mem.length }));
    }
    if (names) names.forEach((nm, i) => { if (mem[i]) mem[i].name = nm; });
    const who = mem.slice(0, n).map(x => x.id);
    truth.meetings.forEach(m => { m.ready = []; });
    liveMeetings(truth).forEach(m => { m.ready = who.slice(); });
    return { who: mem.slice(0, n) };
  }

  const px = v => Math.round(v * 10) / 10;

  /* ===== 1. desktop, a handful ready ===== */
  console.log('\n=== 1280px, 3 ready ===');
  let set = withReady(3, ['Saira Noor Hadi', 'Fatima Hadi', 'Dr Zainab Hadi']);
  let p = await open(1280);

  let col = await p.evaluate(() => {
    const c = document.querySelector('#heroMeetBody .readycol');
    if (!c) return null;
    const pills = [...c.querySelectorAll('.readypill')];
    const cs = getComputedStyle(c);
    return {
      label: (c.querySelector('.readycol__k') || {}).textContent || '',
      names: pills.map(n => n.textContent),
      colours: pills.map(n => getComputedStyle(n).backgroundColor),
      inks: pills.map(n => getComputedStyle(n).color),
      dir: cs.flexDirection,
      align: cs.alignItems,
      rects: pills.map(n => { const r = n.getBoundingClientRect();
        const t = v => Math.round(v * 10) / 10;
        return { x: t(r.left), y: t(r.top), w: t(r.width) }; }),
    };
  });
  check('the ready column is drawn', !!col, !!col);
  check('it is labelled Ready', col && col.label, !!col && /^Ready$/i.test(col.label.trim()));
  check('one pill per ready member, first names only',
    col && col.names,
    !!col && col.names.length === 3 &&
    col.names.join('|') === 'Saira|Fatima|Dr Zainab');
  check('each pill wears its own badge colour',
    col && col.colours,
    !!col && new Set(col.colours).size === col.colours.length &&
    col.colours.every(c => c && c !== 'rgba(0, 0, 0, 0)'));
  check('the text is a contrast colour, not the fill',
    col && col.inks,
    !!col && col.inks.every((ink, i) => ink && ink !== col.colours[i]));
  check('they stack one per line, right-aligned',
    col && { dir: col.dir, align: col.align, ys: col.rects.map(r => r.y) },
    !!col && col.rects.length === 3 && col.dir === 'column' && col.align === 'flex-end' &&
    col.rects[0].y < col.rects[1].y && col.rects[1].y < col.rects[2].y);
  const rights = col ? col.rects.map(r => Math.round(r.x + r.w)) : [];
  check('their right edges line up', rights,
    rights.length === 3 && new Set(rights).size === 1);

  /* beside the rows, not under them */
  let where = await p.evaluate(() => {
    const rows = document.querySelector('#heroMeetBody .meetcard__rows');
    const c = document.querySelector('#heroMeetBody .readycol');
    const card = document.querySelector('#heroMeetBody');
    if (!rows || !c) return null;
    const a = rows.getBoundingClientRect(), z = c.getBoundingClientRect(),
      k = card.getBoundingClientRect();
    return { rowsRight: a.right, colLeft: z.left, colTop: z.top, rowsTop: a.top,
      cardRight: k.right, cardLeft: k.left, cardW: k.width };
  });
  check('the column sits to the right of the rows',
    where && { rowsRight: px(where.rowsRight), colLeft: px(where.colLeft) },
    !!where && where.colLeft >= where.rowsRight - 1);
  check('level with them, not below',
    where && { colTop: px(where.colTop), rowsTop: px(where.rowsTop) },
    !!where && Math.abs(where.colTop - where.rowsTop) < 40);
  check('it stays inside the card',
    where && { colRight: px(where.colLeft), cardRight: px(where.cardRight) },
    !!where && where.colLeft >= where.cardLeft && where.colLeft < where.cardRight);

  /* the button did not move out of the Ready row */
  check('the Ready row is still in the left column',
    await p.evaluate(() => !!document.querySelector(
      '#heroMeetBody .meetcard__rows .meetcard__row--ready')),
    await p.evaluate(() => !!document.querySelector(
      '#heroMeetBody .meetcard__rows .meetcard__row--ready')));
  check('the phone copy of the pills is hidden here',
    await p.evaluate(() => {
      const n = document.querySelector('#heroMeetBody .readyrow__pills');
      return n ? getComputedStyle(n).display : 'missing'; }),
    await p.evaluate(() => {
      const n = document.querySelector('#heroMeetBody .readyrow__pills');
      return !!n && getComputedStyle(n).display === 'none'; }));
  check('no initial circles left anywhere',
    await p.evaluate(() => document.querySelectorAll('.readyface').length),
    await p.evaluate(() => document.querySelectorAll('.readyface').length === 0));
  check('no tooltip on the pills',
    await p.evaluate(() => [...document.querySelectorAll('.readypill')]
      .filter(n => n.hasAttribute('title')).length),
    await p.evaluate(() => [...document.querySelectorAll('.readypill')]
      .every(n => !n.hasAttribute('title'))));
  const cardW3 = where ? where.cardW : 0;
  check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
  await p.close();

  /* ===== 2. desktop, eight ready: down, never wider ===== */
  console.log('\n=== 1280px, 8 ready ===');
  set = withReady(8);
  p = await open(1280);
  const many = await p.evaluate(() => {
    const c = document.querySelector('#heroMeetBody .readycol');
    const card = document.querySelector('#heroMeetBody');
    const host = card.closest('.meetcard') || card.parentElement;
    const pills = [...c.querySelectorAll('.readypill')];
    const r = pills.map(n => n.getBoundingClientRect());
    const k = card.getBoundingClientRect(), z = c.getBoundingClientRect();
    return {
      n: pills.length,
      ys: r.map(x => Math.round(x.top)),
      lastBottom: Math.round(r[r.length - 1].bottom),
      cardW: Math.round(k.width), cardH: Math.round(k.height),
      cardBottom: Math.round(k.bottom),
      colW: Math.round(z.width), colRight: Math.round(z.right),
      cardRight: Math.round(k.right),
      hostScroll: host.scrollWidth - host.clientWidth,
      pageScroll: document.documentElement.scrollWidth - window.innerWidth,
      texts: pills.map(n => n.textContent),
    };
  });
  check('all eight are listed', many.n, many.n === 8);
  check('each on its own line, going down',
    { first: many.ys[0], last: many.ys[7] },
    many.ys.every((y, i) => i === 0 || y > many.ys[i - 1]));
  check('the card grew taller, not wider',
    { cardW: many.cardW, was: cardW3 ? Math.round(cardW3) : null },
    !cardW3 || many.cardW <= Math.round(cardW3) + 1);
  check('the column stays within the card',
    { colRight: many.colRight, cardRight: many.cardRight },
    many.colRight <= many.cardRight + 1);
  check('nothing overflows the card sideways', many.hostScroll, many.hostScroll <= 1);
  check('the list ends inside the card',
    { lastBottom: many.lastBottom, cardBottom: many.cardBottom },
    many.lastBottom <= many.cardBottom + 1);
  check('no sideways page scroll', many.pageScroll, many.pageScroll <= 1);
  check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
  await p.close();

  /* ===== 3. desktop, a name far too long: shrink, never clip ===== */
  console.log('\n=== 1280px, a very long name ===');
  set = withReady(2, [LONG + ' Fitzwilliam-Hadi', 'Fatima Hadi']);
  p = await open(1280);
  const fit = await p.evaluate(nm => {
    const pills = [...document.querySelectorAll('#heroMeetBody .readycol .readypill')];
    const first = pills[0];
    const cs = getComputedStyle(first);
    const r = first.getBoundingClientRect();
    const col = document.querySelector('#heroMeetBody .readycol').getBoundingClientRect();
    return {
      text: first.textContent,
      whole: first.textContent === nm,
      ellipsis: cs.textOverflow,
      size: parseFloat(cs.fontSize),
      other: parseFloat(getComputedStyle(pills[1]).fontSize),
      clipped: first.scrollWidth > first.clientWidth + 1,
      inCol: r.right <= col.right + 1 && r.left >= col.left - 1,
    };
  }, LONG);
  check('the whole name is on the pill', fit.text, fit.whole === true);
  check('its type shrank to fit', { long: fit.size, short: fit.other },
    fit.size < fit.other);
  check('and nothing is cut off',
    { scrollOverflow: fit.clipped, textOverflow: fit.ellipsis },
    fit.clipped === false && fit.ellipsis !== 'ellipsis');
  check('the pill is inside its column', fit.inCol, fit.inCol === true);
  check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
  await p.close();

  /* ===== 4. desktop, nobody ready ===== */
  console.log('\n=== 1280px, nobody ready ===');
  set = withReady(0);
  p = await open(1280);
  const none = await p.evaluate(() => {
    const c = document.querySelector('#heroMeetBody .readycol');
    if (!c) return null;
    const q = c.querySelector('.readycol__none');
    return { pills: c.querySelectorAll('.readypill').length,
      none: q ? q.textContent.trim() : null,
      shown: !!q && getComputedStyle(q).display !== 'none' };
  });
  check('the column is still there', !!none, !!none);
  check('with no pills on it', none && none.pills, !!none && none.pills === 0);
  check('and a quiet "No one yet"', none && none.none,
    !!none && /^No one yet$/i.test(String(none.none)) && none.shown === true);
  check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
  await p.close();

  /* ===== 5. phone: back in the Ready row, wrapping ===== */
  for (const w of [390, 360]) {
    console.log('\n=== ' + w + 'px, 8 ready ===');
    set = withReady(8);
    p = await open(w, true);
    const ph = await p.evaluate(() => {
      const row = document.querySelector('#heroMeetBody .meetcard__row--ready');
      const wrap = row ? row.querySelector('.readyrow__pills') : null;
      const col = document.querySelector('#heroMeetBody .readycol');
      const btn = row ? row.querySelector('[data-ready]') : null;
      const card = document.querySelector('#heroMeetBody');
      const pills = wrap ? [...wrap.querySelectorAll('.readypill')] : [];
      const r = pills.map(n => n.getBoundingClientRect());
      const k = card.getBoundingClientRect();
      const rw = wrap ? wrap.getBoundingClientRect() : null;
      return {
        n: pills.length,
        wrapShown: !!wrap && getComputedStyle(wrap).display !== 'none',
        colHidden: !!col && getComputedStyle(col).display === 'none',
        lines: new Set(r.map(x => Math.round(x.top))).size,
        widest: r.length ? Math.max(...r.map(x => Math.round(x.right))) : 0,
        cardRight: Math.round(k.right),
        underButton: btn && rw ? Math.round(rw.top) >= Math.round(
          btn.getBoundingClientRect().top) : null,
        cardScroll: card.scrollWidth - card.clientWidth,
        pageScroll: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    check('the pills are in the Ready row', { n: ph.n, shown: ph.wrapShown },
      ph.n === 8 && ph.wrapShown === true);
    check('the right-hand column is off here', ph.colHidden, ph.colHidden === true);
    check('they wrap onto several lines', ph.lines, ph.lines > 1 && ph.lines < 8);
    check('starting under the button, not beside it', ph.underButton,
      ph.underButton === true);
    check('nothing runs past the card',
      { widest: ph.widest, cardRight: ph.cardRight }, ph.widest <= ph.cardRight + 1);
    check('the card does not scroll sideways', ph.cardScroll, ph.cardScroll <= 1);
    check('nor the page', ph.pageScroll, ph.pageScroll <= 1);
    check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
    await p.close();
  }

  /* ===== 6. phone, nobody ready ===== */
  console.log('\n=== 390px, nobody ready ===');
  set = withReady(0);
  p = await open(390);
  const phNone = await p.evaluate(() => {
    const wrap = document.querySelector('#heroMeetBody .readyrow__pills');
    return { text: wrap ? wrap.textContent.trim() : null,
      pills: wrap ? wrap.querySelectorAll('.readypill').length : -1 };
  });
  check('the row says so too', phNone, phNone.pills === 0 && /no one yet/i.test(
    String(phNone.text)));
  check('no page errors', p.errs.slice(0, 3), p.errs.length === 0);
  await p.close();

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
