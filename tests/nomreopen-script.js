/* Reopening a closed nominations round, against the real backend/Code.gs.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node tests/nomreopen-script.js
 *
 * These endpoints are blocked on the test site by design -- they write to the
 * repository and send email -- so this is the only place short of the live
 * site where the rules can be proved. The script runs in the sandbox in
 * tests/lib/gas.js with a clock the test moves.
 */
const gas = require('./lib/gas');

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {
    bad++; console.log(' BUG  ' + String(label).padEnd(54),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(54), JSON.stringify(value));
};

const NOW = '2026-10-26T12:00:00.000Z';
const ago = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();
const ahead = (hours) => new Date(Date.parse(NOW) + hours * 3600000).toISOString();

const ORG = 'organiser@example.com';
const MEM = 'member@example.com';

const round = (o) => Object.assign({
  id: 'nom-1', type: 'nomination', kind: 'nominate', candidates: [],
  opensAt: ago(9), closesAt: ago(1), cancelledAt: null, closedAt: ago(1),
  turnout: 2, nominated: [{ id: 'r1', n: 2, org: false }],
  totals: null, winner: null, tied: null, parent: null }, o || {});

const baseState = (rounds) => ({
  rev: 10,
  club: { name: 'Cousins Book Club' },
  members: [
    { id: 'mb-org', name: 'Saira', notifyRef: 'ref-org' },
    { id: 'mb-two', name: 'Pareesa', notifyRef: 'ref-two' },
    { id: 'mb-new', name: 'Waiting', notifyRef: 'ref-new', pending: true },
  ],
  recs: [
    { id: 'r1', title: 'The Book Thief', status: 'approved' },
    { id: 'r2', title: 'Piranesi', status: 'approved' },
  ],
  books: [], meetings: [], votes: rounds,
});

/* A script with sessions already minted, the way signing in would leave it. */
function boot(rounds, extraProps) {
  const props = Object.assign({
    /* Far enough ahead that moving the clock past a new closing time does
       not sign the tester out instead of refusing the nomination. */
    'sess:org-token': JSON.stringify({ email: ORG, expires: Date.parse(NOW) + 60 * 86400000 }),
    'sess:mem-token': JSON.stringify({ email: MEM, expires: Date.parse(NOW) + 60 * 86400000 }),
    'email:ref-org': ORG,
    'email:ref-two': MEM,
    'email:ref-new': 'pending@example.com',
  }, extraProps || {});
  return gas.load({ state: baseState(rounds), props, now: NOW });
}
const reopen = (s, payload) => s.call('nom-reopen',
  Object.assign({ token: 'org-token', roundId: 'nom-1' }, payload || {}));
const theRound = (s, id) => (s.state().votes || []).filter(v => v.id === (id || 'nom-1'))[0];

console.log('=== a round that closed yesterday, nothing else running ===');
{
  const s = boot([round()]);
  /* two nominations already in the private store */
  s.props['noms:nom-1'] = JSON.stringify({
    members: { 'mb-org': { recId: 'r1', at: ago(3) }, 'mb-two': { recId: 'r1', at: ago(2) } },
    organiser: [] });
  s.props['votemail:nom-1'] = JSON.stringify({ opened: ago(9), remind: ago(2), counted: ago(1) });

  const res = reopen(s, { closesAt: ahead(48), email: true });
  check('it reopens', res, res.ok === true);
  const r = theRound(s);
  check('  the closing stamp is gone', r.closedAt, r.closedAt === null);
  check('  and the new time is on the record', r.closesAt, r.closesAt === ahead(48));
  check('  which the script now reads as open',
    s.scope.voteStatus(r), s.scope.voteStatus(r) === 'open');
  check('  the reopen is logged, with both times',
    r.reopens, Array.isArray(r.reopens) && r.reopens.length === 1 &&
      r.reopens[0].from === ago(1) && r.reopens[0].to === ahead(48) &&
      r.reopens[0].closedAt === ago(1) && !!r.reopens[0].at);
  check('  every nomination is still there',
    Object.keys(JSON.parse(s.props['noms:nom-1']).members).sort(),
    JSON.stringify(Object.keys(JSON.parse(s.props['noms:nom-1']).members).sort()) ===
      JSON.stringify(['mb-org', 'mb-two']));
  check('  and so are the published counts', r.nominated, r.turnout === 2);
  check('  the file was written once, under the lock',
    [s.fetched.filter(f => f.method === 'put').length, s.locksHeld()],
    s.fetched.filter(f => f.method === 'put').length === 1 && s.locksHeld() === 0);

  console.log('--- the email ---');
  check('one email went out', s.mail.length, s.mail.length === 1);
  const m = s.mail[0] || {};
  /* One address goes in To -- the organiser's when she is among them -- and
     the rest are bcc, so the recipients are both fields together. */
  const to = String(m.to || '') + ',' + String(m.bcc || '');
  check('  to both members, not the pending one', to,
    to.indexOf(ORG) !== -1 && to.indexOf(MEM) !== -1 && to.indexOf('pending@') === -1);
  check('  it says they are open again', m.subject, /open again/i.test(m.subject || ''));
  check('  with the new closing time in it', (m.body || '').slice(0, 200),
    (m.body || '').indexOf(ahead(48)) !== -1);
  check('  and says nothing was lost', (m.body || '').indexOf('still there') !== -1,
    /still there/i.test(m.body || ''));
  check('  the reply says how many it reached', [res.emailed, res.sent],
    res.emailed === true && res.sent === 2);

  console.log('--- the nudge ---');
  const flags = JSON.parse(s.props['votemail:nom-1']);
  check('the 6-hour nudge is armed again', [flags.remind, flags.remindSkipped],
    !flags.remind && flags.remindSkipped === false);
  check('  and the opening email is not sent twice', flags.opened, !!flags.opened);

  console.log('--- nominating again ---');
  const cast = s.call('nom-cast', { token: 'mem-token', roundId: 'nom-1', recId: 'r2' });
  check('a member can nominate once more', cast, cast.ok === true && cast.mine === 'r2');
  s.setNow(Date.parse(ahead(49)));
  const late = s.call('nom-cast', { token: 'mem-token', roundId: 'nom-1', recId: 'r1' });
  check('after the new close it is refused', late,
    late.ok === false && late.error === 'nominations have closed');
}

console.log('\n=== a short window ===');
{
  const s = boot([round()]);
  const tooSoon = reopen(s, { closesAt: ahead(0.5) });
  check('under an hour is refused', tooSoon.error,
    tooSoon.error === 'give it at least an hour from now');
  check('  and nothing was written', theRound(s).closedAt, theRound(s).closedAt === ago(1));
  const notATime = reopen(s, { closesAt: 'soon' });
  check('  a time that is not one is refused', notATime.error,
    /closing time/.test(notATime.error || ''));
  const t = boot([round({ test: true })]);
  const fifteen = t.call('nom-reopen', { token: 'org-token', roundId: 'nom-1',
    closesAt: new Date(Date.parse(NOW) + 15 * 60000).toISOString() });
  check('a test round may have fifteen minutes', fifteen.ok, fifteen.ok === true);
  const t2 = boot([round({ test: true })]);
  const five = t2.call('nom-reopen', { token: 'org-token', roundId: 'nom-1',
    closesAt: new Date(Date.parse(NOW) + 5 * 60000).toISOString() });
  check('  but not five', five.error, /at least 10 minutes/.test(five.error || ''));
}

console.log('\n=== the window it may be reopened in ===');
{
  const old = boot([round({ closesAt: ago(8), closedAt: ago(8) })]);
  const res = old.call('nom-reopen', { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('eight days ago is too long ago', res.error, /more than 7 days/.test(res.error || ''));
  const six = boot([round({ closesAt: ago(6), closedAt: ago(6) })]);
  const sixRes = six.call('nom-reopen', { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('six days ago is not', sixRes.ok, sixRes.ok === true);
  /* The timer may not have stamped it; the closing time still says when. */
  const unstamped = boot([round({ closesAt: ago(2), closedAt: null })]);
  const unRes = unstamped.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('a round the timer has not settled still counts as closed', unRes.ok, unRes.ok === true);
}

console.log('\n=== when it may not be reopened at all ===');
{
  const vote = { id: 'vote-1', kind: 'rate', candidates: [{ id: 'r1', title: 'The Book Thief' }],
    opensAt: ago(0.5), closesAt: ahead(24), cancelledAt: null, closedAt: null, turnout: 0 };
  const after = boot([round(), vote]);
  const afterRes = after.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('a vote launched from it blocks the reopen', afterRes.error,
    /vote has already been launched/.test(afterRes.error || ''));

  const cancelledVote = boot([round(), Object.assign({}, vote, { cancelledAt: ago(0.2) })]);
  const cvRes = cancelledVote.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('  a cancelled one does not', cvRes.ok, cvRes.ok === true);

  const other = boot([round(), { id: 'nom-2', type: 'nomination', kind: 'nominate',
    opensAt: ahead(24), closesAt: ahead(72), cancelledAt: null, closedAt: null,
    nominated: [], turnout: 0 }]);
  const otherRes = other.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('another round scheduled blocks it', otherRes.error,
    /open or scheduled/.test(otherRes.error || ''));

  const live = boot([round({ id: 'nom-1', closesAt: ahead(24), closedAt: null })]);
  const liveRes = live.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('a round that is still open cannot be reopened', liveRes.error,
    liveRes.error === 'that round has not closed');

  const killed = boot([round({ cancelledAt: ago(2) })]);
  const killedRes = killed.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('a cancelled round cannot either', killedRes.error, /cancelled/.test(killedRes.error || ''));

  const s = boot([round()]);
  const nope = s.call('nom-reopen', { token: 'org-token', roundId: 'nope', closesAt: ahead(48) });
  check('an id that names no round is refused', nope.error, nope.error === 'no such round');
}

console.log('\n=== who may do it ===');
{
  const s = boot([round()]);
  const asMember = s.call('nom-reopen',
    { token: 'mem-token', roundId: 'nom-1', closesAt: ahead(48) });
  check('a member may not', asMember.error, asMember.error === 'organiser only');
  const asNobody = s.call('nom-reopen', { roundId: 'nom-1', closesAt: ahead(48) });
  check('  nor anybody signed out', asNobody.error, asNobody.error === 'signed out');
  check('  and nothing was written', theRound(s).closedAt, theRound(s).closedAt === ago(1));
}

console.log('\n=== the email is a choice ===');
{
  const quiet = boot([round()]);
  const res = quiet.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48), email: false });
  check('unticked, nobody is emailed', [res.ok, quiet.mail.length, res.emailed],
    res.ok === true && quiet.mail.length === 0 && res.emailed === false);
  check('  and it is still reopened', theRound(quiet).closedAt, theRound(quiet).closedAt === null);

  const me = boot([round()]);
  me.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(48), email: true, test: true });
  const only = me.mail[0] || {};
  check('test: only the organiser', [only.to, only.bcc],
    me.mail.length === 1 && only.to === ORG && !only.bcc);

  const short = boot([round()]);
  short.call('nom-reopen',
    { token: 'org-token', roundId: 'nom-1', closesAt: ahead(3), email: false });
  check('a window under six hours gets no nudge',
    JSON.parse(short.props['votemail:nom-1']).remindSkipped,
    JSON.parse(short.props['votemail:nom-1']).remindSkipped === true);
}

console.log('\n=== who has not nominated, after it closed ===');
{
  const s = boot([round()]);
  s.props['noms:nom-1'] = JSON.stringify({ members: { 'mb-org': { recId: 'r1', at: ago(3) } },
    organiser: [] });
  const who = s.call('nom-who', { token: 'org-token', roundId: 'nom-1' });
  check('the organiser can still ask', who.ok, who.ok === true);
  check('  and gets member ids, never names', who.nominated,
    JSON.stringify(who.nominated) === JSON.stringify(['mb-org']));
  const whoMember = s.call('nom-who', { token: 'mem-token', roundId: 'nom-1' });
  check('  a member cannot', whoMember.error, whoMember.error === 'organiser only');
}

console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
process.exit(bad ? 1 : 0);
