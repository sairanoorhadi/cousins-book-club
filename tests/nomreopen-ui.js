/* The Reopen / extend control in Admin, and the banner it brings back.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/nomreopen-ui.js [page.html]
 *
 * The script is mocked here: what the endpoint itself does is proved against
 * the real Code.gs in tests/nomreopen-script.js. What is under test is when
 * the control is offered, what the confirm step asks, and what is sent.
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
  const out = path.join(os.tmpdir(), 'nomreopen-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}

const NOW = '2026-10-26T12:00:00.000Z';
const ago = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const ahead = (h) => new Date(Date.parse(NOW) + h * 3600000).toISOString();

(async () => {
  const PAGE = pageFile();
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const ME = base.members[0];

  const rec = (id, title, o) => Object.assign({ id, title, author: 'A Writer',
    status: 'approved', by: 'Someone', pages: 300, genres: [], tropes: [], ageMin: 10,
    ageMax: 18, blurb: 'x', cover: '', ratings: [], endorsements: [], dislikes: [],
    shortlist: false }, o || {});
  const round = (o) => Object.assign({ id: 'nom-1', type: 'nomination', kind: 'nominate',
    candidates: [], opensAt: ago(9), closesAt: ago(1), cancelledAt: null, closedAt: ago(1),
    turnout: 1, nominated: [{ id: 'r1', n: 1, org: false }],
    totals: null, winner: null, tied: null, parent: null }, o || {});
  const fresh = (rounds, recs) => {
    const st = JSON.parse(JSON.stringify(base));
    st.members = [ { id: ME.id, name: ME.name, joined: '', avatar: '', top5: [] },
                   { id: 'mb-two', name: 'Pareesa', joined: '', avatar: '', top5: [] } ];
    st.books = []; st.meetings = [];
    st.recs = recs || [rec('r1', 'The Book Thief'), rec('r2', 'Piranesi')];
    st.votes = rounds;
    return st;
  };

  let truth, sent = [], reopenReply = null;
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
  await new Promise(r => srv.listen(8417, r));
  const b = await chromium.launch();

  const open = async () => {
    sent = [];
    const p = await b.newPage({ viewport: { width: 1280, height: 1300 } });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    p.on('dialog', d => d.accept());
    await p.clock.install({ time: new Date(NOW) });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', async r => {
      const q = JSON.parse(r.request().postData() || '{}');
      sent.push(q);
      const reply = o => r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(o) });
      if (q.kind === 'session') return reply({ ok: true,
        profile: { memberId: ME.id, name: ME.name, emailHint: 's@x' } });
      if (q.kind === 'nom-mine' || q.kind === 'vote-mine') return reply({ ok: true, mine: null });
      if (q.kind === 'nom-who') return reply({ ok: true, byRec: { r1: [ME.id] },
        nominated: [ME.id], organiser: [] });
      if (q.kind === 'nom-reopen') return reply(reopenReply ||
        { ok: true, closesAt: q.payload.closesAt, reopens: [{ at: NOW, from: ago(1),
          to: q.payload.closesAt, closedAt: ago(1) }], emailed: !!q.payload.email,
          sent: q.payload.email ? 2 : 0, missing: [] });
      if (q.kind === 'vote-mail') return reply({ ok: true, installed: true, everyMinutes: 5,
        remindHours: 6, quota: 400, reserve: 20, flags: {} });
      return reply({ ok: false });
    });
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    await p.addInitScript(() => { try {
      localStorage.setItem('marginNotes.session', 'tok');
      localStorage.setItem('marginNotes.ghToken', 't'); } catch (e) {} });
    await p.goto('http://localhost:8417/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1700);
    /* into Admin, unlocked */
    await p.click('#menuOpen'); await p.waitForTimeout(250);
    await p.click('#menuAdmin'); await p.waitForTimeout(600);
    if (await p.locator('#admPass').count()) {
      await p.fill('#admPass', '2608'); await p.click('#admUnlock'); await p.waitForTimeout(600);
    }
    /* the Vote tab, then Previous rounds, then the round itself: a closed
       round's panel lives in the history, which is where its shortlist
       buttons are too */
    await p.evaluate(() => {
      const t = [...document.querySelectorAll('[data-atab]')]
        .filter(x => x.getAttribute('data-atab') === 'vote')[0];
      if (t) t.click();
    });
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const n = document.querySelector('[data-prevsection]');
      if (n && !n.parentNode.open) n.click();
    });
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const n = document.querySelector('[data-roundrow="nom-1"]');
      if (n && !n.parentNode.open) n.click();
    });
    await p.waitForTimeout(600);
    return p;
  };
  const panel = p => p.evaluate(() => {
    const pane = document.getElementById('adminPane');
    const btn = pane.querySelector('[data-nomreopen]');
    const dis = [...pane.querySelectorAll('button')]
      .filter(x => /Reopen \/ extend/.test(x.textContent) && x.disabled);
    return {
      text: pane.textContent,
      button: !!btn,
      disabled: dis.length > 0,
      confirmOpen: !!pane.querySelector('#nomReopenGo'),
      whoButton: !!pane.querySelector('[data-nomwhogo]'),
    };
  });

  console.log('=== closed yesterday, nothing in the way ===');
  truth = fresh([round()]);
  let p = await open();
  let v = await panel(p);
  check('the control is offered', v.button, v.button === true);
  check('  and it is not disabled', v.disabled, v.disabled === false);
  check('  the turnout is beside it', /1 of 2 nominated/.test(v.text), /1 of 2 nominated/.test(v.text));
  check('  with a way to see who is missing', v.whoButton, v.whoButton === true);
  check('  and nothing is confirmed yet', v.confirmOpen, v.confirmOpen === false);

  console.log('--- who has not nominated ---');
  await p.click('[data-nomwhogo]'); await p.waitForTimeout(500);
  const asked = sent.filter(x => x.kind === 'nom-who');
  check('it asks the script', asked.length && asked[0].payload.roundId,
    asked.length === 1 && asked[0].payload.roundId === 'nom-1');
  check('  and names the one who did not', await p.evaluate(() =>
    document.getElementById('adminPane').textContent.indexOf('Pareesa') !== -1),
    await p.evaluate(() => {
      const t = document.getElementById('adminPane').textContent;
      return t.indexOf('Pareesa') !== -1; }));

  console.log('--- the confirm step ---');
  await p.click('[data-nomreopen]'); await p.waitForTimeout(400);
  const form = await p.evaluate(() => {
    const pane = document.getElementById('adminPane');
    return {
      at: !!pane.querySelector('#nomReopenAt'),
      lasts: pane.querySelectorAll('[data-nomreopenlasts]').length,
      mail: (pane.querySelector('#nomReopenMail') || {}).checked,
      test: !!pane.querySelector('#nomReopenTest'),
      go: !!pane.querySelector('#nomReopenGo'),
      cancel: !!pane.querySelector('#nomReopenCancel'),
      warns: /already on the shortlist/.test(pane.textContent),
    };
  });
  check('it asks before it applies', [form.go, form.cancel], form.go && form.cancel);
  check('  with a time and the four shortcuts', [form.at, form.lasts],
    form.at === true && form.lasts === 4);
  check('  the email is ticked by default', form.mail, form.mail === true);
  check('  and the test option is there', form.test, form.test === true);
  check('  no shortlist warning when none is on it', form.warns, form.warns === false);

  const shortcut = await p.evaluate(() => {
    const was = document.getElementById('nomReopenAt').value;
    [...document.querySelectorAll('[data-nomreopenlasts]')]
      .filter(b => b.getAttribute('data-nomreopenlasts') === '168')[0].click();
    return { was, now: document.getElementById('nomReopenAt').value };
  });
  await p.waitForTimeout(200);
  check('a shortcut fills the time in', shortcut.now !== shortcut.was, shortcut.now !== shortcut.was);

  console.log('--- too soon ---');
  await p.evaluate(() => {
    const d = new Date(Date.now() + 10 * 60000);
    const pad = n => (n < 10 ? '0' : '') + n;
    document.getElementById('nomReopenAt').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) +
      '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  });
  await p.click('#nomReopenGo'); await p.waitForTimeout(400);
  check('ten minutes is refused before it is sent',
    sent.filter(x => x.kind === 'nom-reopen').length,
    sent.filter(x => x.kind === 'nom-reopen').length === 0);

  console.log('--- reopening ---');
  await p.evaluate(() => {
    const d = new Date(Date.now() + 48 * 3600000);
    const pad = n => (n < 10 ? '0' : '') + n;
    document.getElementById('nomReopenAt').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) +
      '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  });
  await p.click('#nomReopenGo'); await p.waitForTimeout(800);
  const call = sent.filter(x => x.kind === 'nom-reopen')[0];
  check('it sends the round, the time and the email choice',
    call && [call.payload.roundId, !!call.payload.closesAt, call.payload.email, call.payload.test],
    !!call && call.payload.roundId === 'nom-1' && !!call.payload.closesAt &&
      call.payload.email === true && call.payload.test === false);
  const after = await p.evaluate(() => {
    const cta = document.getElementById('voteCta');
    return { open: /Nominations are open/.test(cta.textContent),
      extended: !!cta.querySelector('.votecta__ext'),
      countdown: /left/.test(cta.textContent),
      stillAsking: !!document.querySelector('#nomReopenGo') };
  });
  check('the banner is back, open', after.open, after.open === true);
  check('  with the Extended note', after.extended, after.extended === true);
  check('  and a countdown to the new time', after.countdown, after.countdown === true);
  check('  the confirm step is done with', after.stillAsking, after.stillAsking === false);
  await p.close();

  console.log('\n=== when it is not offered ===');
  truth = fresh([round({ closesAt: ago(8), closedAt: ago(8) })]);
  p = await open(); v = await panel(p);
  check('closed over a week ago: no control', v.button, v.button === false);
  check('  but the list of who is missing stays', v.whoButton, v.whoButton === true);
  await p.close();

  truth = fresh([round(), { id: 'vote-1', kind: 'rate',
    candidates: [{ id: 'r1', title: 'The Book Thief' }], opensAt: ago(0.5),
    closesAt: ahead(24), cancelledAt: null, closedAt: null, turnout: 0 }]);
  p = await open(); v = await panel(p);
  check('a vote launched from it: no control', v.button, v.button === false);
  await p.close();

  truth = fresh([round(), { id: 'nom-2', type: 'nomination', kind: 'nominate',
    candidates: [], opensAt: ahead(24), closesAt: ahead(72), cancelledAt: null,
    closedAt: null, nominated: [], turnout: 0 }]);
  p = await open(); v = await panel(p);
  check('another round scheduled: disabled, with the reason',
    [v.button, v.disabled, /Only one round runs at a time/.test(v.text)],
    v.button === false && v.disabled === true &&
      /Only one round runs at a time/.test(v.text));
  await p.close();

  console.log('\n=== already shortlisted ===');
  truth = fresh([round()], [rec('r1', 'The Book Thief', { shortlist: true }), rec('r2', 'Piranesi')]);
  p = await open();
  await p.click('[data-nomreopen]'); await p.waitForTimeout(400);
  const warned = await p.evaluate(() => {
    const t = document.getElementById('adminPane').textContent;
    return { warns: /already on the shortlist/.test(t),
      says: /wants doing again/.test(t),
      go: !!document.querySelector('#nomReopenGo') };
  });
  check('it still allows it', warned.go, warned.go === true);
  check('  and warns the shortlist needs redoing', [warned.warns, warned.says],
    warned.warns === true && warned.says === true);
  await p.close();

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
