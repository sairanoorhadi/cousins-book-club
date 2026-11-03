/* The member profile header, at both shapes.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/memhead.js [page.html]
 *
 * Desktop is two rows beside the avatar -- name and duration tag, then the
 * genres -- and nothing on it is ever shortened. The phone is the other
 * arrangement entirely (name and links, then tag and genres), and it is
 * here so that a change to one is not allowed to move the other.
 */
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const MARKER = '<script>window.__DEV_SITE = true;</script>\n';

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {
    bad++; console.log(' BUG  ' + String(label).padEnd(54),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(54), JSON.stringify(value));
};
function pageFile() {
  if (process.argv[2]) return process.argv[2];
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'index.html'), 'utf8');
  const out = path.join(os.tmpdir(), 'memhead-live.html');
  fs.writeFileSync(out, dev.replace(MARKER, ''));
  return out;
}
const LONG = 'Annabelle-Katherine Fitzwilliam';

(async () => {
  const PAGE = pageFile();
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  const st = JSON.parse(JSON.stringify(base));
  st.members = [
    { id: 'mb-all', name: 'Saira', joined: '2026-04-17', avatar: '', top5: [],
      goodreads: 'https://www.goodreads.com/u/1', fable: 'https://fable.co/u/1',
      genres: ['Fantasy', 'Science Fiction', 'Realistic Fiction'] },
    { id: 'mb-none', name: 'Filza', joined: '2026-04-17', avatar: '', top5: [],
      goodreads: '', fable: '', genres: [] },
    { id: 'mb-long', name: LONG, joined: '2026-04-17', avatar: '', top5: [],
      goodreads: 'https://www.goodreads.com/u/3', fable: 'https://fable.co/u/3',
      /* Long enough that they cannot share one line in a half-page card,
         which is the three-line case. */
      genres: ['Historical Literary Fiction', 'Contemporary Science Fiction',
               'Realistic Fiction'] },
  ];
  st.books = []; st.meetings = []; st.recs = []; st.votes = [];

  const srv = http.createServer((q, r) => {
    let u = q.url.split('?')[0]; if (u === '/') u = '/index.html';
    if (/state\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(st)); }
    if (/inbox\.json$/.test(u)) { r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end('{"items":[]}'); }
    const f = /index\.html$/.test(u) ? PAGE : path.join(ROOT, u);
    if (!fs.existsSync(f)) { r.writeHead(404); return r.end('x'); }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(fs.readFileSync(f));
  });
  await new Promise(r => srv.listen(8451, r));
  const b = await chromium.launch();

  const heads = async (w) => {
    const p = await b.newPage({ viewport: { width: w, height: 1200 }, hasTouch: w <= 700 });
    p.on('pageerror', e => { bad++; console.log(' FAIL PAGEERROR ' + e.message); });
    await p.route('https://openlibrary.org/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"docs":[]}' }));
    await p.route('https://script.google.com/**', r => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"ok":false}' }));
    await p.route('https://api.github.com/**', r => r.fulfill({ status: 404, body: '{}' }));
    await p.goto('http://localhost:8451/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1700);
    const out = await p.evaluate(() => {
      const R = n => { if (!n) return null; const r = n.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width),
          h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom),
          mid: Math.round((r.top + r.bottom) / 2) }; };
      const cut = n => !!n && n.scrollWidth > n.clientWidth + 1;
      return [...document.querySelectorAll('.memhead')].map(h => {
        const name = h.querySelector('h3'), pic = h.querySelector('.memhead__pic'),
          tag = h.querySelector('.memtag'), links = h.querySelector('.memlinks'),
          marks = [...h.querySelectorAll('.memmark')],
          pills = [...h.querySelectorAll('.memgen__c')],
          lab = h.querySelector('.memgen__lab');
        const cs = getComputedStyle(h);
        /* The card's visual gutter. The desktop header holds extra padding
           on the right as the lifted-out links' room, so the content box is
           not where the edge is. */
        const pad = 13;
        return {
          name: name.textContent, head: R(h), h3: R(name), pic: R(pic),
          tag: R(tag), links: R(links), marks: marks.map(R),
          nameCut: cut(name), lines: Math.round(R(name).h /
            parseFloat(getComputedStyle(name).lineHeight)),
          pills: pills.map(x => ({ ...R(x), text: x.textContent, cut: cut(x) })),
          labShown: !!lab && getComputedStyle(lab).display !== 'none',
          inner: Math.round(h.getBoundingClientRect().right - pad),
          rightmost: Math.round(Math.max(...[...h.querySelectorAll('*')]
            .map(e => e.getBoundingClientRect().right))),
          display: cs.display,
        };
      });
    });
    await p.close();
    return out;
  };

  for (const w of [1280, 1000]) {
    console.log('\n=== desktop, ' + w + 'px ===');
    const [all, none, long] = await heads(w);
    check('the name and the genres are on different lines',
      [all.h3.b, all.pills[0].t], all.pills[0].t >= all.h3.b - 1);
    for (const m of [all, none, long]) {
      const who = m.name === LONG ? 'the long name' : m.name;
      check(who + ': the name is whole', [m.h3.w, m.nameCut], m.nameCut === false);
      check('  the tag is beside it, not under it', [m.tag.l, m.h3.r],
        m.tag.l >= m.h3.r && m.tag.t < m.h3.b && m.tag.b > m.h3.t);
      check('  the genres are on the line below', [m.pills[0].t, m.h3.b],
        m.pills.every(x => x.t >= m.h3.b - 1));
      check('  none of them is cut', m.pills.map(x => [x.text, x.cut]),
        m.pills.every(x => x.cut === false));
      /* the whole text block, centred on the avatar */
      const top = Math.min(m.h3.t, m.tag.t), bot = Math.max(...m.pills.map(x => x.b));
      check('  the block is centred against the avatar',
        [Math.round((top + bot) / 2), m.pic.mid], Math.abs((top + bot) / 2 - m.pic.mid) <= 2);
      check('  the links are stacked, out at the right',
        [m.marks.map(x => x.t), m.links.r, m.inner],
        m.marks.length === 2 && m.marks[0].t < m.marks[1].t &&
        m.links.r >= m.inner - 4 && m.links.r <= m.inner + 1);
      check('  and centred against it too', [m.links.mid, m.pic.mid],
        Math.abs(m.links.mid - m.pic.mid) <= 2);
      check('  nothing reaches past the card', [m.rightmost, m.inner],
        m.rightmost <= m.inner + 1);
    }
    check('no genres: the placeholder is on line two', none.pills.map(x => x.text),
      none.pills.length === 1 && /not set/i.test(none.pills[0].text) &&
      none.pills[0].t >= none.h3.b - 1);
    check('three long genres wrap rather than shrink',
      long.pills.map(x => x.t).filter((v, i, a) => a.indexOf(v) === i).length,
      long.pills.every(x => x.cut === false));
    const rows = long.pills.map(x => x.t).filter((v, i, a) => a.indexOf(v) === i).length;
    check('  on ' + (w === 1000 ? 'a narrow desktop they take two rows' : 'a wide one they may take one'),
      rows, rows >= 1);
  }

  console.log('\n=== the long header at 1000px, in detail ===');
  {
    const [, , long] = await heads(1000);
    const rows = long.pills.map(x => x.t).filter((v, i, a) => a.indexOf(v) === i).length;
    const lines = 1 + rows;
    check('name and tag, then the genres over two rows', lines, lines === 3);
    check('  and every genre still reads in full', long.pills.map(x => x.text),
      long.pills.every(x => x.cut === false));
    const top = Math.min(long.h3.t, long.tag.t), bot = Math.max(...long.pills.map(x => x.b));
    check('  three lines, still centred on the avatar',
      [Math.round((top + bot) / 2), long.pic.mid],
      Math.abs((top + bot) / 2 - long.pic.mid) <= 2);
  }

  for (const w of [390, 360]) {
    console.log('\n=== the phone is untouched, ' + w + 'px ===');
    const [all, none, long] = await heads(w);
    check('it is the flex layout, not the grid', all.display, all.display === 'flex');
    for (const m of [all, none, long]) {
      const who = m.name === LONG ? 'the long name' : m.name;
      check(who + ': the name is whole', [m.h3.w, m.nameCut], m.nameCut === false);
      check('  level with the top of the avatar', [m.h3.t, m.pic.t],
        Math.abs(m.h3.t - m.pic.t) <= 2);
      check('  the links are beside it, on its row', [m.h3.r, m.marks[0].l],
        m.marks[0].l >= m.h3.r && m.marks[0].l <= m.h3.r + 14 &&
        Math.abs(m.marks[0].t - m.h3.t) <= 4);
      check('  the tag is below the name', [m.tag.t, m.h3.b], m.tag.t >= m.h3.b);
      check('  nothing reaches past the card', [m.rightmost, m.inner],
        m.rightmost <= m.inner + 1);
    }
    check('the genres read in full', all.pills.map(x => [x.text, x.cut]),
      all.pills.length === 3 && all.pills.every(x => x.cut === false));
    check('  and follow the tag', [all.tag.t, all.pills[0].t],
      all.pills[0].t >= all.tag.t);
    check('no genres: still Not set yet', none.pills.map(x => x.text),
      none.pills.length === 1 && /not set/i.test(none.pills[0].text));
  }

  await b.close(); srv.close();
  console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
  process.exit(bad ? 1 : 0);
})();
