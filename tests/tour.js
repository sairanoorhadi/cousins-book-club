/* The guided tour and the quick start page.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/tour.js [page.html]
 *
 * Every tier's tour is walked end to end at desktop and at 360px, with the
 * script mocked: what is under test is that each step finds something to
 * point at (or says so in a card), that the tooltip stays on screen, that a
 * required tour cannot be dismissed by accident, and above all that walking
 * the whole thing writes nothing.
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
  const out = path.join(os.tmpdir(), 'tour-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

/* Everything a tour is allowed to ask the script for: reads, and the one
   write that records having taken it. Anything else is a tour that changed
   something. */
const ALLOWED = ['session', 'nom-mine', 'vote-mine', 'notify-get', 'profile-get', 'vote-mail'];

(async () => {
  const PAGE = pageFile();
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const ME = truth.members[0];

  let sent = [], who = null;            /* who: null | 'member' | 'observer' */
  let tourDone = false;
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
  await new Promise(r => srv.listen(8441, r));
  const b = await chromium.launch();

  const open = async (w) => {
    sent = [];
    const p = await b.newPage({ viewport: { width: w || 1280, height: 900 }, hasTouch: (w || 1280) <= 700 });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', async r => {
      const q = JSON.parse(r.request().postData() || '{}');
      sent.push(q);
      const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(o) });
      if (q.kind === 'session') {
        if (!who) return reply({ ok: false });
        return reply({ ok: true, profile: { memberId: who === 'member' ? ME.id : '',
          name: who === 'member' ? ME.name : 'Auntie', emailHint: 'a@x',
          type: who, observerId: who === 'observer' ? 'ob-1' : '', isMember: who === 'member',
          tourDone: tourDone } });
      }
      if (q.kind === 'nom-mine' || q.kind === 'vote-mine') return reply({ ok: true, mine: null });
      if (q.kind === 'profile-set') return reply({ ok: true, tourDone: !!q.payload.tourDone });
      if (q.kind === 'join') return reply({ ok: true });
      return reply({ ok: false });
    });
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    if (who) await p.addInitScript(() => { try {
      localStorage.setItem('marginNotes.session', 'tok'); } catch (e) {} });
    await p.goto('http://localhost:8441/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1700);
    return p;
  };

  const state = p => p.evaluate(() => {
    const t = document.getElementById('tour');
    if (t.hidden) return { up: false };
    const tip = document.getElementById('tourTip');
    const ring = document.getElementById('tourRing');
    const r = tip.getBoundingClientRect(), rr = ring.getBoundingClientRect();
    const card = t.classList.contains('tour--card');
    return {
      up: true, card,
      n: document.getElementById('tourN').textContent,
      title: document.getElementById('tourTitle').textContent,
      text: document.getElementById('tourText').textContent,
      tip: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) },
      ring: ring.style.display === 'none' ? null
        : { l: Math.round(rr.left), t: Math.round(rr.top), r: Math.round(rr.right), b: Math.round(rr.bottom) },
      inView: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 &&
              r.bottom <= window.innerHeight + 1,
      practice: !!document.querySelector('.tour__practice[data-at]'),
      focused: document.activeElement === tip ||
        tip.contains(document.activeElement),
      nextLabel: document.getElementById('tourNext').textContent,
      backOff: document.getElementById('tourBack').disabled,
    };
  });
  /* The whole tour, one step at a time, reporting what each one did. */
  const walk = async (p) => {
    const out = [];
    for (let guard = 0; guard < 60; guard++) {
      const s = await state(p);
      if (!s.up) break;
      out.push(s);
      if (s.nextLabel === 'Done') { await p.click('#tourNext'); await p.waitForTimeout(260); break; }
      await p.click('#tourNext');
      await p.waitForTimeout(260);
    }
    return out;
  };
  const startTour = async (p, tier) => {
    await p.evaluate(() => { const b = document.getElementById('tourBarGo'); if (b) b.click(); });
    await p.waitForTimeout(300);
    if (!await p.locator('[data-tourgo="visitor"]').isVisible()) {
      await p.click('#menuOpen'); await p.waitForTimeout(200);
      await p.click('#menuTour'); await p.waitForTimeout(300);
    }
    await p.click('[data-tourgo="' + tier + '"]');
    await p.waitForTimeout(400);
  };

  const tourTitles = [];
  for (const w of [1280, 360]) {
    console.log('\n=== signed out, ' + w + 'px ===');
    who = null; tourDone = false;
    let p = await open(w);
    check('the nudge is there', await p.evaluate(() =>
      !!document.querySelector('.tourbar')), await p.evaluate(() =>
      !!document.querySelector('.tourbar')));
    for (const tier of ['visitor', 'observer', 'member']) {
      await startTour(p, tier);
      const steps = await walk(p);
      const nums = steps.map(s => s.n);
      steps.forEach(s => { if (tourTitles.indexOf(s.title) === -1) tourTitles.push(s.title); });
      check(tier + ': every step drew', steps.length, steps.length > 10);
      check('  the counter runs 1..n', [nums[0], nums[nums.length - 1]],
        nums[0] === '1 of ' + steps.length && nums[nums.length - 1] === steps.length + ' of ' + steps.length);
      check('  the tooltip is always on screen', steps.filter(s => !s.inView).length,
        steps.every(s => s.inView));
      check('  it never covers what it points at',
        steps.filter(s => s.ring && !(s.tip.b <= s.ring.t + 1 || s.tip.t >= s.ring.b - 1)).length,
        steps.every(s => !s.ring || s.tip.b <= s.ring.t + 1 || s.tip.t >= s.ring.b - 1));
      check('  every step says something', steps.filter(s => !s.title || !s.text).length,
        steps.every(s => s.title && s.text));
      check('  focus is in the tooltip', steps.filter(s => !s.focused).length,
        steps.every(s => s.focused));
      check('  Back is off on the first step only', steps.map(s => s.backOff).indexOf(true),
        steps[0].backOff === true && steps.slice(1).every(s => !s.backOff));
      const wrote = sent.filter(q => ALLOWED.indexOf(q.kind) === -1 && q.kind !== 'profile-set');
      check('  and nothing was written', wrote.map(q => q.kind), wrote.length === 0);
      check('  the tour closed itself at the end', (await state(p)).up, (await state(p)).up === false);
    }
    await p.close();
  }

  console.log('\n=== practice copies, signed out ===');
  who = null;
  let p = await open(1280);
  await startTour(p, 'member');
  const seen = {};
  for (let i = 0; i < 40; i++) {
    const s = await state(p);
    if (!s.up) break;
    seen[s.title] = { card: s.card, practice: s.practice };
    if (s.nextLabel === 'Done') break;
    await p.click('#tourNext'); await p.waitForTimeout(240);
  }
  check('Suggest shows a dead copy', seen['Put a book forward'],
    !!seen['Put a book forward'] && seen['Put a book forward'].practice === true);
  check('  so does Look up book', seen['Look up book'],
    !!seen['Look up book'] && seen['Look up book'].practice === true);
  check('  and Search the web', seen['Search the web'],
    !!seen['Search the web'] && seen['Search the web'].practice === true);
  check('Predictions shows one', seen['Predictions'],
    !!seen['Predictions'] && seen['Predictions'].practice === true);
  check('  and discussion points', seen['Discussion points'],
    !!seen['Discussion points'] && seen['Discussion points'].practice === true);
  check('I’m ready shows one', seen['I’m ready'],
    !!seen['I’m ready'] && seen['I’m ready'].practice === true);
  check('voting is a card instead', seen['Voting'],
    !!seen['Voting'] && seen['Voting'].card === true);
  check('  and so is the profile', seen['Your profile'],
    !!seen['Your profile'] && seen['Your profile'].card === true);
  check('no practice copy is left behind', await p.evaluate(() =>
    document.querySelectorAll('.tour__practice[data-at]').length),
    await p.evaluate(() => {
      document.getElementById('tourSkip').click();
      return document.querySelectorAll('.tour__practice[data-at]').length === 0; }));
  await p.close();

  console.log('\n=== the chooser ===');
  who = 'member'; tourDone = true;
  p = await open(1280);
  await p.click('#menuOpen'); await p.waitForTimeout(200);
  await p.click('#menuTour'); await p.waitForTimeout(350);
  check('a member is preselected', await p.evaluate(() => {
    const n = document.querySelector('.tourpick__opt--you');
    return n ? n.getAttribute('data-tourgo') : null; }),
    await p.evaluate(() => {
      const n = document.querySelector('.tourpick__opt--you');
      return !!n && n.getAttribute('data-tourgo') === 'member'; }));
  check('  but all three are offered', await p.locator('[data-tourgo]').count(),
    await p.locator('[data-tourgo]').count() === 3);
  check('  and no nudge for someone signed in', await p.evaluate(() =>
    !document.querySelector('.tourbar')), await p.evaluate(() =>
    !document.querySelector('.tourbar')));
  await p.click('[data-tourgo="visitor"]'); await p.waitForTimeout(400);
  check('anyone may take any of them', (await state(p)).up, (await state(p)).up === true);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  check('  Escape gets out of an ordinary one', (await state(p)).up, (await state(p)).up === false);
  await p.close();

  console.log('\n=== required: a new member ===');
  who = null;
  p = await open(1280);
  await p.evaluate(() => {
    document.getElementById('signupOpen').click();
  });
  await p.waitForTimeout(400);
  await p.fill('#mfName', 'A New Cousin');
  await p.fill('#mfEmail', 'new@example.com');
  await p.click('[data-memsend="join"]');
  await p.waitForTimeout(700);
  check('the request is acknowledged first', await p.evaluate(() =>
    /Waiting on an organiser/.test(document.getElementById('memberModalBody').textContent)),
    await p.evaluate(() => /Waiting on an organiser/.test(
      document.getElementById('memberModalBody').textContent)));
  await p.click('[data-close="memberScrim"]');
  await p.waitForTimeout(500);
  let s = await state(p);
  check('  closing it starts the member tour', [s.up, s.title], s.up === true);
  await p.evaluate(() => document.getElementById('tourDimT').click());
  await p.waitForTimeout(250);
  check('  a click outside does not close it', (await state(p)).up, (await state(p)).up === true);
  p.on('dialog', d => d.dismiss());
  await p.click('#tourSkip'); await p.waitForTimeout(300);
  check('  Skip asks first, and no means no', (await state(p)).up, (await state(p)).up === true);
  p.removeAllListeners('dialog');
  let asked = '';
  p.on('dialog', d => { asked = d.message(); d.accept(); });
  await p.click('#tourSkip'); await p.waitForTimeout(400);
  check('  and yes closes it', (await state(p)).up, (await state(p)).up === false);
  check('  the question is the one agreed', asked,
    asked === 'Skip the tour? You can take it any time from the menu.');
  check('  signed out, done is remembered here only', await p.evaluate(() =>
    localStorage.getItem('marginNotes.tourDone')),
    await p.evaluate(() => localStorage.getItem('marginNotes.tourDone')) === '1' &&
    sent.filter(q => q.kind === 'profile-set').length === 0);
  await p.close();

  console.log('\n=== required: an observer signing in ===');
  who = 'observer'; tourDone = false;
  p = await open(1280);
  s = await state(p);
  check('it opens on its own', s.up, s.up === true);
  check('  and it is the observer tour', s.n, /of (2[0-9])$/.test(s.n));
  const steps = await walk(p);
  check('  finishing records it on the account',
    sent.filter(q => q.kind === 'profile-set').map(q => q.payload.tourDone),
    sent.filter(q => q.kind === 'profile-set').length === 1 &&
    sent.filter(q => q.kind === 'profile-set')[0].payload.tourDone === true);
  check('  and nothing else was written',
    sent.filter(q => ALLOWED.indexOf(q.kind) === -1 && q.kind !== 'profile-set').map(q => q.kind),
    sent.filter(q => ALLOWED.indexOf(q.kind) === -1 && q.kind !== 'profile-set').length === 0);
  check('  the flag carries only itself',
    Object.keys(sent.filter(q => q.kind === 'profile-set')[0].payload).sort(),
    JSON.stringify(Object.keys(sent.filter(q => q.kind === 'profile-set')[0].payload).sort()) ===
      JSON.stringify(['token', 'tourDone']));
  await p.close();

  who = 'observer'; tourDone = true;
  p = await open(1280);
  check('done on another device: it stays shut', (await state(p)).up, (await state(p)).up === false);
  await p.close();

  console.log('\n=== how it works ===');
  who = null; tourDone = false;
  p = await open(1280);
  await p.click('#menuOpen'); await p.waitForTimeout(200);
  await p.click('#menuHow'); await p.waitForTimeout(400);
  const how = await p.evaluate(() => {
    const body = document.getElementById('howBody');
    return { up: !document.getElementById('howScrim').hidden,
      sections: [...body.querySelectorAll('.howsec h3')].map(h => h.textContent),
      rows: body.querySelectorAll('.howlist li').length,
      titles: [...body.querySelectorAll('.howlist strong')].map(n => n.textContent),
      tourBtn: !!document.getElementById('howTour') };
  });
  check('it opens from the menu', how.up, how.up === true);
  check('  three sections', how.sections, JSON.stringify(how.sections) ===
    JSON.stringify(['Anyone', 'Observers', 'Members']));
  check('  with a Take the tour button', how.tourBtn, how.tourBtn === true);
  /* The page script is a closure, so the list is not reachable from here.
     What is checked instead is the thing that matters: every step title the
     three tours showed is on the page, and nothing is on the page twice. */
  check('  and every step the tours showed is in it', how.rows,
    tourTitles.every(t => how.titles.indexOf(t) !== -1));
  check('  each one once', [how.titles.length, how.rows],
    how.titles.length === how.rows &&
    how.titles.length === new Set(how.titles).size);
  await p.click('#howTour'); await p.waitForTimeout(350);
  check('  which opens the chooser', await p.locator('[data-tourgo]').count(),
    await p.locator('[data-tourgo]').count() === 3);
  await p.close();

  console.log('\n=== the nudge ===');
  who = null;
  p = await open(1280);
  await p.click('#tourBarX'); await p.waitForTimeout(250);
  check('dismissing it puts it away', await p.evaluate(() =>
    !document.querySelector('.tourbar')), await p.evaluate(() =>
    !document.querySelector('.tourbar')));
  check('  and remembers', await p.evaluate(() =>
    localStorage.getItem('marginNotes.tourBanner')),
    await p.evaluate(() => localStorage.getItem('marginNotes.tourBanner')) === 'off');
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1500);
  check('  across a reload', await p.evaluate(() => !document.querySelector('.tourbar')),
    await p.evaluate(() => !document.querySelector('.tourbar')));
  await p.close();

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
