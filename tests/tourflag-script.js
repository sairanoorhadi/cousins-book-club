/* The tour flag, against the real backend/Code.gs.
 *
 *   node tests/tourflag-script.js
 *
 * It is written through profile-set, like every other field an account
 * keeps, but it is the one an observer may write and the one that never
 * touches the public file.
 */
const gas = require('./lib/gas');

let bad = 0;
const check = (label, value, ok) => {
  if (typeof ok !== 'boolean') {
    bad++; console.log(' BUG  ' + String(label).padEnd(50),
      'verdict is not a boolean: ' + JSON.stringify(ok)); return;
  }
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : ' FAIL ') + String(label).padEnd(50), JSON.stringify(value));
};

const NOW = '2026-10-29T12:00:00.000Z';
const MEM = 'member@example.com', OBS = 'observer@example.com', ORG = 'organiser@example.com';

const state = () => ({
  rev: 4, club: { name: 'Cousins Book Club' },
  members: [{ id: 'mb-one', name: 'Pareesa', notifyRef: 'ref-mem', hue: 'grape',
              goodreads: 'https://g/1', genres: ['Fantasy'], top5: [] }],
  recs: [], books: [], meetings: [], votes: [],
});
function boot() {
  return gas.load({ state: state(), now: NOW, props: {
    'sess:mem-token': JSON.stringify({ email: MEM, expires: Date.parse(NOW) + 86400000 }),
    'sess:obs-token': JSON.stringify({ email: OBS, expires: Date.parse(NOW) + 86400000 }),
    'email:ref-mem': MEM,
    directory: JSON.stringify({
      [MEM]: { ref: 'ref-mem', name: 'Pareesa', books: [], memberId: 'mb-one' },
      [OBS]: { ref: 'ref-obs', name: 'Auntie', books: [], memberId: '' },
    }),
    observers: JSON.stringify({ [OBS]: { id: 'ob-1', name: 'Auntie', joined: NOW } }),
    ORGANISER_EMAIL: ORG,
  } });
}
const dir = (s) => JSON.parse(s.props.directory || '{}');
const puts = (s) => s.fetched.filter(f => f.method === 'put').length;

console.log('=== a member records the tour ===');
{
  const s = boot();
  const res = s.call('profile-set', { token: 'mem-token', tourDone: true });
  check('it is accepted', res, res.ok === true && res.tourDone === true);
  check('  and kept privately, beside their ref', dir(s)[MEM].tourDone, dir(s)[MEM].tourDone === true);
  check('  the public file is not touched at all', [puts(s), s.state().rev],
    puts(s) === 0 && s.state().rev === 4);
  check('  nor is the member row', s.state().members[0].hue, s.state().members[0].hue === 'grape');
  const got = s.call('session', { token: 'mem-token' });
  check('  and the session says so next time', got.profile && got.profile.tourDone,
    got.profile.tourDone === true);
}

console.log('\n=== an observer records it too ===');
{
  const s = boot();
  const res = s.call('profile-set', { token: 'obs-token', tourDone: true });
  check('not refused as members-only', res, res.ok === true);
  check('  kept against their address', dir(s)[OBS].tourDone, dir(s)[OBS].tourDone === true);
  check('  and read back at sign-in', s.call('session', { token: 'obs-token' }).profile.tourDone,
    s.call('session', { token: 'obs-token' }).profile.tourDone === true);
  check('  everything else is still members-only',
    s.call('profile-set', { token: 'obs-token', genres: ['Fantasy'] }).error,
    s.call('profile-set', { token: 'obs-token', genres: ['Fantasy'] }).error === 'members only');
}

console.log('\n=== the gate ===');
{
  const s = boot();
  check('signed out, no', s.call('profile-set', { tourDone: true }).error,
    s.call('profile-set', { tourDone: true }).error === 'signed out');
  const s2 = boot();
  check('before it is taken, the flag reads false',
    s2.call('session', { token: 'mem-token' }).profile.tourDone,
    s2.call('session', { token: 'mem-token' }).profile.tourDone === false);
  const s3 = boot();
  s3.call('profile-set', { token: 'mem-token', tourDone: false });
  check('and it can be put back', dir(s3)[MEM].tourDone, dir(s3)[MEM].tourDone === false);
}

console.log('\n=== a real profile save still behaves ===');
{
  const s = boot();
  const res = s.call('profile-set', { token: 'mem-token', hue: 'zest',
    genres: ['Fantasy', 'Mystery'], goodreads: 'https://www.goodreads.com/u/9' });
  check('it saves', res, res.ok === true && res.hue === 'zest');
  check('  through the public file, as before', puts(s), puts(s) === 1);
  check('  with the fields it was given',
    [s.state().members[0].hue, s.state().members[0].genres],
    s.state().members[0].hue === 'zest' &&
    JSON.stringify(s.state().members[0].genres) === JSON.stringify(['Fantasy', 'Mystery']));
  check('  and no tour flag anywhere near the public file',
    JSON.stringify(s.state()).indexOf('tourDone'),
    JSON.stringify(s.state()).indexOf('tourDone') === -1);
  /* The page never sends both, but the gate must not let a profile save
     slip through on the back of the flag. */
  const s2 = boot();
  const both = s2.call('profile-set', { token: 'obs-token', tourDone: true, genres: ['Fantasy'] });
  check('flag plus a field is still members-only', both.error, both.error === 'members only');
}

console.log(bad ? ('\n' + bad + ' FAILED') : '\nall good');
process.exit(bad ? 1 : 0);
