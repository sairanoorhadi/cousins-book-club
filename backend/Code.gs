/**
 * Cousins Book Club — submissions inbox and meeting reminders.
 *
 * This is a Google Apps Script web app. It does the two things a static site on
 * GitHub Pages can't do for itself:
 *
 *   1. Accepts submissions from anyone, with no GitHub account, and writes them
 *      to data/inbox.json in the repo (the site reads that file directly).
 *   2. Runs on a timer and emails meeting reminders — when a meeting is
 *      scheduled, five days before, and thirty minutes before.
 *
 * Setup lives in docs/notifications.md. Nothing here is secret: every key is
 * read from Script Properties, which stay inside your Google account.
 */

/* ------------------------------------------------------------------ config */

/* Bumped whenever this file changes. The editor and the deployed web app can
   run different code — saving updates the editor, only Deploy updates the web
   app — and every confusing hour spent on this script has come from that gap.
   Compare scriptVersion() in the editor against what the /exec URL reports in
   a browser; if they differ, the deployment is stale. */
var SCRIPT_VERSION = '2026-10-22a';

var REPO_OWNER  = 'sairanoorhadi';
var REPO_NAME   = 'cousins-book-club';
var REPO_BRANCH = 'main';
var INBOX_PATH  = 'data/inbox.json';
var STATE_PATH  = 'data/state.json';

/* How long before a meeting the two reminder emails go out. */
var REMIND_DAYS    = 5;
var REMIND_MINUTES = 30;

/* Submissions the web app will accept. Anything else is rejected. */
/* 'profile' used to be here. Nothing has sent it since profile changes moved
   to the signed-in profile-set endpoint, and nothing acts on one either --
   acceptSubmission has no branch for it. All it could still do was let a
   stranger append entries to data/inbox.json for ever. */
var KINDS = ['suggest', 'join', 'endorse', 'notify'];
/* The two that now need a signed-in, approved member behind them. 'join' is
   the sign-up itself and 'notify' is the reminder signup, so both stay open
   -- there is nobody to be signed in as yet. */
var KINDS_SIGNED_IN = ['suggest', 'endorse'];

/* ------------------------------------------------------------ voting
   Which book the club reads next. Every member rates every candidate from 1
   to 10 — ten being "I am dying to read this", one being "throw it in the
   bin" — and the highest total wins.

   The ballots do NOT live in data/state.json. That file is the public face of
   a public repository: anything in it can be read by anyone who finds the
   URL, for ever, including by the people whose ballots they are. They live in
   this script's own Script Properties instead, which nothing outside the
   script can read, and every write to them is serialised with LockService so
   two people voting in the same second cannot overwrite each other.

   What IS published is the arithmetic: how many have voted, and after the
   vote closes the totals and the winner. Not who gave what. */
var VOTE_MIN = 1, VOTE_MAX = 10;
var VOTE_BALLOT_KEY = 'ballots:';

/* The live vote, or the most recent one. Reading rather than deciding: the
   status is worked out from the clock every time, never stored, so a vote
   opens and closes on time whether or not anything happened to write to the
   file at the right moment. */
function voteOf(state, id) {
  var list = (state && state.votes) || [];
  if (id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  return list.length ? list[list.length - 1] : null;
}
function voteStatus(v, nowMs) {
  if (!v) return 'none';
  var now = nowMs || Date.now();
  if (v.cancelledAt) return 'cancelled';
  if (v.closedAt) return 'closed';
  var opens = Date.parse(v.opensAt), closes = Date.parse(v.closesAt);
  if (isFinite(opens) && now < opens) return 'scheduled';
  if (isFinite(closes) && now >= closes) return 'closed';
  return 'open';
}
function ballotKeyFor(id) { return VOTE_BALLOT_KEY + String(id || ''); }
function ballotsRead(id) {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(ballotKeyFor(id)) || '{}'); }
  catch (err) { return {}; }
}
function ballotsWrite(id, all) {
  PropertiesService.getScriptProperties().setProperty(ballotKeyFor(id), JSON.stringify(all));
}

/* One member's ratings, cleaned against the candidates the vote was launched
   with. A rating for a book that is not on the ballot is dropped rather than
   stored, and every candidate must carry a number in range or the ballot is
   refused — a half-filled ballot would quietly count as low scores. */
function voteRatings(v, raw) {
  var want = (v.candidates || []).map(function (c) { return String(c.id); });
  /* Nothing to rate is not a complete ballot. Without this, "every candidate
     carries a number" is trivially true of a vote with no candidates. */
  if (!want.length) return null;
  var out = {}, got = 0;
  want.forEach(function (id) {
    var n = Math.round(Number((raw || {})[id]));
    if (!isFinite(n) || n < VOTE_MIN || n > VOTE_MAX) return;
    out[id] = n; got++;
  });
  return got === want.length ? out : null;
}

function voteCast(payload) {
  var who = memberOnly(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member;

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var v = voteOf(state, String(payload.voteId || ''));
  if (!v) return { ok: false, error: 'no such vote' };
  /* A nomination round is not something you can cast a ballot in. Worth a
     line of its own because the failure was silent: a nomination round
     carries no candidates, so voteRatings() found nothing missing from an
     empty ballot, accepted it, and counted the sender in the turnout. */
  if (roundTypeOf(v) !== 'vote')
    return { ok: false, error: 'that round is nominations, not a vote' };

  /* The window is enforced here, not by hiding a button. A ballot posted
     before it opens or after it closes is refused whatever the page thinks. */
  var st = voteStatus(v);
  if (st === 'scheduled') return { ok: false, error: 'not open yet' };
  if (st === 'closed') return { ok: false, error: 'voting has closed' };
  if (st === 'cancelled') return { ok: false, error: 'vote cancelled' };
  /* A test vote is the organiser rehearsing. The site hides it from everyone
     else, but state.json is a public file and the site is not the only way to
     reach this URL, so the refusal lives here too. */
  if (v.test && normEmail(email) !== normEmail(propEmail('ORGANISER_EMAIL')))
    return { ok: false, error: 'that is a test vote' };

  var ballot;
  if (v.kind === 'runoff') {
    var pick = String(payload.pick || '');
    var ok = (v.candidates || []).some(function (c) { return String(c.id) === pick; });
    if (!ok) return { ok: false, error: 'pick one of the books' };
    ballot = { pick: pick };
  } else {
    var rates = voteRatings(v, payload.ratings);
    if (!rates) return { ok: false, error: 'rate every book from 1 to 10' };
    ballot = { ratings: rates };
  }
  ballot.at = new Date().toISOString();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var turnout;
  try {
    var all = ballotsRead(v.id);
    /* One ballot each: a second submission replaces the first rather than
       adding to it, which is what lets anyone change their mind. */
    all[member.id] = ballot;
    ballotsWrite(v.id, all);
    turnout = Object.keys(all).length;
  } finally {
    lock.releaseLock();
  }

  /* The count is public; the ballots are not. */
  var wrote = withState('A member voted', function (st2) {
    var vv = voteOf(st2, v.id);
    if (!vv) return { error: 'no such vote' };
    vv.turnout = turnout;
    return {};
  });
  return { ok: true, turnout: turnout, mine: ballot, published: !!wrote.ok };
}

/* Your own ballot, and nobody else's. There is no endpoint that returns
   another member's. */
function voteMine(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var member = memberFor(email);
  if (!member) return { ok: false, error: 'not a member yet' };
  var all = ballotsRead(String(payload.voteId || ''));
  return { ok: true, mine: all[member.id] || null };
}

/* Who has voted — ids only, never what they chose. Any signed-in member may
   ask, so the club can chase its own stragglers. Deliberately not published
   to state.json, which anyone at all can read. */
function voteWho(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  if (!memberFor(email)) return { ok: false, error: 'not a member yet' };
  var all = ballotsRead(String(payload.voteId || ''));
  return { ok: true, voted: Object.keys(all) };
}

/* Count the ballots and publish the arithmetic. Needs no permission of its
   own because it refuses to run until the vote is actually over: there is
   nothing here an organiser can do early that anyone else could not do
   honestly once the clock ran out. */
/* The session check for counting a vote lives on the endpoint, not here: the
   five-minute timer calls this function directly, with nobody signed in,
   which is how a vote closes and counts itself at the deadline. Checking in
   here broke that -- the timer counts as a stranger. */
function voteTallyEndpoint(payload) {
  var who = whoIs(payload.token);
  if (!who) return { ok: false, error: 'signed out' };
  if (!memberFor(who)) return { ok: false, error: 'not a member yet' };
  return voteTally(payload);
}
function voteTally(payload) {
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var v = voteOf(state, String(payload.voteId || ''));
  if (!v) return { ok: false, error: 'no such vote' };
  if (v.cancelledAt) return { ok: false, error: 'vote cancelled' };
  if (voteStatus(v) !== 'closed') return { ok: false, error: 'still open' };
  /* Hidden results read as "no totals in the file", which is exactly what a
     fresh count looks like -- so without this, counting again would put them
     straight back into the public file and quietly unhide them. */
  if (v.resultsHidden) return { ok: true, hidden: true, already: true };
  if (v.totals) return { ok: true, already: true, totals: v.totals, winner: v.winner };

  var all = ballotsRead(v.id);
  var ids = Object.keys(all);
  /* A ballot in a shape this code does not understand is counted as nothing
     and reported, rather than being read as a pile of zeroes. Nothing should
     ever be in the old most-liked/least-liked shape — the rated ballot is
     what shipped — but a ballot that silently scored every book zero would
     be a hard thing to notice afterwards. */
  var ignored = 0;
  ids.forEach(function (mid) {
    var b = all[mid] || {};
    var usable = v.kind === 'runoff' ? !!b.pick
      : (b.ratings && typeof b.ratings === 'object' && Object.keys(b.ratings).length);
    if (!usable) ignored++;
  });
  var rows = (v.candidates || []).map(function (c) {
    var total = 0, raters = 0, picks = 0;
    ids.forEach(function (mid) {
      var b = all[mid] || {};
      if (v.kind === 'runoff') { if (String(b.pick) === String(c.id)) picks++; }
      else {
        var n = Number((b.ratings || {})[c.id]);
        if (isFinite(n) && n) { total += n; raters++; }
      }
    });
    /* The average decides it, to one decimal — the same number the site
       shows, so what is displayed and what won cannot disagree. Every member
       rates every book, so this ranks the same as the running total; it is
       the average because that is what the result claims to be. */
    var avg = raters ? Math.round((total / raters) * 10) / 10 : 0;
    return { id: c.id, title: c.title,
             total: v.kind === 'runoff' ? picks : total,
             raters: v.kind === 'runoff' ? picks : raters,
             avg: v.kind === 'runoff' ? picks : avg };
  });
  var best = -1;
  rows.forEach(function (r) { if (r.avg > best) best = r.avg; });
  var top = rows.filter(function (r) { return r.avg === best && r.raters > 0; });
  rows.sort(function (a, b) { return b.avg - a.avg; });

  var out = withState('Vote counted', function (st2) {
    var vv = voteOf(st2, v.id);
    if (!vv) return { error: 'no such vote' };
    vv.totals = rows;
    vv.turnout = ids.length;
    if (!vv.closedAt) vv.closedAt = new Date().toISOString();
    /* A tie is reported as a tie. The organiser launches a runoff or breaks
       it by hand; this does not pick for them. */
    vv.winner = (ids.length && top.length === 1) ? top[0].id : null;
    vv.tied = top.length > 1 ? top.map(function (r) { return r.id; }) : null;
    return {};
  });
  if (!out.ok) return out;
  return { ok: true, totals: rows, winner: top.length === 1 ? top[0].id : null,
           tied: top.length > 1 ? top.map(function (r) { return r.id; }) : null,
           turnout: ids.length, ignored: ignored };
}

/* ---------------------------------------------- hiding a result

   The shortlist tab shows a closed vote's results until the organiser is
   done with them. "Done" has to mean gone from data/state.json too, not just
   undrawn: the file is public, and a result nobody is shown but anybody can
   read is not hidden.

   So the totals are MOVED rather than deleted -- stashed here, where only the
   script can read them, and written back when results are shown again. Delete
   them and "Show results again" would have nothing to restore. */
var RESULTS_KEY = 'results:';

function resultsKeyFor(id) { return RESULTS_KEY + String(id || ''); }
function resultsStash(id) {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(resultsKeyFor(id)) || 'null'); }
  catch (err) { return null; }
}
function resultsStashWrite(id, rec) {
  PropertiesService.getScriptProperties()
    .setProperty(resultsKeyFor(id), JSON.stringify(rec));
}

/* Organiser only, and only for a vote that is actually over. */
function voteResultsVisible(payload, hide) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var v = voteOf(state, String(payload.voteId || ''));
  if (!v) return { ok: false, error: 'no such vote' };
  if (roundTypeOf(v) !== 'vote') return { ok: false, error: 'that round is not a vote' };
  if (voteStatus(v) !== 'closed') return { ok: false, error: 'that vote is not closed yet' };

  if (hide) {
    /* Stash first, publish second. If the write to the repo fails, the
       totals are still safe here and nothing has been lost. */
    if (v.totals) {
      resultsStashWrite(v.id, { totals: v.totals, winner: v.winner || null,
        tied: v.tied || null, at: new Date().toISOString() });
    }
    var hid = withState('Results hidden from the site', function (st) {
      var vv = voteOf(st, v.id);
      if (!vv) return { error: 'no such vote' };
      vv.resultsHidden = true;
      vv.totals = null;
      return {};
    });
    if (!hid.ok) return hid;
    return { ok: true, hidden: true, results: resultsStash(v.id) };
  }

  var keep = resultsStash(v.id);
  var shown = withState('Results shown on the site', function (st) {
    var vv = voteOf(st, v.id);
    if (!vv) return { error: 'no such vote' };
    vv.resultsHidden = false;
    if (keep && keep.totals) {
      vv.totals = keep.totals;
      if (keep.winner) vv.winner = keep.winner;
      vv.tied = keep.tied || null;
    }
    return {};
  });
  if (!shown.ok) return shown;
  return { ok: true, hidden: false, results: keep };
}

/* The stashed results, for Admin to show while they are hidden from the site.
   Organiser only. Nothing here is per-member: it is the same arithmetic that
   was public a moment ago. */
function voteResultsRead(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };
  return { ok: true, results: resultsStash(String(payload.voteId || '')) };
}

/* Nothing keeps ballots for a vote that was cancelled or whose result is
   already published and settled. */
function voteForget(id) {
  PropertiesService.getScriptProperties().deleteProperty(ballotKeyFor(id));
}

/* -------------------------------------------------- voting: the timer and
   the emails that go with it

   Three things happen with nobody on the site: the start email goes out when
   a vote opens, a nudge goes out VOTE_REMIND_HOURS before the deadline, and a
   vote past its deadline is counted and its result published.

   Opening and closing need no timer at all. voteStatus() works the status out
   from the clock, so a vote is open the instant opensAt passes and shut the
   instant closesAt does, whether or not anything ran. What the timer adds is
   the email, the count and the published result -- so the lag below is a lag
   on those, never on whether a ballot is taken.

   What the timer has already done is remembered in Script Properties rather
   than in state.json. The organiser's saves rewrite that file wholesale, and
   a flag a save can erase is a flag that can double-send. */
var VOTE_TICK_MINUTES = 5;
var VOTE_REMIND_HOURS = 6;
/* Recipients held back for sign-in codes. MailApp counts its daily allowance
   per recipient, so one club-wide bcc of a dozen people is a dozen off a
   personal Gmail's small ration -- the same ration the six-digit codes come
   out of. Nobody should be locked out of signing in because a nudge went. */
var VOTE_MAIL_RESERVE = 20;
var VOTE_MAIL_KEY = 'votemail:';
var VOTE_MAIL_ERRORS = 12;
/* The club's own clock. The times are stored as ISO strings with an offset,
   so every member's browser shows them their own time -- but an email has no
   browser to ask, and the club's hours are Eastern. */
var VOTE_TZ = 'America/New_York';

function voteMailKeyFor(id) { return VOTE_MAIL_KEY + String(id || ''); }
function voteMailFlags(id) {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(voteMailKeyFor(id)) || '{}'); }
  catch (err) { return {}; }
}
function voteMailFlagsWrite(id, rec) {
  PropertiesService.getScriptProperties()
    .setProperty(voteMailKeyFor(id), JSON.stringify(rec));
}
/* A failure is written down and shown in Admin rather than thrown. An email
   that did not go is worth knowing about; it is not worth stopping a vote. */
function voteMailNote(rec, stage, why) {
  rec.errors = (rec.errors || []).concat([{ at: new Date().toISOString(),
    stage: stage, why: String(why).slice(0, 300) }]).slice(-VOTE_MAIL_ERRORS);
  Logger.log('vote mail [' + stage + ']: ' + why);
}

/* Every member with an address, whatever their notification preferences say.
   A vote is club business rather than a subscription: somebody who turned
   meeting reminders off still gets told the club is choosing its next book.

   People waiting to be approved are not here at all. A join request sits
   unhandled in the inbox and never reaches state.members, so excluding them
   is the shape of the data rather than a filter that could be forgotten. */
function voteAddresses(state) {
  var seen = {}, list = [], missing = [];
  (state.members || []).forEach(function (m) {
    if (!m || m.pending) return;
    var address = normEmail(lookupEmail(m.notifyRef) || m.email || '');
    if (!address || address.indexOf('@') === -1) { missing.push(m.name || m.id); return; }
    if (seen[address]) return;
    seen[address] = 1;
    list.push(address);
  });
  return { list: list, missing: missing };
}

/* A test vote reaches the organiser and nobody else. It is the only way to
   rehearse this: the emails, the timer and the automatic count cannot be
   tried anywhere but live. */
function voteTestRecipients() {
  var mine = propEmail('ORGANISER_EMAIL');
  return { list: mine ? [mine] : [],
           missing: mine ? [] : ['ORGANISER_EMAIL is not set in Script Properties'] };
}

/* Who the nudge goes to: members who have not voted. A nudge has no business
   reaching somebody who already did the thing, and leaving them out tells
   nobody anything -- no recipient learns who else got it. Addresses only;
   which member each belongs to is not returned. */
function voteStillToVote(state, v) {
  /* "Has not done it yet" means no ballot in a vote and no book put forward
     in a nomination round. One function, because the question the nudge asks
     is the same either way. */
  var all = roundTypeOf(v) === 'nomination'
    ? nomsRead(v.id).members
    : ballotsRead(v.id);
  var out = [], seen = {};
  (state.members || []).forEach(function (m) {
    if (!m || m.pending || all[m.id]) return;
    var address = normEmail(lookupEmail(m.notifyRef) || m.email || '');
    if (!address || address.indexOf('@') === -1 || seen[address]) return;
    seen[address] = 1;
    out.push(address);
  });
  return out;
}

function voteEastern(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, VOTE_TZ, "EEEE d MMMM 'at' h:mm a z");
}
/* The same deep link the landing banner uses, so the email and the site
   agree about where voting happens. */
function voteLink() {
  return 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/#recs-shortlist';
}
/* Nominations happen on the recommendations grid, so the email points there. */
function nomLink() {
  return 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/#recs';
}

/* Both emails, in one place, so what goes out can be read without sending
   it -- previewVoteEmails() does exactly that. */
function voteMailCopy(state, v, stage) {
  var clubName = (state.club && state.club.name) || 'Book club';
  var titles = (v.candidates || []).map(function (c) {
    return '  • ' + c.title + (c.author ? ' by ' + c.author : '');
  }).join('\n');
  var closes = voteEastern(v.closesAt);
  var runoff = v.kind === 'runoff';
  var tag = v.test ? '[TEST] ' : '';

  /* A nomination round asks for something else and points somewhere else, so
     it has its own words -- but the same two stages, the same tag, the same
     closing time and the same once-only flags around it. */
  if (roundTypeOf(v) === 'nomination') {
    if (stage === 'remind') {
      return { subject: tag + clubName + ': ' + VOTE_REMIND_HOURS +
          ' hours left to put a book forward',
        body: [clubName, '',
          'Nominations close ' + closes + ', and you have not put a book forward yet.', '',
          'Pick any book from the recommendations \u2014 one each. You can change it ' +
            'until nominations close.', '',
          nomLink(), '',
          'Whatever is nominated becomes the shortlist we vote on.'].join('\n') };
    }
    return { subject: tag + clubName + ': nominations are now open',
      body: [clubName, '',
        'Nominations are now open for the book we read next.', '',
        'Put one book forward from the recommendations \u2014 one each. Whatever is ' +
          'nominated becomes the shortlist we then vote on.', '',
        'Nominations close ' + closes + '.', '',
        nomLink(), '',
        'You can change or withdraw your nomination until they close.'].join('\n') };
  }

  /* A tie used to hold the results email and say nothing to anybody. That
     left the club waiting on an announcement that was never coming. It gets
     its own email instead -- one bcc rather than one each, because unlike the
     results it carries nothing about any individual's ballot. */
  if (stage === 'tie') {
    var tiedNames = (v.tied || []).map(function (id) {
      var c = voteCandidate2(v, id);
      return c ? c.title : id;
    });
    var at = (v.totals || []).filter(function (r) {
      return (v.tied || []).indexOf(r.id) !== -1;
    })[0];
    return { subject: tag + clubName + ': the vote tied',
      body: [clubName, '',
        'The vote ended in a tie' +
          (tiedNames.length ? ' between ' + voteAndList(tiedNames) : '') +
          (at ? ', both on ' + Number(at.avg || 0).toFixed(1) + ' out of 10' : '') + '.',
        '',
        'There will be a runoff to settle it. You will get another email when ' +
          'it opens, and it only takes a moment to pick one.',
        '', voteLink()].join('\n') };
  }

  if (stage === 'remind') {
    return { subject: tag + clubName + ': ' + VOTE_REMIND_HOURS + ' hours left to vote',
      body: [clubName, '',
        'Voting closes ' + closes + ', and you have not voted yet.', '',
        runoff ? 'Pick one:' : 'Rate each one from 1 to 10:',
        titles, '',
        voteLink(), '',
        runoff ? 'Most picks wins.' : 'It takes a minute. The highest average wins.'
      ].join('\n') };
  }
  return { subject: tag + clubName + ': ' +
      (runoff ? 'a runoff — the vote tied' : 'voting is open for the next book'),
    body: [clubName, '',
      runoff
        ? 'The vote ended in a tie, so there is a runoff between the books that tied. Pick one:'
        : 'Voting is open for the book we read next. Rate each one from 1 to 10 — ten being "I am dying to read this", one being "throw it in the bin".',
      '', titles, '',
      'Voting closes ' + closes + '.', '',
      voteLink(), '',
      runoff
        ? 'Most picks wins. You can change your pick until it closes.'
        : 'The highest average wins. You can change your ratings until it closes.'
    ].join('\n') };
}

/* One message to exactly the addresses handed over, once each, with everyone
   but the one in To hidden from everyone else.

   This does not go through send(), and the reason matters. send() puts
   ORGANISER_EMAIL in To whatever list it is given, which is right for a
   meeting notice -- the organiser wants every one of those -- but wrong here:
   the nudge says "you have not voted yet", and she would get it after
   voting. The bcc discipline is send()'s, and so is the one MailApp call;
   what is dropped is the extra recipient it adds. */
function voteSendMail(to, subject, body) {
  var organiser = normEmail(propEmail('ORGANISER_EMAIL'));
  /* The organiser goes in To when she is one of the recipients, since a
     message with her in To looks like what it is. Otherwise the first
     address does, because a bcc needs something in To. */
  var head = to.filter(function (a) { return normEmail(a) === organiser; })[0] || to[0];
  var rest = to.filter(function (a) { return a !== head; });
  if (!rest.length) { MailApp.sendEmail({ to: head, subject: subject, body: body }); return; }
  MailApp.sendEmail({ to: head, bcc: rest.join(','), subject: subject, body: body });
}

/* One send, after checking there is enough allowance left to cover it.
   The flag is written only on success, so a send skipped for want of quota
   is tried again on the next tick -- once the allowance rolls over, it goes. */
function voteSendTo(to, subject, body, rec, stage) {
  if (!to.length) { voteMailNote(rec, stage, 'nobody to send to'); return false; }
  var left = -1;
  try { left = MailApp.getRemainingDailyQuota(); } catch (err) { left = -1; }
  if (left >= 0 && left < to.length + VOTE_MAIL_RESERVE) {
    voteMailNote(rec, stage, 'not enough email left today: ' + left + ' recipients for ' +
      to.length + ' to send, keeping ' + VOTE_MAIL_RESERVE + ' back for sign-in codes');
    return false;
  }
  try {
    voteSendMail(to, subject, body);
    return true;
  } catch (err) {
    voteMailNote(rec, stage, String((err && err.message) || err));
    return false;
  }
}

/* The timer. Does only what is due, so a quiet tick does nothing at all, and
   it is safe to run twice in the same minute -- which is what lets the site
   poke it the moment a vote is launched rather than waiting for the clock. */
function voteTick() {
  stateForget();
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { Logger.log('voteTick: could not read state.json: ' + err); return; }
  var now = Date.now();
  (state.votes || []).forEach(function (v) {
    try { voteTickOne(state, v, now); }
    catch (err) { Logger.log('voteTick: ' + ((v && v.id) || '?') + ': ' + err); }
  });
}

function voteTickOne(state, v, now) {
  if (!v || !v.id || v.cancelledAt) return;
  var st = voteStatus(v, now);
  if (st === 'scheduled' || st === 'cancelled') return;

  var rec = voteMailFlags(v.id), changed = false;

  /* Too short to nudge in: VOTE_REMIND_HOURS or less of voting leaves no room
     between the start email and the deadline, so the reminder is written off
     here rather than fired late. The launch form says so before you launch.

     At exactly VOTE_REMIND_HOURS the nudge would be due the second the vote
     opened and arrive in the same minute as the start email, which is why
     the boundary counts as no room -- and the "6 hours" button on the launch
     form makes exactly that window, so it is the ordinary case, not a corner. */
  if (!rec.remind && !rec.remindSkipped) {
    var span = Date.parse(v.closesAt) - Date.parse(v.opensAt);
    if (isFinite(span) && span <= VOTE_REMIND_HOURS * 3600000) {
      rec.remindSkipped = true;
      changed = true;
    }
  }

  if (st === 'open' && !rec.opened) {
    var who = v.test ? voteTestRecipients() : voteAddresses(state);
    var copy = voteMailCopy(state, v, 'open');
    /* Not a failure, but the organiser should be able to see who has no
       address on file and so heard nothing. */
    if (who.missing.length) rec.missing = who.missing;
    if (voteSendTo(who.list, copy.subject, copy.body, rec, 'open')) {
      rec.opened = new Date().toISOString();
      rec.openedTo = who.list.length;
    }
    changed = true;
  } else if (st === 'closed' && !rec.opened) {
    /* The whole window went by without a tick -- no trigger installed, or a
       test vote shorter than the interval. Nothing is sent after the fact:
       "voting is open" about a vote that is over is worse than silence. */
    rec.opened = 'missed';
    voteMailNote(rec, 'open', 'the vote had already closed before the timer saw it, ' +
      'so no start email went out');
    changed = true;
  }

  if (st === 'open' && !rec.remind && !rec.remindSkipped) {
    var left = Date.parse(v.closesAt) - now;
    if (isFinite(left) && left <= VOTE_REMIND_HOURS * 3600000) {
      var to = v.test ? voteTestRecipients().list : voteStillToVote(state, v);
      if (!to.length) {
        /* Everyone has voted. The flag goes down anyway: there is nobody to
           nudge, and leaving it up would fire the moment somebody joined. */
        rec.remind = new Date().toISOString();
        rec.remindTo = 0;
      } else {
        var nudge = voteMailCopy(state, v, 'remind');
        if (voteSendTo(to, nudge.subject, nudge.body, rec, 'remind')) {
          rec.remind = new Date().toISOString();
          rec.remindTo = to.length;
        }
      }
      changed = true;
    }
  }

  if (st === 'closed' && roundTypeOf(v) === 'nomination' && !v.closedAt) {
    /* Nothing to count: the counts were published on every nomination. What
       closing adds is the stamp, so the record stops depending on the clock. */
    var done = nomSettle(v);
    if (done && done.ok) rec.counted = new Date().toISOString();
    else voteMailNote(rec, 'count', (done && done.error) || 'could not settle the round');
    changed = true;
  }

  if (st === 'closed' && roundTypeOf(v) === 'vote' && !v.totals && !v.resultsHidden) {
    var out = voteTally({ voteId: v.id });
    if (out && out.ok) {
      rec.counted = new Date().toISOString();
      /* A tie is left standing. The runoff is a new question put to the club,
         not arithmetic, so Admin shows it waiting and this picks nothing. */
      rec.tied = out.tied || null;
    } else {
      voteMailNote(rec, 'count', (out && out.error) || 'the count failed');
    }
    changed = true;
  }

  /* The results email. Written before the send so the flags are on disk if
     the send throws, and read back after so Admin sees what happened.

     This runs on every tick of a closed vote, not only the one that counted
     it: a vote held back for a tie has nothing to announce until the tie is
     settled, and the tick after the tiebreak is when it becomes sendable. */
  if (st === 'closed' && roundTypeOf(v) === 'vote') {
    var flags = voteMailFlags(v.id);
    if (!flags.results && flags.resultsHeld !== 'runoff') {
      voteMailFlagsWrite(v.id, rec);
      /* Read the state again rather than reusing the copy this tick started
         with. voteTally() has just written the totals to the repo, and the
         copy in hand predates that -- so building the email from it finds no
         totals, decides the vote has not been counted, and sends nothing. The
         first run of this did exactly that. */
      stateForget();
      var res = voteResultsSend({ voteId: v.id }, {});
      rec = voteMailFlags(v.id);
      if (res && res.ok && res.sent) Logger.log('results email: ' + res.sent + ' sent');
      changed = true;
    }
  }

  if (changed) voteMailFlagsWrite(v.id, rec);
}

/* The site pokes this the moment a vote is launched, so "Now" means now
   instead of within VOTE_TICK_MINUTES. It does exactly what a tick does and
   nothing a tick would not have done by itself, which is what makes it safe
   to expose: the stored flags mean no poke can send anything twice. */
function voteWake(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  if (!memberFor(email)) return { ok: false, error: 'not a member yet' };
  try { voteTick(); } catch (err) { return { ok: false, error: String(err) }; }
  return { ok: true };
}

/* What the timer has done, for the Admin tab: whether it is installed, how
   much email allowance is left, and every send that failed. Organiser only --
   not because the answers are sensitive, since they say nothing about who
   voted, but because nobody else has a reason to ask. */
function voteMailStatus(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };

  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (err) { quota = -1; }
  var installed = null;
  try { installed = voteTriggerInstalled(); } catch (err) { installed = null; }
  var flags = {};
  [].concat(payload.voteIds || []).slice(0, 20).forEach(function (id) {
    flags[String(id)] = voteMailFlags(String(id));
  });
  return { ok: true, installed: installed, everyMinutes: VOTE_TICK_MINUTES,
           remindHours: VOTE_REMIND_HOURS, quota: quota, reserve: VOTE_MAIL_RESERVE,
           flags: flags };
}


/* ------------------------------------------------- the results email

   Sent once a vote has closed and been counted. It extends the two emails
   above rather than standing beside them: the same quota floor, the same
   per-vote flag record, the same test mode, the same Eastern times, the same
   failure log that Admin reads.

   One thing it cannot share is the send itself. The other two are one
   message bcc'd to everybody; this one tells each member what THEY rated
   each book, so it is one message per recipient. That costs one unit of the
   daily allowance per member rather than one per club, which is why the
   quota is checked against the whole list before any of it goes.

   Nobody is told anything about anybody else. The body is built here, from
   ballots that only this script can read, and the only ballot in each
   message is the reader's own. */

/* Members who cast a ballot, as {memberId: address}. Addresses come from the
   same email-reference lookup every other email uses. */
function voteResultsAudience(state, v, toAll) {
  var ballots = ballotsRead(v.id), out = [], seen = {};
  (state.members || []).forEach(function (m) {
    if (!m || m.pending) return;
    if (!toAll && !ballots[m.id]) return;
    var address = normEmail(lookupEmail(m.notifyRef) || m.email || '');
    if (!address || address.indexOf('@') === -1 || seen[address]) return;
    seen[address] = 1;
    out.push({ id: m.id, email: address, ballot: ballots[m.id] || null });
  });
  return out;
}

/* Why a result is not being announced yet, or '' if it is ready. */
function voteResultsHold(v) {
  if (roundTypeOf(v) !== 'vote') return 'not a vote';
  if (v.cancelledAt) return 'cancelled';
  if (voteStatus(v) !== 'closed') return 'still open';
  if (!v.totals) return 'not counted yet';
  if ((v.tied || []).length && !v.winner) return 'tie';
  return '';
}

/* A vote whose tie was settled by launching a runoff has nothing left to
   announce: the runoff is the answer, and its own results email carries it.
   Sending both would be two emails about one question. */
function voteSupersededByRunoff(state, v) {
  return (state.votes || []).some(function (x) {
    return x && x.parent === v.id && x.kind === 'runoff' && !x.cancelledAt;
  });
}

function voteResultsCopy(state, v, who) {
  var clubName = (state.club && state.club.name) || 'Book club';
  var runoff = v.kind === 'runoff';
  var tag = v.test ? '[TEST] ' : '';
  var rows = (v.totals || []).slice();
  var win = v.winner ? (voteCandidate2(v, v.winner) || {}) : null;
  var byHand = v.tiebreak && v.tiebreak.by;
  var mine = (who && who.ballot) || null;

  var lines = [clubName, ''];
  if (win && win.title) {
    lines.push(byHand
      ? 'The vote tied, so ' + win.title + ' was chosen by the organiser.'
      : 'The club is reading ' + win.title + '.');
  } else {
    lines.push('The vote has closed.');
  }
  lines.push('');
  lines.push(runoff ? 'How the runoff went:' : 'How every book did, best first:');
  rows.forEach(function (r) {
    var c = voteCandidate2(v, r.id) || { title: r.title };
    var mark = (v.winner && String(v.winner) === String(r.id)) ? ' <- the winner' : '';
    if (runoff) {
      var picked = mine && String(mine.pick) === String(r.id);
      lines.push('  ' + c.title + ' - ' + (r.total || 0) +
        ((r.total === 1) ? ' pick' : ' picks') + (picked ? ' (your pick)' : '') + mark);
    } else {
      var yours = mine && mine.ratings ? mine.ratings[r.id] : null;
      lines.push('  ' + c.title + ' - ' + Number(r.avg || 0).toFixed(1) + ' out of 10 from ' +
        (r.raters || 0) + ((r.raters === 1) ? ' rating' : ' ratings') +
        (yours ? '   (you gave it ' + yours + ')' : '') + mark);
    }
  });
  lines.push('');
  if (!mine) lines.push('You did not vote in this one.', '');
  lines.push('Closed ' + voteEastern(v.closedAt || v.closesAt) + '. ' +
    (v.turnout || 0) + ' of ' + voteMemberCount(state) + ' voted.');
  lines.push('', voteLink());
  lines.push('', 'Nobody sees anybody else\'s ratings, including the organiser.');

  return { subject: tag + clubName + ': ' +
      (win && win.title
        ? (runoff ? 'the runoff went to ' + win.title : 'we are reading ' + win.title)
        : 'the vote has closed'),
    body: lines.join('\n') };
}

/* "A and B", or "A, B and C". */
function voteAndList(names) {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/* The page has a voteCandidate(); the script needs its own. */
function voteCandidate2(v, id) {
  var hit = (v.candidates || []).filter(function (c) { return String(c.id) === String(id); });
  return hit[0] || null;
}
function voteMemberCount(state) {
  return (state.members || []).filter(function (m) { return m && !m.pending; }).length;
}

/* Send it, once. The flag lives in the same record as the other two emails,
   so a second tick, an early close and the Admin button cannot between them
   produce two. Returns the flag record so Admin can say what happened. */
function voteResultsSend(payload, opts) {
  opts = opts || {};
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var v = voteOf(state, String(payload.voteId || ''));
  if (!v) return { ok: false, error: 'no such vote' };
  return voteResultsSendFor(state, v, opts);
}

function voteResultsSendFor(state, v, opts) {
  opts = opts || {};
  var rec = voteMailFlags(v.id);

  if (!opts.meOnly && rec.results) {
    return { ok: true, already: true, results: rec.results };
  }
  if (v.resultsEmail === false && !opts.force && !opts.meOnly) {
    return { ok: true, skipped: 'switched off for this vote' };
  }

  var hold = voteResultsHold(v);
  if (hold && !opts.meOnly) {
    if (hold === 'tie' && voteSupersededByRunoff(state, v)) {
      rec.resultsHeld = 'runoff';
      voteMailFlagsWrite(v.id, rec);
      return { ok: true, skipped: 'a runoff is answering this one instead' };
    }
    if (hold === 'tie') {
      rec.resultsHeld = 'tie';
      /* Told once. The results email itself still waits for the tie to be
         settled -- this only says that it has not been. */
      if (!rec.tieTold) {
        var tieWho = v.test ? voteTestRecipients().list
          : voteResultsAudience(state, v, v.resultsToAll === true)
              .map(function (w) { return w.email; });
        var tieCopy = voteMailCopy(state, v, 'tie');
        if (voteSendTo(tieWho, tieCopy.subject, tieCopy.body, rec, 'tie')) {
          rec.tieTold = { at: new Date().toISOString(), n: tieWho.length };
        }
      }
      voteMailFlagsWrite(v.id, rec);
      return { ok: true, held: 'tie', tieTold: rec.tieTold || null };
    }
    return { ok: false, error: hold };
  }

  var organiser = propEmail('ORGANISER_EMAIL');
  var audience;
  if (opts.meOnly || v.test) {
    if (!organiser) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
    /* Her own ballot, if she cast one, so the preview shows a real row. */
    var meMember = memberFor(organiser);
    var ballots = ballotsRead(v.id);
    audience = [{ id: meMember ? meMember.id : '', email: organiser,
                  ballot: meMember ? (ballots[meMember.id] || null) : null }];
  } else {
    audience = voteResultsAudience(state, v, v.resultsToAll === true);
  }
  if (!audience.length) {
    voteMailNote(rec, 'results', 'nobody to send to');
    voteMailFlagsWrite(v.id, rec);
    return { ok: false, error: 'nobody to send to' };
  }

  /* One message each, so the allowance is checked against the whole list. */
  var left = -1;
  try { left = MailApp.getRemainingDailyQuota(); } catch (err) { left = -1; }
  if (left >= 0 && left < audience.length + VOTE_MAIL_RESERVE) {
    voteMailNote(rec, 'results', 'not enough email left today: ' + left +
      ' recipients for ' + audience.length + ' to send, keeping ' +
      VOTE_MAIL_RESERVE + ' back for sign-in codes');
    voteMailFlagsWrite(v.id, rec);
    return { ok: false, error: 'not enough email quota' };
  }

  var sent = 0, failed = 0;
  audience.forEach(function (who) {
    var copy = voteResultsCopy(state, v, who);
    try {
      MailApp.sendEmail({ to: who.email, subject: copy.subject, body: copy.body });
      sent++;
    } catch (err) {
      failed++;
      /* The address is logged, never the ballot. */
      voteMailNote(rec, 'results', 'to ' + maskEmail(who.email) + ': ' +
        String((err && err.message) || err));
    }
  });

  if (opts.meOnly) {
    voteMailFlagsWrite(v.id, rec);
    return { ok: sent > 0, meOnly: true, sent: sent, failed: failed };
  }
  if (sent) {
    rec.results = { at: new Date().toISOString(), n: sent,
                    failed: failed || 0, test: !!v.test };
    delete rec.resultsHeld;
  }
  voteMailFlagsWrite(v.id, rec);
  return { ok: sent > 0, sent: sent, failed: failed, results: rec.results || null };
}

/* The two Admin buttons: send it now, or send a copy to me only for
   checking the wording. Organiser only, both of them. */
function voteResultsGo(payload, meOnly) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };
  return voteResultsSend(payload, meOnly ? { meOnly: true } : { force: true });
}

/* What the email will say, without sending it. Organiser only. */
function voteResultsPreview(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var v = voteOf(state, String(payload.voteId || ''));
  if (!v) return { ok: false, error: 'no such vote' };

  var meMember = memberFor(mine);
  var ballots = ballotsRead(v.id);
  var who = { id: meMember ? meMember.id : '', email: mine,
              ballot: meMember ? (ballots[meMember.id] || null) : null };
  var copy = voteResultsCopy(state, v, who);
  var rec = voteMailFlags(v.id);
  var aud = voteResultsAudience(state, v, v.resultsToAll === true);
  return { ok: true, subject: copy.subject, body: copy.body,
           hold: voteResultsHold(v), held: rec.resultsHeld || '',
           sentAt: (rec.results || {}).at || '', sentTo: (rec.results || {}).n || 0,
           would: v.test ? 1 : aud.length, test: !!v.test,
           quota: (function(){ try { return MailApp.getRemainingDailyQuota(); }
                               catch (e) { return -1; } })() };
}

/* Nothing keeps the timer's notes for a vote that is gone. */
function voteMailForget(id) {
  PropertiesService.getScriptProperties().deleteProperty(voteMailKeyFor(id));
}

/* ------------------------------------------------------- nominations

   The round before the vote: members put books forward, one each, and what
   comes out of it becomes the shortlist the vote runs on.

   This shares the vote's machinery rather than copying it. A nomination round
   and a vote are both ROUNDS -- the same window, the same four statuses, the
   same timer, the same emails, the same slot on the landing page -- and the
   record carries a `type` saying which it is. A record with no type is a
   vote, which is what every record written before today is, so the migration
   is nothing at all. voteStatus() already works the status out from the clock
   and touches no vote-specific field, so it is the round's status function
   too and is called that way below.

   What is NOT shared is what each round collects: a vote collects a ballot
   per member, a nomination round collects one book id per member. Those are
   different enough to keep apart, and both live in this script's private
   store rather than in the public file.

   Nominations are stored exactly as ballots are, and for the same reason:
   data/state.json is the public face of a public repository, so who put a
   book forward is nobody's business but the organiser's. What is published
   is the arithmetic -- which books, how many each, who added them (a member
   or the organiser), and how many members have taken part. Never a name. */
var NOM_KEY = 'noms:';

function roundTypeOf(r) { return (r && r.type === 'nomination') ? 'nomination' : 'vote'; }
function nomKeyFor(id) { return NOM_KEY + String(id || ''); }

/* { members: { memberId: {recId, at} }, organiser: [recId, ...] }
   The organiser's extras are kept apart from the members' so that adding one
   cannot be mistaken for somebody's nomination, and so that turnout counts
   members and only members. */
function nomsRead(id) {
  var rec;
  try { rec = JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(nomKeyFor(id)) || '{}'); }
  catch (err) { rec = {}; }
  if (!rec || typeof rec !== 'object') rec = {};
  if (!rec.members || typeof rec.members !== 'object') rec.members = {};
  if (!Array.isArray(rec.organiser)) rec.organiser = [];
  return rec;
}
function nomsWrite(id, rec) {
  PropertiesService.getScriptProperties().setProperty(nomKeyFor(id), JSON.stringify(rec));
}
function nomsForget(id) {
  PropertiesService.getScriptProperties().deleteProperty(nomKeyFor(id));
}

/* What gets published: one entry per book, however many members chose it, with
   the count and whether the organiser put it there. Several members
   nominating the same book is one entry with n: 2, which is what the Admin
   list and the shortlist step both want. */
function nomCounts(rec) {
  var byRec = {}, order = [];
  Object.keys(rec.members).forEach(function (mid) {
    var rid = String((rec.members[mid] || {}).recId || '');
    if (!rid) return;
    if (!byRec[rid]) { byRec[rid] = { id: rid, n: 0, org: false }; order.push(rid); }
    byRec[rid].n++;
  });
  rec.organiser.forEach(function (rid) {
    rid = String(rid || '');
    if (!rid) return;
    if (!byRec[rid]) { byRec[rid] = { id: rid, n: 0, org: true }; order.push(rid); }
    else byRec[rid].org = true;
  });
  return order.map(function (rid) { return byRec[rid]; });
}

/* Published back to state.json after every change, so the landing banner and
   the Admin list can be drawn without asking the script. Only ids, counts and
   a flag -- the member ids stay here. */
function nomPublish(roundId, rec, message) {
  var counts = nomCounts(rec), turnout = Object.keys(rec.members).length;
  var out = withState(message, function (st) {
    var rr = voteOf(st, roundId);
    if (!rr) return { error: 'no such round' };
    rr.nominated = counts;
    rr.turnout = turnout;
    return {};
  });
  return { counts: counts, turnout: turnout, published: !!out.ok };
}

/* The round this is about, with the window enforced here rather than by what
   the page chose to show. Returns a string on refusal. */
function nomRoundFor(roundId) {
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return 'unreadable state'; }
  var r = voteOf(state, String(roundId || ''));
  if (!r) return 'no such round';
  if (roundTypeOf(r) !== 'nomination') return 'that round is a vote, not nominations';
  return { state: state, round: r };
}
function nomOpenRoundFor(roundId) {
  var got = nomRoundFor(roundId);
  if (typeof got === 'string') return got;
  var st = voteStatus(got.round);
  if (st === 'scheduled') return 'nominations have not opened yet';
  if (st === 'closed') return 'nominations have closed';
  if (st === 'cancelled') return 'that round was cancelled';
  return got;
}

/* A member and the round they are acting on, or the reason not to. */
function nomActor(payload, needOpen) {
  /* Nominating is a club member's say in what the club reads next, so an
     observer is told so rather than left with "not a member yet", which
     sounds like something that will change on its own. */
  var who = memberOnly(payload);
  if (typeof who === 'string') return who;
  var email = who.email, member = who.member;
  var got = needOpen ? nomOpenRoundFor(payload.roundId) : nomRoundFor(payload.roundId);
  if (typeof got === 'string') return got;
  /* A test round is the organiser rehearsing. The site hides it, but
     state.json is public and the site is not the only way to reach this URL. */
  if (got.round.test && normEmail(email) !== normEmail(propEmail('ORGANISER_EMAIL')))
    return 'that is a test round';
  got.member = member;
  got.email = email;
  return got;
}

/* One member, one book. A second nomination replaces the first rather than
   adding to it -- which is what lets anyone change their mind, and what makes
   "at most one active nomination" true by construction instead of by a check
   that could be skipped. */
function nomCast(payload) {
  var got = nomActor(payload, true);
  if (typeof got === 'string') return { ok: false, error: got };

  var recId = String(payload.recId || '');
  var elig = (got.state.recs || []).filter(function (x) {
    return String(x.id) === recId && x.status === 'approved';
  })[0];
  /* Approved recommendations only. A book promoted to the reading list has
     left state.recs altogether, so it is excluded by not being there. */
  if (!elig) return { ok: false, error: 'that book is not up for nomination' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var rec, had;
  try {
    rec = nomsRead(got.round.id);
    had = (rec.members[got.member.id] || {}).recId || null;
    rec.members[got.member.id] = { recId: recId, at: new Date().toISOString() };
    nomsWrite(got.round.id, rec);
  } finally {
    lock.releaseLock();
  }
  var pub = nomPublish(got.round.id, rec, 'A member nominated a book');
  return { ok: true, mine: recId, replaced: (had && had !== recId) ? had : null,
           counts: pub.counts, turnout: pub.turnout, published: pub.published };
}

function nomClear(payload) {
  var got = nomActor(payload, true);
  if (typeof got === 'string') return { ok: false, error: got };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var rec;
  try {
    rec = nomsRead(got.round.id);
    delete rec.members[got.member.id];
    nomsWrite(got.round.id, rec);
  } finally {
    lock.releaseLock();
  }
  var pub = nomPublish(got.round.id, rec, 'A member took back a nomination');
  return { ok: true, mine: null, counts: pub.counts, turnout: pub.turnout,
           published: pub.published };
}

/* Your own nomination, and nobody else's. */
function nomMine(payload) {
  var got = nomActor(payload, false);
  if (typeof got === 'string') return { ok: false, error: got };
  var rec = nomsRead(got.round.id);
  return { ok: true, mine: (rec.members[got.member.id] || {}).recId || null };
}

/* Who nominated what. Organiser only, and member IDS rather than names -- the
   page already knows which id is which member, and no name need ever leave
   this script. */
function nomWho(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };
  var got = nomRoundFor(payload.roundId);
  if (typeof got === 'string') return { ok: false, error: got };
  var rec = nomsRead(got.round.id), byRec = {};
  Object.keys(rec.members).forEach(function (mid) {
    var rid = String((rec.members[mid] || {}).recId || '');
    if (!rid) return;
    (byRec[rid] || (byRec[rid] = [])).push(mid);
  });
  return { ok: true, byRec: byRec, nominated: Object.keys(rec.members),
           organiser: rec.organiser.slice() };
}

/* The organiser's own additions. They do not touch anyone's one-each limit,
   because they are not kept in the members map at all. */
function nomOrganiserEdit(payload, add) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return { ok: false, error: 'ORGANISER_EMAIL is not set' };
  if (normEmail(email) !== normEmail(mine)) return { ok: false, error: 'organiser only' };
  var got = nomRoundFor(payload.roundId);
  if (typeof got === 'string') return { ok: false, error: got };

  var recId = String(payload.recId || '');
  if (add) {
    var elig = (got.state.recs || []).filter(function (x) {
      return String(x.id) === recId && x.status === 'approved';
    })[0];
    if (!elig) return { ok: false, error: 'that book is not up for nomination' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var rec;
  try {
    rec = nomsRead(got.round.id);
    if (add) {
      if (rec.organiser.indexOf(recId) === -1) rec.organiser.push(recId);
    } else {
      var who = String(payload.memberId || '');
      if (who) {
        /* one member's nomination, named from the Admin list */
        if ((rec.members[who] || {}).recId === recId) delete rec.members[who];
      } else {
        rec.organiser = rec.organiser.filter(function (x) { return x !== recId; });
      }
    }
    nomsWrite(got.round.id, rec);
  } finally {
    lock.releaseLock();
  }
  var pub = nomPublish(got.round.id, rec,
    add ? 'The organiser added a nomination' : 'The organiser removed a nomination');
  return { ok: true, counts: pub.counts, turnout: pub.turnout, published: pub.published };
}

/* Settling a closed round: the final counts and a closedAt, so the record
   stops depending on the clock. Called by the timer; safe to call twice. */
function nomSettle(round) {
  var rec = nomsRead(round.id);
  var counts = nomCounts(rec), turnout = Object.keys(rec.members).length;
  return withState('Nominations closed', function (st) {
    var rr = voteOf(st, round.id);
    if (!rr) return { error: 'no such round' };
    rr.nominated = counts;
    rr.turnout = turnout;
    if (!rr.closedAt) rr.closedAt = new Date().toISOString();
    return {};
  });
}

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

/* It is easy to paste this file's description of a property into the value box
   instead of the value itself. A wrong-shaped value is worse than a missing
   one: missing is handled everywhere ("no api key", organiser email skipped),
   whereas "where new submissions should be emailed" reaches MailApp and throws,
   taking the whole reminder run down with it. So check the shape and treat
   anything that clearly isn't the real thing as not set. */
function propEmail(name) {
  var v = prop(name).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
}
function propKey(name, prefix) {
  var v = prop(name).trim();
  if (!v || v.indexOf(' ') !== -1) return '';        // a sentence, not a key
  return (prefix && v.indexOf(prefix) !== 0) ? '' : v;
}

/* ------------------------------------------------------------ web endpoint */

function doPost(e) {
  /* Nothing carried over from whatever ran last in this container. */
  stateForget();
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'bad json' });
  }

  var kind = String(body.kind || '');
  var payload = body.payload || {};

  /* The site's "Test it" button. */
  if (kind === 'ping') return json({ ok: true, pong: true, version: SCRIPT_VERSION });

  /* Signing in, and the things only a signed-in member can do. */
  if (kind === 'login-request') return json(loginRequest(payload));
  if (kind === 'login-verify') return json(loginVerify(payload));
  if (kind === 'session') return json(sessionInfo(payload));
  if (kind === 'logout') return json(logout(payload));
  if (kind === 'notify-get') return json(notifyGet(payload));
  if (kind === 'notify-set') return json(notifySet(payload));
  if (kind === 'profile-set') return json(profileSet(payload));
  if (kind === 'profile-get') return json(profileGet(payload));
  if (kind === 'approve-notify') return json(approveNotify(payload));
  if (kind === 'observer-list') return json(observerList(payload));
  if (kind === 'observer-add') return json(observerCreate(payload));
  if (kind === 'observer-remove') return json(observerRemove(payload));
  if (kind === 'observer-promote') return json(observerPromote(payload));
  if (kind === 'observer-set') return json(observerSet(payload));
  if (kind === 'email-change') return json(emailChangeRequest(payload));
  if (kind === 'email-verify') return json(emailChangeVerify(payload));
  if (kind === 'notes-add') return json(notesAdd(payload));
  if (kind === 'notes-del') return json(notesDel(payload));
  if (kind === 'notes-edit') return json(notesEdit(payload));
  if (kind === 'notes-verdict') return json(notesVerdict(payload));
  if (kind === 'notes-carry') return json(notesCarry(payload));
  if (kind === 'notes-summary') return json(notesSummary(payload));
  if (kind === 'meet-ready') return json(meetReady(payload));
  if (kind === 'vote-cast') return json(voteCast(payload));
  if (kind === 'vote-mine') return json(voteMine(payload));
  if (kind === 'vote-who') return json(voteWho(payload));
  if (kind === 'vote-tally') return json(voteTallyEndpoint(payload));
  if (kind === 'vote-wake') return json(voteWake(payload));
  if (kind === 'nom-cast') return json(nomCast(payload));
  if (kind === 'nom-clear') return json(nomClear(payload));
  if (kind === 'nom-mine') return json(nomMine(payload));
  if (kind === 'nom-who') return json(nomWho(payload));
  if (kind === 'nom-add') return json(nomOrganiserEdit(payload, true));
  if (kind === 'nom-del') return json(nomOrganiserEdit(payload, false));
  if (kind === 'vote-mail') return json(voteMailStatus(payload));
  if (kind === 'vote-hide') return json(voteResultsVisible(payload, true));
  if (kind === 'vote-show') return json(voteResultsVisible(payload, false));
  if (kind === 'vote-results') return json(voteResultsRead(payload));
  if (kind === 'vote-res-preview') return json(voteResultsPreview(payload));
  if (kind === 'vote-res-send') return json(voteResultsGo(payload, false));
  if (kind === 'vote-res-me') return json(voteResultsGo(payload, true));
  if (kind === 'photo-add') return json(photoAdd(payload));
  if (kind === 'photo-list') return json(photoList(payload));
  if (kind === 'photo-delete') return json(photoDelete(payload));
  if (kind === 'photo-edit') return json(photoEdit(payload));

  /* "Write one for me" on the suggestion form. */
  if (kind === 'summarise') return json(summarise(body.payload || {}));

  /* "Fill in the details for me" — page count, age rating, genres, summary. */
  if (kind === 'details') return json(bookDetails(body.payload || {}));

  /* Cover search against Google Images. */
  if (kind === 'images') return json({ ok: true, images: imageSearch(body.payload || {}) });

  /* "Ask AI" beside Reading level. Prose to weigh, not a number to apply. */
  if (kind === 'agenote') return json(ageNote(body.payload || {}));

  if (KINDS.indexOf(kind) === -1) return json({ ok: false, error: 'unknown kind' });

  /* Endorsing and putting a book forward are for approved members now. The
     page hides the buttons, but the page is not the only way to reach this
     URL -- it is in the source of every visit -- so the refusal has to live
     here. */
  var actor = null;
  if (KINDS_SIGNED_IN.indexOf(kind) !== -1) {
    /* Either kind of account: endorsing and putting a book forward are two of
       the things an observer is here to do. The token rides inside the
       payload, the way every other signed-in call on this script sends it. */
    var got = actorFor(payload);
    if (typeof got === 'string') return json({ ok: false, error: got });
    actor = got;
  }

  var item = {
    id: kind + '-' + Utilities.getUuid().slice(0, 12),
    kind: kind,
    at: new Date().toISOString(),
    payload: withheldEmail(clean(body.payload || {}))
  };
  /* Never written down. data/inbox.json is a public file in the repo, and the
     token is the whole of someone's sign-in -- filing it there would publish
     the key along with the thing it unlocked. */
  delete item.payload.token;

  /* Whose submission this is, decided here and not by the sender. A member
     could otherwise endorse or put a book forward under a cousin's name by
     posting it themselves. The organiser is the exception: she enters books
     and endorsements for people who tell her in person, so a name she sends
     is honoured. */
  if (actor) {
    var isOrganiser = normEmail(actor.email) === normEmail(propEmail('ORGANISER_EMAIL'));
    var typed = String(item.payload.name || item.payload.by || '').trim();
    var named = (isOrganiser && typed) ? typed : String(actor.name || '').trim();
    /* A member's id belongs on the record; an observer's does not, because
       state.json is public and nothing there should point at a guest beyond
       the name on what they wrote. The one-per-person check reads obsId
       instead for them. */
    var mine = actor.type === 'member' ? actor.id : '';
    if (kind === 'endorse') {
      item.payload.name = named;
      item.payload.memberId = mine;              /* the part that cannot be typed */
      if (actor.type === 'observer') { item.payload.obs = true; item.payload.obsId = actor.id; }
    } else {
      item.payload.by = named;
      item.payload.byId = mine;
      if (actor.type === 'observer') { item.payload.obs = true; item.payload.obsId = actor.id; }
    }
  }

  if (kind === 'endorse') {
    var dup = endorseAlready(item, actor);
    if (dup) return json({ ok: false, error: dup });
  }

  try {
    /* A suggestion is the one kind that can already exist. Everything else
       just goes on the pile. */
    if (kind === 'suggest') return json(fileSuggestion(item));
    appendToInbox(item);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }

  /* No email per submission — the site's inbox already updates the moment this
     file lands, and one message per endorsement is more than anyone wants.
     weeklyDigest() sends the round-up instead. */
  return json({ ok: true, id: item.id });
}

/* Apps Script needs a doGet for the deployment to be reachable at all. It also
   makes the deployed version readable from a browser: open the /exec URL and
   the version below is the code the web app is actually running. */
function doGet() {
  return json({ ok: true, service: 'cousins-book-club inbox', version: SCRIPT_VERSION,
                emailsPerSubmission: false });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Trim anything oversized before it reaches the repo. */
/* One scalar, cut to size. Anything that is not a number or a boolean becomes
   a string, which is what keeps a payload from carrying anything structured
   into the repo that nothing here has looked at. */
function cleanScalar(v, cap) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v).slice(0, cap);
}
function clean(payload) {
  var out = {};
  Object.keys(payload).slice(0, 24).forEach(function (k) {
    var v = payload[k];
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map(function (x) {
        /* An element that is an object keeps its shape, with every one of its
           own values cut down the same way a top-level one is. It used to be
           String()d like everything else, which is right for genres — a list
           of words — and silently turned ratings, a list of {score, source},
           into a list of "[object Object]". The scores were destroyed here,
           before anything was written down, so the organiser saw an empty box
           and typed them again by hand. Nothing nests: an object inside an
           object inside the array is still flattened to a string. */
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          var row = {};
          Object.keys(x).slice(0, 12).forEach(function (j) { row[j] = cleanScalar(x[j], 200); });
          return row;
        }
        return String(x).slice(0, 200);
      });
    }
    else out[k] = cleanScalar(v, 4000);
  });
  return out;
}

/* ------------------------------------------------- keeping addresses private
   The repo this writes to is public, and some of the people signing up are
   children. So an address never reaches it. The address is kept here, in this
   script's own properties, under an opaque reference; the repo gets the
   reference and a masked hint ("s••••@gmail.com") so the organiser can tell
   one person from another. sendMeetingEmails resolves the reference back to a
   real address at the moment it sends. */

function withheldEmail(payload) {
  var address = String(payload.email || '').trim();
  delete payload.email;
  if (!address || address.indexOf('@') === -1) return payload;

  var ref = 'sub-' + Utilities.getUuid().slice(0, 12);
  PropertiesService.getScriptProperties().setProperty('email:' + ref, address);
  payload.emailRef = ref;
  payload.emailHint = maskEmail(address);
  return payload;
}

function lookupEmail(ref) {
  if (!ref) return '';
  return PropertiesService.getScriptProperties().getProperty('email:' + String(ref)) || '';
}

function maskEmail(address) {
  var at = address.indexOf('@');
  if (at < 1) return '•••';
  return address[0] + '••••' + address.slice(at);
}

/* ------------------------------------------------------------- signing in
   There are no passwords anywhere in this system. A member types their email,
   gets a six-digit code, and types it back; that exchanges for a session token
   the browser keeps. Nothing to leak, nothing to reset, and no password
   database for a club that includes children.

   Codes are stored hashed with a per-install salt, expire in ten minutes, and
   are thrown away after five wrong guesses. Sessions last thirty days. */

var CODE_MINUTES = 10;
var CODE_TRIES = 5;
/* The shortest gap between two codes to one address. The page waits this long
   too, but the page is a suggestion: anything at all can post to the /exec
   URL, and every code is an email out of the script's daily allowance. */
var CODE_GAP_MS = 30000;
var SESSION_DAYS = 30;

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function salt() {
  var store = PropertiesService.getScriptProperties();
  var s = store.getProperty('login_salt');
  if (!s) { s = Utilities.getUuid(); store.setProperty('login_salt', s); }
  return s;
}

function hashCode(code, email) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt() + '|' + normEmail(email) + '|' + String(code));
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/* The whole club's subscriptions in one record: who they are, what they want
   emails about, which member they map to. Addresses live only here. */
function directory() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('directory') || '{}'); }
  catch (err) { return {}; }
}
function saveDirectory(dir) {
  PropertiesService.getScriptProperties().setProperty('directory', JSON.stringify(dir));
}

/* ---------------------------------------------------------- observers ----
   Family and friends who are not in the club. They are never written to
   state.members, because that file is public and they are not part of the
   club's public record -- so they live here, in the script's own storage,
   beside the addresses. One row each: id, name, joined.

   Keyed by normalised email, the same way the directory is, so the lookup
   from a session is one read. */
function observers() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('observers') || '{}'); }
  catch (err) { return {}; }
}
function saveObservers(all) {
  PropertiesService.getScriptProperties().setProperty('observers', JSON.stringify(all));
}
function observerFor(email) {
  var want = normEmail(email);
  if (!want) return null;
  var row = observers()[want];
  return row ? row : null;
}
/* Who is calling, of either kind. One answer the whole script asks for,
   rather than every endpoint deciding again what counts as an account. */
function accountFor(email) {
  var member = memberFor(email);
  if (member) return { type: 'member', id: member.id, name: member.name, member: member, email: email };
  var obs = observerFor(email);
  if (obs) return { type: 'observer', id: obs.id, name: obs.name, observer: obs, email: email };
  return null;
}
/* The caller behind a token, or a string naming what is wrong with them. Every
   endpoint that either kind may use goes through this; the ones only members
   may use go through memberOnly below. */
function actorFor(payload) {
  var email = whoIs(payload && payload.token);
  if (!email) return 'signed out';
  var who = accountFor(email);
  if (!who) return pendingFor(email) ? 'pending' : 'not a member yet';
  return who;
}
/* The same, refusing an observer. The wording is what the page shows. */
function memberOnly(payload) {
  var who = actorFor(payload);
  if (typeof who === 'string') return who;
  return who.type === 'member' ? who : 'members only';
}
function observerAdd(email, name) {
  var key = normEmail(email);
  if (!key) return null;
  var all = observers();
  if (all[key]) return all[key];
  all[key] = { id: 'ob-' + Utilities.getUuid().slice(0, 12),
               name: String(name || '').slice(0, 60),
               joined: new Date().toISOString().slice(0, 10) };
  saveObservers(all);
  return all[key];
}

/* The organiser, or a string saying why not. The same three lines were
   written out in eight endpoints before this. */
function organiserOnly(payload) {
  var email = whoIs(payload && payload.token);
  if (!email) return 'signed out';
  var mine = propEmail('ORGANISER_EMAIL');
  if (!mine) return 'ORGANISER_EMAIL is not set';
  if (normEmail(email) !== normEmail(mine)) return 'organiser only';
  return email;
}

/* ---- the organiser's side of the observer list ---- */
function observerList(payload) {
  var gate = organiserOnly(payload);
  if (typeof gate === 'string' && gate.indexOf('@') === -1) return { ok: false, error: gate };
  var all = observers(), out = [];
  Object.keys(all).forEach(function (key) {
    var o = all[key];
    out.push({ id: o.id, name: o.name, joined: o.joined, emailHint: maskEmail(key) });
  });
  out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { ok: true, observers: out };
}
/* Approving a join request as an observer. The address is already withheld
   behind a ref, so this takes the ref rather than the address. */
function observerCreate(payload) {
  var gate = organiserOnly(payload);
  if (typeof gate === 'string' && gate.indexOf('@') === -1) return { ok: false, error: gate };
  var address = lookupEmail(String(payload.ref || ''));
  if (!address) return { ok: false, error: 'unknown ref' };
  if (memberFor(address)) return { ok: false, error: 'already a member' };
  var row = observerAdd(address, payload.name);
  if (!row) return { ok: false, error: 'bad address' };
  return { ok: true, observer: { id: row.id, name: row.name, joined: row.joined,
                                 emailHint: maskEmail(address) } };
}
/* Removing one. Their notes and the books they put forward stay exactly as
   they are -- those carry a name, not a link to this row, so nothing breaks
   and nothing is rewritten. What goes is the account: they can no longer
   sign in, and their address is forgotten with it. */
function observerRemove(payload) {
  var gate = organiserOnly(payload);
  if (typeof gate === 'string' && gate.indexOf('@') === -1) return { ok: false, error: gate };
  var id = String(payload.observerId || '');
  var all = observers(), hit = '';
  Object.keys(all).forEach(function (key) { if (all[key].id === id) hit = key; });
  if (!hit) return { ok: false, error: 'no such observer' };
  delete all[hit];
  saveObservers(all);
  /* The address goes too, and the directory row with it, or signing in again
     would find a stranger with meeting-email preferences already set. */
  var dir = directory();
  var ref = (dir[hit] || {}).ref;
  if (ref) PropertiesService.getScriptProperties().deleteProperty('email:' + ref);
  delete dir[hit];
  saveDirectory(dir);
  return { ok: true };
}
/* Making one a member. The row here goes; the organiser's own save puts them
   on the public members list, because that file is hers to write, not this
   script's. */
function observerPromote(payload) {
  var gate = organiserOnly(payload);
  if (typeof gate === 'string' && gate.indexOf('@') === -1) return { ok: false, error: gate };
  var id = String(payload.observerId || '');
  var all = observers(), hit = '';
  Object.keys(all).forEach(function (key) { if (all[key].id === id) hit = key; });
  if (!hit) return { ok: false, error: 'no such observer' };
  var row = all[hit];
  delete all[hit];
  saveObservers(all);
  /* The directory entry stays: it holds their reminder preferences and the
     ref the members list will point at. */
  var dir = directory();
  if (!dir[hit]) dir[hit] = { ref: '', name: row.name, books: [], memberId: '' };
  if (!dir[hit].ref) {
    var ref2 = 'sub-' + Utilities.getUuid().slice(0, 12);
    PropertiesService.getScriptProperties().setProperty('email:' + ref2, hit);
    dir[hit].ref = ref2;
  }
  dir[hit].name = row.name;
  saveDirectory(dir);
  return { ok: true, name: row.name, emailRef: dir[hit].ref, emailHint: maskEmail(hit) };
}

/* An observer's own details. Their name, and nothing else: the address has
   its own pair of calls below, because changing it has to be proved, and the
   reminder preferences already have notifySet. */
function observerSet(payload) {
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  if (who.type !== 'observer') return { ok: false, error: 'observers only' };
  var name = String(payload.name || '').trim().slice(0, 60);
  if (!name) return { ok: false, error: 'no name' };
  var all = observers(), key = normEmail(who.email);
  if (!all[key]) return { ok: false, error: 'no such observer' };
  all[key].name = name;
  saveObservers(all);
  var dir = directory();
  if (dir[key]) { dir[key].name = name; saveDirectory(dir); }
  return { ok: true, name: name };
}

/* ---- changing the address on an account ----
   The code goes to the NEW address, because that is the thing being proved.
   Until it is entered the old address still signs in and still receives
   anything the club sends, so a typo cannot lock anyone out. */
function emailChangeRequest(payload) {
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var next = normEmail(payload.email);
  if (!next || next.indexOf('@') < 1) return { ok: false, error: 'bad email' };
  if (next === normEmail(who.email)) return { ok: false, error: 'same email' };
  if (accountFor(next)) return { ok: false, error: 'taken' };

  var store = PropertiesService.getScriptProperties();
  /* The same half-minute between sends that signing in uses, keyed on the
     address being written to. */
  var lastSent = Number(store.getProperty('sent:' + next) || 0);
  var since = Date.now() - lastSent;
  if (lastSent && since >= 0 && since < CODE_GAP_MS) {
    return { ok: false, error: 'too soon', wait: Math.ceil((CODE_GAP_MS - since) / 1000) };
  }
  var code = String(Math.floor(100000 + Math.random() * 900000));
  store.setProperty('chg:' + normEmail(who.email), JSON.stringify({
    to: next, hash: hashCode(code, next), tries: 0,
    expires: Date.now() + CODE_MINUTES * 60000
  }));
  store.setProperty('sent:' + next, String(Date.now()));
  MailApp.sendEmail({
    to: next,
    subject: 'Your book club confirmation code: ' + code,
    body: 'Your code is ' + code + '\n\n' +
          'Enter it on the site to start using this address for the book club.\n' +
          'It works for the next ' + CODE_MINUTES + ' minutes.\n\n' +
          "If you didn't ask for this, you can ignore it \u2014 nothing changes until the code is entered."
  });
  return { ok: true, hint: maskEmail(next) };
}
function emailChangeVerify(payload) {
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var store = PropertiesService.getScriptProperties();
  var from = normEmail(who.email), key = 'chg:' + from;
  var rec;
  try { rec = JSON.parse(store.getProperty(key) || 'null'); } catch (err) { rec = null; }
  if (!rec) return { ok: false, error: 'no code' };
  if (Date.now() > rec.expires) { store.deleteProperty(key); return { ok: false, error: 'expired' }; }
  if (hashCode(String(payload.code || '').trim(), rec.to) !== rec.hash) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= CODE_TRIES) store.deleteProperty(key);
    else store.setProperty(key, JSON.stringify(rec));
    return { ok: false, error: 'wrong', left: Math.max(0, CODE_TRIES - rec.tries) };
  }
  store.deleteProperty(key);
  var next = rec.to;
  if (accountFor(next)) return { ok: false, error: 'taken' };

  /* The ref is kept and repointed rather than replaced. A new one would
     leave the old email: property behind with the old address still in it,
     and anything already pointing at the ref -- a member row, a waiting join
     request -- pointing at nothing. */
  var dir = directory();
  var entry = dir[from] || { ref: '', name: who.name, books: [], memberId: '' };
  if (entry.ref) store.setProperty('email:' + entry.ref, next);
  else {
    entry.ref = 'sub-' + Utilities.getUuid().slice(0, 12);
    store.setProperty('email:' + entry.ref, next);
  }
  delete dir[from];
  dir[next] = entry;
  saveDirectory(dir);

  if (who.type === 'observer') {
    var all = observers();
    if (all[from]) { all[next] = all[from]; delete all[from]; saveObservers(all); }
  }

  /* Sessions are keyed by the address they were made with, so the one in use
     has to move with it or the next call looks signed out. */
  var sessKey = 'sess:' + String(payload.token || '');
  var sess;
  try { sess = JSON.parse(store.getProperty(sessKey) || 'null'); } catch (err) { sess = null; }
  if (sess) { sess.email = next; store.setProperty(sessKey, JSON.stringify(sess)); }

  return { ok: true, email: next, emailHint: maskEmail(next) };
}

function loginRequest(payload) {
  var email = normEmail(payload.email);
  if (!email || email.indexOf('@') < 1) return { ok: false, error: 'bad email' };

  /* Three answers, and only one of them sends anything. Someone waiting on the
     organiser is told so rather than left wondering; someone we have never
     heard of is pointed at signing up. Neither gets a code, so neither gets a
     session. */
  if (!accountFor(email)) {
    return { ok: false, error: pendingFor(email) ? 'pending' : 'not a member' };
  }

  /* One code per address per half-minute.
     Its own key rather than a field on the code record: that record is deleted
     on a successful sign-in and again after five wrong guesses, so a throttle
     kept inside it could be cleared by burning guesses.
     After the membership check and never before. loginRequest answers
     identically for everyone it will not send to, so it cannot be used to find
     out who is in the club; a "too soon" reaching somebody ahead of that check
     would tell them the address is a member's.
     A stamp from the future is the clock having moved, not a wait owed — the
     same reading the page takes of its own. */
  var store = PropertiesService.getScriptProperties();
  var lastSent = Number(store.getProperty('sent:' + email) || 0);
  var since = Date.now() - lastSent;
  if (lastSent && since >= 0 && since < CODE_GAP_MS) {
    return { ok: false, error: 'too soon',
             wait: Math.ceil((CODE_GAP_MS - since) / 1000) };
  }

  var code = String(Math.floor(100000 + Math.random() * 900000));
  store.setProperty('code:' + email, JSON.stringify({
    hash: hashCode(code, email),
    expires: Date.now() + CODE_MINUTES * 60000,
    tries: 0
  }));
  /* Stamped before the send rather than after it. What is being rationed is
     the allowance, and a send that throws may still have gone out; thirty
     seconds is a small price against letting a failing send be hammered. */
  store.setProperty('sent:' + email, String(Date.now()));

  MailApp.sendEmail({
    to: email,
    subject: 'Your book club sign-in code: ' + code,
    body: 'Your code is ' + code + '\n\n' +
          'It works for the next ' + CODE_MINUTES + ' minutes.\n\n' +
          "If you didn't ask to sign in, you can ignore this — nobody can get in without the code."
  });

  /* Always the same answer, so nobody can use this to discover who's a member. */
  return { ok: true };
}

function loginVerify(payload) {
  var email = normEmail(payload.email);
  var given = String(payload.code || '').trim();
  var store = PropertiesService.getScriptProperties();
  var key = 'code:' + email;

  var rec;
  try { rec = JSON.parse(store.getProperty(key) || 'null'); } catch (err) { rec = null; }
  if (!rec) return { ok: false, error: 'no code' };
  if (Date.now() > rec.expires) { store.deleteProperty(key); return { ok: false, error: 'expired' }; }

  if (hashCode(given, email) !== rec.hash) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= CODE_TRIES) store.deleteProperty(key);
    else store.setProperty(key, JSON.stringify(rec));
    return { ok: false, error: 'wrong', left: Math.max(0, CODE_TRIES - rec.tries) };
  }

  store.deleteProperty(key);

  /* Checked again here, not only when the code was asked for: a request can be
     withdrawn in the ten minutes a code is good for. */
  if (!accountFor(email)) {
    return { ok: false, error: pendingFor(email) ? 'pending' : 'not a member' };
  }

  var token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  store.setProperty('sess:' + token, JSON.stringify({
    email: email,
    expires: Date.now() + SESSION_DAYS * 86400000
  }));

  /* first sign-in creates their directory entry */
  var dir = directory();
  if (!dir[email]) {
    var ref = 'sub-' + Utilities.getUuid().slice(0, 12);
    store.setProperty('email:' + ref, email);
    dir[email] = { ref: ref, name: '', books: [], memberId: '' };
    saveDirectory(dir);
  }

  return { ok: true, token: token, profile: profileFor(email) };
}

/* ------------------------------------------------------- who counts as a member
   One function, deliberately. Membership used to be decided in three places
   with slightly different rules; when the way people join changes again, this
   is the only thing that has to change with it.

   A member row carries notifyRef, an opaque handle whose real address lives in
   this script's properties. So the question "is this address a member?" is
   answered by resolving each row's handle back and comparing. A club this size
   makes that a handful of property reads. */
function memberFor(email) {
  var want = normEmail(email);
  if (!want) return null;
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return null; }
  var rows = state.members || [];
  for (var i = 0; i < rows.length; i++) {
    var ref = rows[i] && rows[i].notifyRef;
    if (ref && normEmail(lookupEmail(ref)) === want) return rows[i];
  }
  return null;
}

/* Someone who asked to join and is still waiting on the organiser. Their
   request sits unhandled in the inbox with the address behind a handle, the
   same as a member row. */
function pendingFor(email) {
  var want = normEmail(email);
  if (!want) return false;
  var items;
  try { items = JSON.parse(ghGetFile(INBOX_PATH).content || '{"items":[]}').items || []; }
  catch (err) { return false; }
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { state = {}; }
  /* the site marks a submission handled by listing its id here */
  var done = state.inbox || [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || it.kind !== 'join') continue;
    if (done.indexOf(it.id) !== -1) continue;
    var ref = (it.payload || {}).emailRef;
    if (ref && normEmail(lookupEmail(ref)) === want) return true;
  }
  return false;
}

/* Every privileged call goes through here. Returns the email or ''. */
function whoIs(token) {
  if (!token) return '';
  var store = PropertiesService.getScriptProperties();
  var raw = store.getProperty('sess:' + String(token));
  if (!raw) return '';
  var rec;
  try { rec = JSON.parse(raw); } catch (err) { return ''; }
  if (!rec || Date.now() > rec.expires) { store.deleteProperty('sess:' + String(token)); return ''; }
  return rec.email;
}

function profileFor(email) {
  var entry = directory()[email] || { ref: '', name: '', books: [], memberId: '' };
  var member = memberFor(email);
  return {
    email: email,
    emailHint: maskEmail(email),
    ref: entry.ref,
    name: entry.name || (member ? member.name : '') || ((observerFor(email) || {}).name || ''),
    books: entry.books || [],
    memberId: member ? member.id : (entry.memberId || ''),
    hue: member ? (member.hue || '') : '',
    isMember: !!member,
    /* 'member', 'observer', or '' for somebody signed in with neither -- which
       should not happen, since sign-in refuses them, but the page reads this
       to decide what to show and guessing from an absent flag is how the
       Suggest form ended up hidden from members. */
    type: member ? 'member' : (observerFor(email) ? 'observer' : ''),
    observerId: member ? '' : ((observerFor(email) || {}).id || ''),
    /* The page locks the endorse and submit name boxes for everyone but the
       organiser. It is told the same fact the submission gate decides on, so
       the two cannot drift: a box the page leaves editable is one the script
       will honour. */
    isOrganiser: !!email && normEmail(email) === normEmail(propEmail('ORGANISER_EMAIL'))
  };
}

function sessionInfo(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  return { ok: true, profile: profileFor(email) };
}

function logout(payload) {
  if (payload.token) PropertiesService.getScriptProperties().deleteProperty('sess:' + String(payload.token));
  return { ok: true };
}

function notifyGet(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  return { ok: true, books: (directory()[email] || {}).books || [] };
}

function notifySet(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };

  var books = (Array.isArray(payload.books) ? payload.books : [])
    .map(function (b) { return String(b).slice(0, 60); }).slice(0, 60);

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var dir = directory();
    var entry = dir[email] || { ref: 'sub-' + Utilities.getUuid().slice(0, 12), name: '', books: [], memberId: '' };
    if (!PropertiesService.getScriptProperties().getProperty('email:' + entry.ref)) {
      PropertiesService.getScriptProperties().setProperty('email:' + entry.ref, email);
    }
    entry.books = books;
    if (payload.name) entry.name = String(payload.name).slice(0, 60);
    dir[email] = entry;
    saveDirectory(dir);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, books: books };
}

/* ---------------------------------------------------------- meeting notes
   Predictions and discussion points, for any signed-in member, on any meeting
   an organiser hasn't marked done. Both are lists, so unlike a profile change
   this never touches more than one meeting's one field: read, add or remove
   one item, write back. Two members acting on the same meeting at once are
   serialised by the lock the same way profileSet's own field is, so neither
   loses the other's.

   The "your name" box stays free text — one member often enters several
   names on another's behalf, so it is not tied to who is signed in, and
   never has been. What IS tied to the session is who gets to act at all, and
   whose name lands in the deletion log below. */
function noteField(f) { return f === 'pred' ? 'predictions' : f === 'disc' ? 'points' : ''; }
var VERDICTS = { '': 1, 'yes': 1, 'part': 1, 'no': 1 };

/* The locked read-modify-write the note endpoints all need, in one place.
   Straight to GitHub rather than through stateRead: this needs the sha that
   goes with the bytes it is about to change, and on a second attempt it needs
   whatever landed in between. `change` is handed the parsed state and returns
   either { error: '...' } to refuse, or { reply: {...} } to save and answer
   with. Refusing costs nothing — the file is only written when it does not. */
function withState(message, change) {
  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); }
      catch (err) { return { ok: false, error: 'unreadable state' }; }

      var out = change(state) || {};
      if (out.error) return { ok: false, error: out.error };
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha, message);
        var reply = { ok: true };
        var got = out.reply || {};
        for (var k in got) if (got.hasOwnProperty(k)) reply[k] = got[k];
        return reply;
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
}

/* Where a prediction gets judged: the next meeting for the same book, by date.
   Predictions are about the book, so they belong to that book's own run of
   meetings — the last meeting of a book has no next one, and nothing carries
   past the end of it. Worked out here rather than taken from the browser, so
   the window a verdict may be set in is this script's answer, not a claim. */
function nextMeetingOf(state, meeting) {
  var later = (state.meetings || []).filter(function (m) {
    return m && m.bookId === meeting.bookId && m.id !== meeting.id &&
      String(m.date || '') > String(meeting.date || '');
  });
  later.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
  return later[0] || null;
}

/* A member saying they have finished the section for a meeting. The only
   thing it can change is whether their own id is in that meeting's list —
   the id comes from the session, not from the browser, so nobody can mark
   anyone else. Sent without `ready` it toggles; sent with one it sets. */
function meetReady(payload) {
  var who = memberOnly(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member;
  if (!member.id) return { ok: false, error: 'not a member yet' };
  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); }
      catch (err) { return { ok: false, error: 'unreadable state' }; }

      var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
      if (!meeting) return { ok: false, error: 'no such meeting' };
      if (!Array.isArray(meeting.ready)) meeting.ready = [];

      var at = meeting.ready.indexOf(member.id);
      var want = (payload.ready === undefined || payload.ready === null) ? (at === -1) : !!payload.ready;
      if (want && at === -1) meeting.ready.push(member.id);
      if (!want && at !== -1) meeting.ready.splice(at, 1);
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha,
          want ? 'Member is ready for a meeting' : 'Member is no longer ready');
        return { ok: true, ready: meeting.ready.slice(), me: want };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
}

function notesAdd(payload) {
  /* Either kind of account. An observer reads the club's meetings and is
     welcome to say what they think will happen in the book. */
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member || null;

  var key = noteField(String(payload.field || ''));
  if (!key) return { ok: false, error: 'bad field' };
  var text = String(payload.text || '').trim().slice(0, 400);
  if (!text) return { ok: false, error: 'no text' };
  /* The browser sends member ids now, not a typed name. Which ids are real is
     decided here against the members list, not there — the same rule as
     everywhere else in this script. */
  var wanted = Array.isArray(payload.byIds) ? payload.byIds.slice(0, 12) : [];

  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      /* Straight to GitHub, not through stateRead: this needs the sha that
         goes with the bytes it is about to change, and on a second attempt it
         needs whatever landed in between. ghPutFile empties the memo, so a
         read later in this execution sees the new file rather than the old. */
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); } catch (err) { return { ok: false, error: 'unreadable state' }; }

      var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
      if (!meeting) return { ok: false, error: 'no such meeting' };
      if (meeting.done) return { ok: false, error: 'meeting closed' };
      if (!Array.isArray(meeting[key])) meeting[key] = [];

      var known = {};
      (state.members || []).forEach(function (mem) { if (mem && mem.id) known[mem.id] = true; });
      var byIds = [];
      wanted.forEach(function (id) {
        id = String(id || '');
        if (known[id] && byIds.indexOf(id) === -1) byIds.push(id);
      });

      var item = { id: payload.field + '-' + Utilities.getUuid().slice(0, 12), text: text, by: '', byIds: byIds };
      /* An observer is not on the members list, so there is no id to carry and
         no list of names to choose from: the entry is theirs and says so. The
         opaque obsId is what "their own" is decided on later -- a name match
         would hand one observer another's entry the day two of them share a
         first name. */
      if (who.type === 'observer') {
        item.byIds = [];
        item.by = who.name;
        item.obs = true;
        item.obsId = who.id;
      }
      meeting[key].push(item);
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha, 'Member added a note');
        return { ok: true, item: item };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
}

/* Changing what a note says, rather than deleting it and writing it again.
   Same rules as adding one: any signed-in member, any meeting not yet closed,
   whoever first wrote it. The unrestricted-delete trade was made already, and
   an edit is the smaller half of it — a delete-and-retype was always allowed
   and reached the same place with the authorship thrown away. */
function notesEdit(payload) {
  /* Either kind of account. An observer reads the club's meetings and is
     welcome to say what they think will happen in the book. */
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member || null;

  var key = noteField(String(payload.field || ''));
  if (!key) return { ok: false, error: 'bad field' };
  var itemId = String(payload.itemId || '');
  if (!itemId) return { ok: false, error: 'no item' };
  var text = String(payload.text || '').trim().slice(0, 400);
  if (!text) return { ok: false, error: 'no text' };

  return withState('Member edited a note', function (state) {
    var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
    if (!meeting) return { error: 'no such meeting' };
    if (meeting.done) return { error: 'meeting closed' };
    var item = (Array.isArray(meeting[key]) ? meeting[key] : [])
      .filter(function (x) { return x.id === itemId; })[0];
    if (!item) return { error: 'not found' };
    /* Members may edit each other's, which was a deliberate trade made long
       before observers existed. An observer may edit only what they wrote --
       they are a guest in the club's notes, not a keeper of them. */
    if (who.type === 'observer' && String(item.obsId || '') !== String(who.id)) {
      return { error: 'not yours' };
    }
    item.text = text;
    return { reply: { item: item } };
  });
}

/* The write-up of the meeting. It had no endpoint at all: the box was shown
   to the organiser alone and saved straight to the repo with her token, so no
   member could touch it and neither could an observer. Both can now, on a
   meeting not yet marked done -- the same gate the predictions and the
   discussion points sit behind, and the same read-modify-write.

   The organiser's own path is untouched. She writes state.json directly, so
   she can still write up a meeting after it is closed, which is usually when
   a write-up actually gets done. */
function notesSummary(payload) {
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var text = String(payload.text === undefined || payload.text === null ? '' : payload.text)
    .trim().slice(0, 6000);

  return withState('Summary updated from the site', function (state) {
    var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
    if (!meeting) return { error: 'no such meeting' };
    if (meeting.done) return { error: 'meeting closed' };
    meeting.summary = text;
    return { reply: { summary: text } };
  });
}

/* Marking how a prediction turned out. Its own meeting being closed is not
   what governs: a prediction is judged at the NEXT meeting, by which time its
   own is long marked done, so keying off that would lock every verdict before
   anyone could set one. The window runs until the meeting where it is
   reviewed is itself closed. */
function notesVerdict(payload) {
  var who = memberOnly(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member;

  var itemId = String(payload.itemId || '');
  if (!itemId) return { ok: false, error: 'no item' };
  var verdict = String(payload.verdict === undefined || payload.verdict === null ? '' : payload.verdict);
  if (!VERDICTS[verdict]) return { ok: false, error: 'bad verdict' };

  return withState('Member marked a prediction', function (state) {
    var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
    if (!meeting) return { error: 'no such meeting' };
    var review = nextMeetingOf(state, meeting);
    if (review && review.done) return { error: 'review closed' };
    var item = (Array.isArray(meeting.predictions) ? meeting.predictions : [])
      .filter(function (x) { return x.id === itemId; })[0];
    if (!item) return { error: 'not found' };
    if (verdict) item.verdict = verdict; else delete item.verdict;
    return { reply: { item: item } };
  });
}

/* Still might happen: the prediction is copied onto the next meeting as a new
   open entry of its own, keeping whose it was. A copy, not a pointer — from
   there it is that meeting's prediction and is judged with the rest of them.
   The original keeps its place in the meeting it was made at, flagged as
   carried so it cannot be sent forward twice. */
function notesCarry(payload) {
  var who = memberOnly(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member;

  var itemId = String(payload.itemId || '');
  if (!itemId) return { ok: false, error: 'no item' };

  return withState('Member carried a prediction over', function (state) {
    var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
    if (!meeting) return { error: 'no such meeting' };
    var target = nextMeetingOf(state, meeting);
    if (!target) return { error: 'no next meeting' };
    if (target.done) return { error: 'review closed' };
    var item = (Array.isArray(meeting.predictions) ? meeting.predictions : [])
      .filter(function (x) { return x.id === itemId; })[0];
    if (!item) return { error: 'not found' };
    if (item.carried) return { error: 'already carried' };
    if (!Array.isArray(target.predictions)) target.predictions = [];
    var copy = { id: 'pred-' + Utilities.getUuid().slice(0, 12), text: item.text, by: item.by || '',
                 byIds: Array.isArray(item.byIds) ? item.byIds.slice() : [] };
    target.predictions.push(copy);
    item.carried = true;
    return { reply: { item: copy, into: target.id, source: item } };
  });
}

/* Anyone signed in may remove anyone's prediction or discussion point — that
   was the trade the free-text name above already made, and closing it back
   off per-author would only fight that decision in a second place. What
   keeps it safe is the record: every removal is appended to the inbox file
   as its own kind, the same mechanism a join request or a suggestion already
   arrives through, so it rides the existing weekly round-up rather than
   needing a channel of its own. It carries what was deleted, who deleted it
   — the signed-in member, not the free-text name on the item — which
   meeting, and when, which is what putting it back by hand needs. */
function notesDel(payload) {
  /* Either kind of account. An observer reads the club's meetings and is
     welcome to say what they think will happen in the book. */
  var who = actorFor(payload);
  if (typeof who === 'string') return { ok: false, error: who };
  var email = who.email, member = who.member || null;

  var key = noteField(String(payload.field || ''));
  if (!key) return { ok: false, error: 'bad field' };
  var itemId = String(payload.itemId || '');
  if (!itemId) return { ok: false, error: 'no item' };

  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      /* Straight to GitHub, not through stateRead: this needs the sha that
         goes with the bytes it is about to change, and on a second attempt it
         needs whatever landed in between. ghPutFile empties the memo, so a
         read later in this execution sees the new file rather than the old. */
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); } catch (err) { return { ok: false, error: 'unreadable state' }; }

      var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
      if (!meeting) return { ok: false, error: 'no such meeting' };
      if (meeting.done) return { ok: false, error: 'meeting closed' };
      var list = Array.isArray(meeting[key]) ? meeting[key] : [];
      var removed = list.filter(function (x) { return x.id === itemId; })[0];
      if (!removed) return { ok: false, error: 'not found' };
      /* Same rule as editing: members keep the unrestricted delete they
         already had, an observer may remove only their own. */
      if (who.type === 'observer' && String(removed.obsId || '') !== String(who.id)) {
        return { ok: false, error: 'not yours' };
      }
      meeting[key] = list.filter(function (x) { return x.id !== itemId; });
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha, 'Member removed a note');
        try {
          appendToInbox({
            id: 'notedelete-' + Utilities.getUuid().slice(0, 12),
            kind: 'notedelete',
            at: new Date().toISOString(),
            handled: true,
            payload: {
              meetingId: payload.meetingId,
              field: payload.field,
              text: removed.text,
              by: removed.by,
              deletedBy: who.name || email,
              /* The log says which kind of account did it, so a deletion by a
                 guest reads differently from one by a member. */
              deletedByType: who.type
            }
          });
        } catch (logErr) { /* the deletion itself already succeeded; a failed log entry should not undo it */ }
        return { ok: true };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
}

/* A member's own row, read straight from the repo through the API.
   The site normally learns the club's state from data/state.json as GitHub
   Pages serves it, and Pages has to rebuild before a write shows up there —
   a minute or so during which that file is genuinely out of date. Editing a
   profile from a page that loaded inside that window meant filling the form
   with stale values and then writing them back, so a field saved a moment
   earlier was undone by the next save. This answer never goes through Pages,
   so it is current the instant the write lands. */
function profileGet(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var entry = directory()[email];
  if (!entry) return { ok: false, error: 'no profile' };

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }

  var member = (state.members || []).filter(function (m) {
    return (entry.memberId && m.id === entry.memberId) || (entry.ref && m.notifyRef === entry.ref);
  })[0];
  if (!member) return { ok: false, error: 'not a member yet' };

  return { ok: true, rev: Number(state.rev || 0),
           name: member.name, hue: member.hue || '',
           goodreads: member.goodreads || '', fable: member.fable || '',
           genres: member.genres || [], top5: member.top5 || [],
           notifyRecs: !!member.notifyRecs };
}

function profileSet(payload) {
  /* Every field this writes -- badge colour, Goodreads, Fable, top genres,
     the top five -- belongs to a member's public profile, and an observer
     has no public profile to write to. Their own name, address and reminders
     are changed through observerSet and the email-change pair below. */
  var gate = memberOnly(payload);
  if (typeof gate === 'string') return { ok: false, error: gate };
  var email = gate.email;

  var entry = directory()[email];
  if (!entry) return { ok: false, error: 'no profile' };

  var wantName = payload.name ? String(payload.name).slice(0, 60) : '';
  var wantHue = String(payload.hue || '').slice(0, 20);
  /* one of the five house hues, or a hex the member picked themselves */
  var allowed = ['flare', 'zest', 'surf', 'sky', 'grape', ''];
  if (allowed.indexOf(wantHue) === -1 && !/^#[0-9a-fA-F]{6}$/.test(wantHue)) {
    return { ok: false, error: 'bad colour' };
  }
  if (wantHue.charAt(0) === '#') wantHue = wantHue.toLowerCase();

  /* The rest of what a member keeps about themselves. Each is only touched
     when the browser actually sends it, so a page that knows about fewer
     fields than this script cannot wipe the ones it never showed. */
  var sets = {};
  if (payload.goodreads !== undefined) sets.goodreads = safeProfileUrl(payload.goodreads);
  if (payload.fable !== undefined) sets.fable = safeProfileUrl(payload.fable);
  if (payload.genres !== undefined) {
    sets.genres = (Array.isArray(payload.genres) ? payload.genres : [])
      .map(function (g) { return String(g || '').trim().slice(0, 40); })
      .filter(function (g) { return g; }).slice(0, 3);
  }
  if (payload.top5 !== undefined) {
    if (!Array.isArray(payload.top5)) return { ok: false, error: 'bad five' };
    sets.top5 = payload.top5.slice(0, 5).map(cleanTop5).filter(function (b) { return b; });
  }
  if (payload.notifyRecs !== undefined) sets.notifyRecs = !!payload.notifyRecs;

  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      /* Straight to GitHub, not through stateRead: this needs the sha that
         goes with the bytes it is about to change, and on a second attempt it
         needs whatever landed in between. ghPutFile empties the memo, so a
         read later in this execution sees the new file rather than the old. */
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); } catch (err) { return { ok: false, error: 'unreadable state' }; }

      var member = (state.members || []).filter(function (m) {
        return (entry.memberId && m.id === entry.memberId) || (entry.ref && m.notifyRef === entry.ref);
      })[0];
      if (!member) return { ok: false, error: 'not a member yet' };

      if (wantName) member.name = wantName;
      member.hue = wantHue;
      Object.keys(sets).forEach(function (k) { member[k] = sets[k]; });
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha, 'Member updated their profile');
        if (wantName) {
          var dir = directory();
          if (dir[email]) { dir[email].name = wantName; dir[email].memberId = member.id; saveDirectory(dir); }
        }
        return { ok: true, name: member.name, hue: member.hue,
                 goodreads: member.goodreads || '', fable: member.fable || '',
                 genres: member.genres || [], top5: member.top5 || [],
                 notifyRecs: !!member.notifyRecs };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
}

/* A profile link has to be a plain web address and nothing cleverer — this is
   written into a public page, so javascript: and data: never get through.
   A web address typed without its https:// is still a web address, though,
   and dropping it silently is worse than useless: the save then reports
   success having stored nothing. So the scheme is added when it is missing
   and the address is otherwise a plain domain. Anything that is not one is
   still refused. */
function safeProfileUrl(v) {
  var url = String(v || '').trim().slice(0, 300);
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[\w.-]+\.[a-z]{2,}(?:[\/?#]|$)/i.test(url)) return 'https://' + url;
  return '';
}

/* One of a member's five. Only the fields the page draws a cover from, each
   trimmed, so a book on a profile can never carry more than it should. */
function cleanTop5(b) {
  if (!b || typeof b !== 'object') return null;
  var title = String(b.title || '').trim().slice(0, 200);
  if (!title) return null;
  var out = {
    id: String(b.id || '').slice(0, 40),
    title: title,
    author: String(b.author || '').trim().slice(0, 120),
    cover: safeProfileUrl(b.cover),
    pages: Number(b.pages) > 0 ? Math.min(20000, Math.round(Number(b.pages))) : '',
    genres: (Array.isArray(b.genres) ? b.genres : [])
      .map(function (g) { return String(g || '').trim().slice(0, 40); })
      .filter(function (g) { return g; }).slice(0, 8),
    /* A narrower shelf than a genre. Named here for the same reason as the
       tropes below it: a field this whitelist does not mention is stripped on
       the way through without a word, which is how the summary, the score and
       the review each went missing before anyone noticed. */
    subgenres: (Array.isArray(b.subgenres) ? b.subgenres : [])
      .map(function (g) { return String(g || '').trim().slice(0, 40); })
      .filter(function (g) { return g; }).slice(0, 12),
    /* What the book does, as against what shelf it sits on. Named here or it
       is stripped on the way through, which is how the summary, the score and
       the review each went missing before anyone noticed. */
    tropes: (Array.isArray(b.tropes) ? b.tropes : [])
      .map(function (t) { return String(t || '').trim().slice(0, 40); })
      .filter(function (t) { return t; }).slice(0, 12),
    level: String(b.level || '').trim().slice(0, 40),
    /* What they wrote about it. This was missing from the list, so a summary
       could be typed into the form, saved, and stripped here without anyone
       being told — the one field most people open that screen to fill in. */
    blurb: String(b.blurb || '').trim().slice(0, 4000),
    /* The score and where it came from. Same omission as the summary: the
       page can send it all it likes if this list does not name it. */
    ratings: (Array.isArray(b.ratings) ? b.ratings : []).slice(0, 12).map(function (r) {
      var n = Number(r && r.score);
      if (isNaN(n)) n = 0;
      return { score: Math.max(0, Math.min(5, Math.round(n * 100) / 100)),
               source: String((r && r.source) || '').trim().slice(0, 40) };
    }).filter(function (r) { return r.score > 0; }),
    /* The member's own verdict on their own shelf: a score out of five and
       what they thought. Separate from `ratings`, which are the numbers the
       rating sites quote. */
    myScore: (function () {
      var n = Number(b.myScore);
      if (isNaN(n) || n <= 0) return 0;
      return Math.max(0, Math.min(5, Math.round(n * 100) / 100));
    })(),
    myReview: String(b.myReview || '').trim().slice(0, 4000)
  };
  if (Number(b.ageMin) > 0) out.ageMin = Math.round(Number(b.ageMin));
  if (Number(b.ageMax) > 0) out.ageMax = Math.round(Number(b.ageMax));
  return out;
}

/* ------------------------------------------------- telling someone they're in
   Accepting a join request happens in the organiser's browser, which writes
   state.json with its own token and never speaks to this script. So the site
   calls here afterwards to have the email sent, since the address only exists
   on this side.

   Two guards, because nothing about this call proves who is making it. The
   handle must belong to a row that is actually on the members list now — so
   the only message this can ever send is a true one — and it sends once per
   handle, so a second Accept, or a page reloaded and pressed again, is quiet. */
function approveNotify(payload) {
  var ref = String(payload.ref || '').trim();
  if (!ref) return { ok: false, error: 'no ref' };

  var address = lookupEmail(ref);
  if (!address) return { ok: false, error: 'unknown ref' };

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var member = (state.members || []).filter(function (m) { return m.notifyRef === ref; })[0];
  /* Either kind counts as approved. An observer is never on the members list,
     so looking only there told them they had not been let in. */
  var obs = member ? null : observerFor(address);
  if (!member && !obs) return { ok: false, error: 'not approved' };

  var store = PropertiesService.getScriptProperties();
  var sentKey = 'approved:' + ref;
  if (store.getProperty(sentKey)) return { ok: true, already: true };

  var site = 'https://sairanoorhadi.github.io/cousins-book-club/';
  var club = (state.club && state.club.name) || 'Cousins Book Club';
  var who = member || obs;
  /* An observer is not a member and the email should not tell them they are:
     what they can actually do is the useful part. */
  var body = obs
    ? 'Hi ' + (who.name || 'there') + ',\n\n' +
      'An organiser has approved your account, so you can follow the ' + club + ' now.\n\n' +
      'You can read the meeting notes, add predictions and discussion points, put books ' +
      'forward and second the ones you like. Voting and nominating are for club members.\n\n' +
      'Sign in at ' + site + ' with this address \u2014 you\u2019ll get a six-digit code by email ' +
      'each time, so there\u2019s no password to remember.'
    : 'Hi ' + (who.name || 'there') + ',\n\n' +
      'An organiser has approved your account, so you\u2019re a member of the ' + club + ' now.\n\n' +
      'Sign in at ' + site + ' with this address \u2014 you\u2019ll get a six-digit code by email each ' +
      'time, so there\u2019s no password to remember.\n\n' +
      'See you at the next meeting.';
  MailApp.sendEmail({
    to: address,
    subject: obs ? "You're approved \u2014 " + club : "You're in \u2014 " + club,
    body: body
  });
  store.setProperty(sentKey, new Date().toISOString());
  return { ok: true };
}

/* ------------------------------------------------------------ party photos
   Photos live in a folder in the organiser's Drive, shared so anyone with the
   link can view — the club decided they should be visible to everyone.

   They are deliberately NOT committed to the repo. Base64 images would bloat
   state.json and slow every save, and git would keep them forever even after
   they were deleted. On Drive, deleting one actually deletes it.

   Only a signed-in member can add or remove; anyone can look. */

var PHOTO_FOLDER = 'Cousins Book Club photos';
/* The record of what each photo is lives in its own folder, NOT in the one
   above. That one is shared to anyone with the link so the images load in a
   browser, and the record carries the uploader's address so they can delete
   their own. Put the two together and the addresses would be a link away. */
var PHOTO_RECORD_FOLDER = 'Cousins Book Club photo records';
var PHOTOS_PER_MEETING = 100;
var CAPTION_MAX = 500;
var PEOPLE_MAX = 300;

function photoFolder() {
  var store = PropertiesService.getScriptProperties();
  var id = store.getProperty('photo_folder_id');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) {}
  }
  var folder = DriveApp.createFolder(PHOTO_FOLDER);
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  store.setProperty('photo_folder_id', folder.getId());
  return folder;
}

/* Private: created with no sharing call, so it stays the organiser's alone. */
function photoRecordFolder() {
  var store = PropertiesService.getScriptProperties();
  var id = store.getProperty('photo_record_folder_id');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) {}
  }
  var folder = DriveApp.createFolder(PHOTO_RECORD_FOLDER);
  store.setProperty('photo_record_folder_id', folder.getId());
  return folder;
}

function photoKey(meetingId) { return 'photos:' + String(meetingId).slice(0, 60); }
function photoRecordName(meetingId) { return 'photos-' + String(meetingId).slice(0, 60) + '.json'; }

function photoRecordFile(meetingId, create) {
  var folder = photoRecordFolder();
  var hits = folder.getFilesByName(photoRecordName(meetingId));
  if (hits.hasNext()) return hits.next();
  if (!create) return null;
  return folder.createFile(photoRecordName(meetingId), '[]', 'application/json');
}

/* The record used to be a Script Property. That is a fixed-ceiling key/value
   store — a single value caps out around 9 KB — and the entries were already
   using half of it before a caption or a list of who is in the shot was added
   to each one. A JSON file on Drive has no such ceiling, and photo-list
   already makes one round trip, so it costs nothing extra to read.

   Anything written before the move is still in the old property; it is read
   from there once and written to Drive by the next change. */
function readPhotos(meetingId) {
  var file = photoRecordFile(meetingId, false);
  if (file) {
    try { return JSON.parse(file.getBlob().getDataAsString() || '[]'); }
    catch (err) { return []; }
  }
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(photoKey(meetingId)) || '[]'); }
  catch (err) { return []; }
}

function writePhotos(meetingId, list) {
  photoRecordFile(meetingId, true).setContent(JSON.stringify(list));
  /* one home for this, so the stale copy does not outlive the move */
  try { PropertiesService.getScriptProperties().deleteProperty(photoKey(meetingId)); } catch (err) {}
}

function photoAdd(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };

  var meetingId = String(payload.meetingId || '');
  if (!meetingId) return { ok: false, error: 'no meeting' };

  var dataUrl = String(payload.dataUrl || '');
  var match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) return { ok: false, error: 'not an image' };

  var bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > 6 * 1024 * 1024) return { ok: false, error: 'too big' };

  var blob = Utilities.newBlob(bytes, match[1], meetingId + '-' + Utilities.getUuid().slice(0, 8) + '.jpg');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var list = readPhotos(meetingId);
    if (list.length >= PHOTOS_PER_MEETING) return { ok: false, error: 'that party is full' };

    var file = photoFolder().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var entry = {
      id: file.getId(),
      by: (directory()[email] || {}).name || email.split('@')[0],
      at: new Date().toISOString(),
      email: email,         /* so the uploader can delete their own */
      /* what the photo is, who is in it, and whether it was made or touched
         up with AI — all three optional, all three typed per photo */
      caption: String(payload.caption || '').slice(0, CAPTION_MAX),
      people: String(payload.people || '').slice(0, PEOPLE_MAX),
      ai: !!payload.ai
    };
    list.push(entry);
    writePhotos(meetingId, list);
    return { ok: true, photo: publicPhoto(entry) };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  } finally {
    lock.releaseLock();
  }
}

/* the uploader's address is not part of what anyone else gets to see */
function publicPhoto(entry) {
  return {
    id: entry.id, by: entry.by, at: entry.at,
    caption: entry.caption || '', people: entry.people || '', ai: !!entry.ai
  };
}

function photoList(payload) {
  var meetingId = String(payload.meetingId || '');
  if (!meetingId) return { ok: false, error: 'no meeting' };
  return { ok: true, photos: readPhotos(meetingId).map(publicPhoto) };
}

/* Changing what a photo says, without touching the photo. The image is left
   exactly where it is — this only rewrites the three fields in the record.
   Who may: whoever uploaded it, or the organiser. The same rule as deleting,
   because the same record decides it. */
function photoEdit(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };

  var meetingId = String(payload.meetingId || '');
  var id = String(payload.id || '');
  var organiser = normEmail(propEmail('ORGANISER_EMAIL'));

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var list = readPhotos(meetingId);
    var entry = list.filter(function (p) { return p.id === id; })[0];
    if (!entry) return { ok: false, error: 'not found' };
    if (entry.email !== email && email !== organiser) return { ok: false, error: 'not yours' };

    entry.caption = String(payload.caption || '').slice(0, CAPTION_MAX);
    entry.people = String(payload.people || '').slice(0, PEOPLE_MAX);
    entry.ai = !!payload.ai;
    writePhotos(meetingId, list);
    return { ok: true, photo: publicPhoto(entry) };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  } finally {
    lock.releaseLock();
  }
}

function photoDelete(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };

  var meetingId = String(payload.meetingId || '');
  var id = String(payload.id || '');
  var organiser = normEmail(propEmail('ORGANISER_EMAIL'));

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var list = readPhotos(meetingId);
    var entry = list.filter(function (p) { return p.id === id; })[0];
    if (!entry) return { ok: false, error: 'not found' };
    /* your own photos, or anything at all if you're the organiser */
    if (entry.email !== email && email !== organiser) return { ok: false, error: 'not yours' };

    try { DriveApp.getFileById(id).setTrashed(true); } catch (err) {}
    list = list.filter(function (p) { return p.id !== id; });
    writePhotos(meetingId, list);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* --------------------------------------------------------------- the inbox */


/* ------------------------------------------------- the same book, twice
   Two people can put the same book forward seconds apart. The page checks
   before it sends, but it is working from a copy of the club's file that can
   be minutes old and cannot see a submission that landed while the form was
   being filled in. This can: it runs inside the same lock that writes the
   inbox, so between the look and the write nothing else gets in.

   Kept deliberately in step with the page's own normTitle/sameAuthor. If one
   of them changes, the other has to. */
function normTitleGS(s) {
  /* A leading article is moved, and so is the catalogue form that puts it at
     the end: "Sword of Kaigen, The" is the same book as "The Sword of
     Kaigen", and somebody pasting from a library record will send either. */
  return String(s || '').replace(/,\s*(the|a|an)\s*$/i, '').toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/, '');
}
function authorWordsGS(s) {
  var t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? t.split(' ').sort().join(' ') : '';
}
function authorTightGS(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
/* "M.L. Wang" and "M. L. Wang" are one person. An empty author on either side
   is not a disagreement — the title is carrying the comparison. */
function sameAuthorGS(a, b) {
  var x = authorWordsGS(a), y = authorWordsGS(b);
  if (!x || !y) return true;
  return x === y || authorTightGS(a) === authorTightGS(b);
}
function sameBookGS(t1, a1, t2, a2) {
  var n = normTitleGS(t1);
  return !!n && n === normTitleGS(t2) && sameAuthorGS(a1, a2);
}
function sameNameGS(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() &&
         String(a || '').trim() !== '';
}
/* One suggestion, filed. Either it is new and goes on the inbox as any other
   submission does, or the club already has the book and what happens instead
   depends on where it has it:
     an approved recommendation  — refused, with the id so the page can offer
                                   the Endorse button on that book;
     one already waiting         — no second entry. The sender's name is added
                                   to that item as a pre-endorsement, and what
                                   they wrote is kept beside it for the
                                   organiser to compare;
     their own, either way       — refused, and said plainly. The site does not
                                   let anyone endorse their own book.
   The shelf is not checked here on purpose: a book the club has read is a
   warning on the form, not a refusal, and the sender has already seen it. */
function fileSuggestion(item) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var p = item.payload || {};
    var title = p.title, author = p.author, who = String(p.by || '').trim();

    /* Not swallowed. A read that fails here would leave the club looking as
       though it had no recommendations at all, and the submission would be
       filed as new against an empty list — the one outcome this whole
       function exists to prevent. Better to refuse it and say why. */
    var state = JSON.parse(ghGetFile(STATE_PATH).content || '{}');
    var recs = Array.isArray(state.recs) ? state.recs : [];
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.status !== 'approved' || !sameBookGS(title, author, r.title, r.author)) continue;
      if (sameNameGS(who, r.by)) {
        return { ok: false, error: 'duplicate',
                 duplicate: { how: 'own', title: r.title, id: r.id, pending: false } };
      }
      return { ok: false, error: 'duplicate',
               duplicate: { how: 'approved', title: r.title, by: r.by, id: r.id } };
    }

    var file = ghGetFile(INBOX_PATH);
    var data = { items: [] };
    if (file.content) {
      try { data = JSON.parse(file.content); } catch (err2) { data = { items: [] }; }
    }
    if (!Array.isArray(data.items)) data.items = [];
    /* Which submissions the organiser has already dealt with: the club's file
       lists their ids, and anything on it is no longer waiting. */
    var done = {};
    (Array.isArray(state.inbox) ? state.inbox : []).forEach(function (id) { done[id] = 1; });
    var recById = {};
    recs.forEach(function (r) { recById[r.id] = 1; });

    for (var j = 0; j < data.items.length; j++) {
      var it = data.items[j];
      if (!it || it.kind !== 'suggest' || done[it.id] || recById[it.id]) continue;
      var q = it.payload || {};
      if (!sameBookGS(title, author, q.title, q.author)) continue;
      if (sameNameGS(who, q.by)) {
        return { ok: false, error: 'duplicate',
                 duplicate: { how: 'own', title: q.title, id: it.id, pending: true } };
      }
      if (!Array.isArray(q.preEndorsements)) q.preEndorsements = [];
      var already = q.preEndorsements.some(function (e) { return sameNameGS(e && e.name, who); });
      if (!already && who) q.preEndorsements.push({ name: who, memberId: String(p.byId || ''),
                                                    at: new Date().toISOString() });
      /* What they wrote is worth keeping even though their entry is not: the
         organiser may prefer their summary or their rating to the first
         sender's, and otherwise it is simply thrown away. */
      if (!Array.isArray(q.alsoFrom)) q.alsoFrom = [];
      if (!q.alsoFrom.some(function (a) { return sameNameGS(a && a.by, who); })) {
        q.alsoFrom.push({ by: who, blurb: String(p.blurb || '').slice(0, 2400),
                          ratings: Array.isArray(p.ratings) ? p.ratings.slice(0, 6) : [],
                          at: new Date().toISOString() });
      }
      it.payload = q;
      ghPutFile(INBOX_PATH, JSON.stringify(data, null, 2), file.sha,
                'Endorsement folded onto a waiting suggestion');
      return { ok: true, merged: true,
               duplicate: { how: 'pending', title: q.title, by: q.by, id: it.id } };
    }

    data.items.push(item);
    if (data.items.length > 400) data.items = data.items.slice(-400);
    ghPutFile(INBOX_PATH, JSON.stringify(data, null, 2), file.sha, 'New suggest from the site');
    return { ok: true, id: item.id };
  } finally {
    lock.releaseLock();
  }
}

/* One endorsement per person per book, decided here rather than in the page.
   Changing your mind is still allowed -- an endorsement replacing a "not for
   me" is a different side, not a repeat -- so only the same side again is
   refused.

   Two places have to be looked at: the endorsements already folded into the
   club's file, and the ones still sitting unhandled in the inbox waiting for
   the organiser. Older rows carry only a name, so the match is on member id
   where there is one and on the name otherwise. */
function endorseAlready(item, actor) {
  var p = item.payload || {};
  var recId = String(p.recId || '');
  var side = String(p.vote || '') === 'down' ? 'dislikes' : 'endorsements';
  if (!recId || !actor) return '';
  var mine = function (row) {
    if (!row) return false;
    if (actor.type === 'observer') {
      if (row.obsId) return String(row.obsId) === String(actor.id);
      return sameNameGS(row.name, p.name);
    }
    if (row.memberId && actor.id) return String(row.memberId) === String(actor.id);
    return sameNameGS(row.name, p.name);
  };

  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { return ''; }          /* unreadable: let the organiser sort it out */
  var rec = (state.recs || []).filter(function (r) { return String(r.id) === recId; })[0];
  if (rec && (rec[side] || []).some(mine)) return 'already ' + side;

  var items;
  try { items = JSON.parse(ghGetFile(INBOX_PATH).content || '{"items":[]}').items || []; }
  catch (err2) { return ''; }
  var done = {};
  (Array.isArray(state.inbox) ? state.inbox : []).forEach(function (id) { done[id] = 1; });
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || it.kind !== 'endorse' || it.handled || done[it.id]) continue;
    var q = it.payload || {};
    if (String(q.recId || '') !== recId) continue;
    var sameSide = (String(q.vote || '') === 'down' ? 'dislikes' : 'endorsements') === side;
    if (sameSide && mine(q)) return 'already ' + side;
  }
  return '';
}
function appendToInbox(item) {
  /* Two people submitting at once would otherwise clobber each other. */
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var file = ghGetFile(INBOX_PATH);
    var data = { items: [] };
    if (file.content) {
      try { data = JSON.parse(file.content); } catch (err) { data = { items: [] }; }
    }
    if (!Array.isArray(data.items)) data.items = [];
    data.items.push(item);
    /* Keep the file small — the organiser clears handled items from the site. */
    if (data.items.length > 400) data.items = data.items.slice(-400);
    ghPutFile(INBOX_PATH, JSON.stringify(data, null, 2), file.sha, 'New ' + item.kind + ' from the site');
  } finally {
    lock.releaseLock();
  }
}

/* --------------------------------------------------------- weekly round-up
   Submissions reach the site's inbox the moment they land, so nothing here is
   urgent. One email a week, on Sunday evening, covering what arrived and what
   is still waiting — and nothing at all in a quiet week. */

/* When the round-up goes out. Both are optional Script Properties, so the day
   and time can change without touching this file:

     DIGEST_DAY   MONDAY … SUNDAY   (default SUNDAY)
     DIGEST_HOUR  0-23              (default 18, i.e. 6pm)

   Both are read in the script's own timezone — File → Project Settings shows
   which one that is. Changing either only takes effect when setUpTrigger runs
   again; the trigger holds its own copy of the schedule. */
var DIGEST_DAY_DEFAULT = 'SUNDAY';
var DIGEST_HOUR_DEFAULT = 18;

function digestDay() {
  var want = prop('DIGEST_DAY').trim().toUpperCase();
  return ScriptApp.WeekDay[want] ? want : DIGEST_DAY_DEFAULT;
}
function digestHour() {
  var raw = prop('DIGEST_HOUR').trim();
  var n = Math.floor(Number(raw));
  return (raw && isFinite(n) && n >= 0 && n <= 23) ? n : DIGEST_HOUR_DEFAULT;
}
function digestSchedule() {
  var h = digestHour();
  return digestDay().charAt(0) + digestDay().slice(1).toLowerCase() + ' at ' +
    (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm');
}

function inboxItems() {
  try {
    var file = ghGetFile(INBOX_PATH);
    var data = JSON.parse(file.content || '{"items":[]}');
    return Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    return [];
  }
}

/* The organiser marks things done on the site, which records the ids in
   state.json. Reading them back keeps "still waiting" honest. */
function handledIds() {
  try {
    var state = JSON.parse(stateRead().content || '{}');
    return Array.isArray(state.inbox) ? state.inbox : [];
  } catch (err) {
    return [];
  }
}

function digestLine(item) {
  var p = item.payload || {};
  var day = String(item.at || '').slice(0, 10);
  if (item.kind === 'suggest') {
    return day + '  \u201c' + (p.title || 'Untitled') + '\u201d by ' + (p.author || 'unknown') +
      (p.by ? ' \u2014 put forward by ' + p.by : '');
  }
  if (item.kind === 'join') {
    /* This goes to your own inbox, not the repo, so it can carry the real
       address — it's the one place you can see it without opening the script. */
    var address = lookupEmail(p.emailRef);
    return day + '  ' + (p.name || 'Someone') + ' asked to join' +
      (address ? '  <' + address + '>' : '') + (p.note ? '\n        ' + p.note : '');
  }
  if (item.kind === 'endorse') {
    return day + '  ' + (p.name || 'Someone') + ' ' +
      (p.vote === 'down' ? 'passed on' : p.vote === 'none' ? 'took back their vote on' : 'endorsed') +
      ' \u201c' + (p.title || 'a book') + '\u201d';
  }
  if (item.kind === 'profile') {
    return day + '  ' + (p.member || p.name || 'Someone') + ' asked for a profile change' +
      (p.note ? '\n        ' + p.note : '');
  }
  if (item.kind === 'notify') {
    return day + '  ' + (p.name || 'Someone') + ' signed up for meeting emails';
  }
  if (item.kind === 'notedelete') {
    return day + '  ' + (p.deletedBy || 'Someone') + ' removed a ' +
      (p.field === 'pred' ? 'prediction' : 'discussion point') +
      (p.by ? ' (written by ' + p.by + ')' : '') + ': \u201c' + (p.text || '') + '\u201d';
  }
  return day + '  ' + item.kind;
}

var DIGEST_HEADINGS = {
  suggest: 'Books put forward',
  join: 'Asked to join',
  endorse: 'Endorsements',
  profile: 'Profile changes',
  notify: 'Reminder sign-ups',
  notedelete: 'Predictions & discussion points removed'
};
/* KINDS stays the accept-list for the anonymous public-submission endpoint —
   a deletion is never that, it is logged from inside an authenticated call.
   This is the wider list the digest groups by, so a removal still shows up
   in the round-up without being something a stranger could post. */
var DIGEST_KINDS = KINDS.concat(['notedelete']);

function weeklyDigest() {
  var to = propEmail('ORGANISER_EMAIL');
  if (!to) return;

  var store = PropertiesService.getScriptProperties();
  var last = store.getProperty('digest:last');
  var since = last ? new Date(last) : new Date(Date.now() - 7 * 86400000);
  var now = new Date();

  var items = inboxItems();
  var handled = handledIds();
  var fresh = items.filter(function (it) {
    var t = new Date(it.at || 0);
    return t > since && t <= now;
  });
  var waiting = items.filter(function (it) {
    return !it.handled && handled.indexOf(it.id) === -1;
  });

  /* a quiet week gets no email at all */
  if (!fresh.length && !waiting.length) {
    store.setProperty('digest:last', now.toISOString());
    return;
  }

  var body = [];
  if (fresh.length) {
    body.push(fresh.length + ' thing' + (fresh.length === 1 ? '' : 's') + ' arrived this week.');
    DIGEST_KINDS.forEach(function (kind) {
      var of = fresh.filter(function (it) { return it.kind === kind; });
      if (!of.length) return;
      body.push('', (DIGEST_HEADINGS[kind] || kind) + ' (' + of.length + ')');
      of.forEach(function (it) { body.push('  ' + digestLine(it)); });
    });
  } else {
    body.push('Nothing new arrived this week.');
  }

  body.push('');
  body.push(waiting.length
    ? waiting.length + ' still waiting for you in the inbox.'
    : 'Nothing is waiting — the inbox is clear.');
  body.push('', 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/  \u2014 Admin \u2192 Inbox');

  MailApp.sendEmail({
    to: to,
    subject: 'Book club \u2014 ' + (fresh.length ? fresh.length + ' new this week' : 'weekly round-up'),
    body: body.join('\n')
  });
  store.setProperty('digest:last', now.toISOString());
}

/** Run from the editor to see this week's round-up without waiting for Sunday. */
function previewDigest() {
  var to = propEmail('ORGANISER_EMAIL');
  Logger.log(to ? 'Would send to ' + to : 'ORGANISER_EMAIL is not set to a real address.');
  Logger.log('Scheduled for ' + digestSchedule() + '. ' + (digestInstalled()
    ? 'The trigger is installed.'
    : 'NO TRIGGER YET \u2014 run setUpTrigger once to install it.'));
  var items = inboxItems(), handled = handledIds();
  Logger.log(items.length + ' items in the inbox, ' +
    items.filter(function (it) { return !it.handled && handled.indexOf(it.id) === -1; }).length + ' still waiting.');
  items.slice(-10).forEach(function (it) { Logger.log(digestLine(it)); });
}

/* ------------------------------------------------------------ GitHub calls */

function ghUrl(path) {
  return 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + path;
}

function ghHeaders() {
  var token = prop('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN is not set in Script Properties');
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/* ------------------------------------------------ one read of the club's file
 * state.json is nine hundred kilobytes, two hundred and twenty-six of which
 * is the club's logo as base64. Signing in used to fetch the whole of it
 * twice: loginVerify asks memberFor whether this address belongs to a member,
 * then asks profileFor to build the profile, and profileFor asks memberFor
 * again. Someone who is not a member paid for three, because pendingFor reads
 * it as well.
 *
 * One execution, one read. Only the callers that read it and put it down
 * again use this; a read-modify-write needs the live sha, so those still go
 * straight to ghGetFile, and they say so where they do it.
 *
 * Emptied at the top of every doPost, so the memo can never outlive the
 * request that filled it however Apps Script chooses to recycle the context,
 * and emptied by ghPutFile, so nothing that reads after a write in the same
 * execution can see what the file said before it.
 */
var STATE_MEMO = null;
function stateRead() {
  if (!STATE_MEMO) STATE_MEMO = ghGetFile(STATE_PATH);
  return STATE_MEMO;
}
function stateForget() { STATE_MEMO = null; }

function ghGetFile(path) {
  var res = UrlFetchApp.fetch(ghUrl(path) + '?ref=' + encodeURIComponent(REPO_BRANCH), {
    headers: ghHeaders(),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return { content: '', sha: null };
  /* The path is in the message because the site shows this to whoever was
     submitting, and "GitHub read failed: 401" alone does not say whether the
     club's file or its inbox was out of reach. */
  if (res.getResponseCode() >= 300) throw new Error('GitHub read failed: ' + res.getResponseCode() + ' on ' + path);
  var j = JSON.parse(res.getContentText());
  return {
    content: Utilities.newBlob(Utilities.base64Decode(j.content)).getDataAsString(),
    sha: j.sha
  };
}

function ghPutFile(path, text, sha, message) {
  var payload = {
    message: message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: REPO_BRANCH
  };
  if (sha) payload.sha = sha;
  var res = UrlFetchApp.fetch(ghUrl(path), {
    method: 'put',
    headers: ghHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  /* Before the status is looked at: a failed write can still have landed, and
     a memo that survives either outcome is a memo that can be wrong. */
  if (path === STATE_PATH) stateForget();
  if (res.getResponseCode() >= 300) throw new Error('GitHub write failed: ' + res.getResponseCode() + ' on ' + path);
}

/* ----------------------------------------------------------- AI summaries */

function summarise(payload) {
  var key = propKey('ANTHROPIC_API_KEY', 'sk-ant-');
  if (!key) return { ok: false, error: 'no api key' };

  var title = String(payload.title || '').slice(0, 200);
  var author = String(payload.author || '').slice(0, 200);
  if (!title) return { ok: false, error: 'no title' };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1000,
      /* A blurb is a small job — keep the thinking shallow so the form stays snappy. */
      output_config: { effort: 'low' },
      system: 'You write short book-club blurbs. Three or four sentences, present tense, ' +
              'no spoilers beyond the opening premise, no marketing language, no star ratings. ' +
              'If you do not know the book, say so in one sentence instead of inventing a plot.',
      messages: [{
        role: 'user',
        content: 'Write a blurb for "' + title + '"' + (author ? ' by ' + author : '') + '.'
      }]
    })
  });

  if (res.getResponseCode() >= 300) return { ok: false, error: 'api ' + res.getResponseCode() };

  var body = JSON.parse(res.getContentText());
  /* Safety classifiers can decline; content is empty when that happens. */
  if (body.stop_reason === 'refusal') return { ok: false, error: 'refused' };

  var text = (body.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n')
    .trim();

  return text ? { ok: true, summary: text } : { ok: false, error: 'empty' };
}

/* ------------------------------------------------- what age is this for (AI)
   The sibling of summarise: a question asked plainly and an answer given
   plainly. bookDetails already returns an ageMin/ageMax pair, but a pair is a
   thing to apply, and this is deliberately a thing to read \u2014 the reader
   weighs it and moves the handles themselves, or does not.

   Nothing about the slider's current position goes into the prompt. Telling it
   where the handles sit would invite it to agree with them, and an opinion
   that agrees with the guess it was shown is not worth asking for. */
function ageNote(payload) {
  var key = propKey('ANTHROPIC_API_KEY', 'sk-ant-');
  if (!key) return { ok: false, error: 'no api key' };

  var title = String(payload.title || '').slice(0, 200);
  var author = String(payload.author || '').slice(0, 200);
  if (!title) return { ok: false, error: 'no title' };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      /* Sonnet rather than Opus: this is a two-sentence reading, not a hard
         problem, and it is a form button people press more than once.
         Thinking is on by default on both, and its tokens come out of
         max_tokens — at 800 a run of thinking could eat the whole budget
         before a single sentence of answer was written, which is what
         "empty" was. Effort is named rather than left to the default, and
         the ceiling is high enough that thinking cannot crowd the answer
         out. It is a cap, not a spend: only what is generated is billed. */
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      system: 'You advise a family book club on what age a book suits. Answer in two or ' +
              'three plain sentences: the age or school-year range you would put on it, and ' +
              'what in the book decides that \u2014 reading difficulty, and any content a ' +
              'parent would want to know about. No headings, no bullet points, no star ' +
              'ratings. If you do not know the book, say so in one sentence rather than ' +
              'guessing.',
      messages: [{
        role: 'user',
        content: 'What age rating or reading level would you suggest for "' + title + '"' +
                 (author ? ' by ' + author : '') + '?'
      }]
    })
  });

  if (res.getResponseCode() >= 300) return { ok: false, error: 'api ' + res.getResponseCode() };

  var body = JSON.parse(res.getContentText());
  if (body.stop_reason === 'refusal') return { ok: false, error: 'refused' };

  var text = (body.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n')
    .trim();

  if (text) return { ok: true, note: text };
  /* The two ways to come back with nothing are not the same fault, and the
     one that was happening looked like the other. */
  return { ok: false, error: body.stop_reason === 'max_tokens' ? 'ran out of room' : 'empty' };
}

/* ------------------------------------------------------- book details (AI)
   Google's AI Overview is not something any program can read — there's no API
   for it, and the search page can't be fetched from a browser or scraped
   within Google's terms. This asks Claude the same question instead and
   returns the answer as structured fields the form can drop straight in. */

function bookDetails(payload) {
  var key = propKey('ANTHROPIC_API_KEY', 'sk-ant-');
  if (!key) return { ok: false, error: 'no api key' };

  var title = String(payload.title || '').slice(0, 200);
  var author = String(payload.author || '').slice(0, 200);
  if (!title) return { ok: false, error: 'no title' };

  var schema = {
    type: 'object',
    additionalProperties: false,
    required: ['author', 'pages', 'ageMin', 'ageMax', 'genres', 'summary', 'confident'],
    properties: {
      author: { type: 'string', description: 'The author, or "" if unsure.' },
      pages: { type: 'integer', description: 'Typical print page count. 0 if unsure.' },
      ageMin: { type: 'integer', description: 'Youngest age this suits, 0-100.' },
      ageMax: { type: 'integer', description: 'Oldest age band. Use 100 for "and up".' },
      genres: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string' },
        description: 'Plain genre names a reader would use, e.g. Fantasy, Humour, Middle Grade.'
      },
      summary: { type: 'string', description: 'Three or four sentences, no spoilers past the opening premise.' },
      confident: { type: 'boolean', description: 'False if you are not sure this book exists or are guessing.' }
    }
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 2000,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: schema }
      },
      system: 'You answer with facts about published books. If you do not know a book, ' +
              'set confident to false and leave the fields you are unsure of empty or zero ' +
              'rather than inventing them. Age ratings are about reading level and content, ' +
              'not marketing categories.',
      messages: [{
        role: 'user',
        content: 'Give me the details for the book "' + title + '"' + (author ? ' by ' + author : '') + '.'
      }]
    })
  });

  if (res.getResponseCode() >= 300) return { ok: false, error: 'api ' + res.getResponseCode() };

  var body = JSON.parse(res.getContentText());
  if (body.stop_reason === 'refusal') return { ok: false, error: 'refused' };

  var text = (body.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('')
    .trim();

  try {
    return { ok: true, details: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: 'unparseable' };
  }
}

/* ---------------------------------------------------------- Google Images
   Requires a Programmable Search Engine set up for image search. Both values
   live in Script Properties; neither ever reaches the browser. Without them
   this returns nothing and the site falls back to the book databases. */

function imageSearch(payload) {
  var key = propKey('GOOGLE_API_KEY', 'AIza');
  var cx = propKey('GOOGLE_CSE_ID', '');
  if (!key || !cx) return [];

  var title = String(payload.title || '').slice(0, 200);
  var author = String(payload.author || '').slice(0, 200);
  if (!title) return [];

  var q = [title, author, 'book cover'].filter(Boolean).join(' ');
  var url = 'https://www.googleapis.com/customsearch/v1' +
    '?key=' + encodeURIComponent(key) +
    '&cx=' + encodeURIComponent(cx) +
    '&searchType=image&num=6&imgType=photo&safe=active' +
    '&q=' + encodeURIComponent(q);

  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) return [];
    return (JSON.parse(res.getContentText()).items || [])
      .map(function (it) { return it.link; })
      .filter(function (u) { return /^https:/i.test(u); })
      .slice(0, 5);
  } catch (err) {
    return [];
  }
}

/* ------------------------------------------------------ meeting reminders */

/**
 * Runs on a time-driven trigger (see setUpTrigger). Sends, per meeting:
 *   - one email when the meeting is first seen with a date on it
 *   - one email REMIND_DAYS days before it starts
 *   - one email REMIND_MINUTES minutes before it starts
 *
 * What has already gone out is kept in Script Properties, so this never has to
 * write to state.json and can't collide with the organiser saving from the site.
 */
function sendMeetingEmails() {
  var state;
  try {
    state = JSON.parse(ghGetFile(STATE_PATH).content || '{}');
  } catch (err) {
    return;
  }

  var meetings = state.meetings || [];
  var members = state.members || [];
  var books = state.books || [];
  var clubName = (state.club && state.club.name) || 'Book club';
  var now = new Date();
  var store = PropertiesService.getScriptProperties();

  meetings.forEach(function (m) {
    if (m.done || !m.date) return;

    var start = meetingStart(m);
    if (!start || start < now) return;

    var book = books.filter(function (b) { return b.id === m.bookId; })[0];
    var to = recipients(members, m.bookId);
    if (!to.length) return;

    var key = 'sent:' + m.id;
    var sent = {};
    try { sent = JSON.parse(store.getProperty(key) || '{}'); } catch (err) { sent = {}; }

    var msLeft = start.getTime() - now.getTime();
    var daysLeft = msLeft / 86400000;
    var minsLeft = msLeft / 60000;
    var changed = false;

    if (!sent.scheduled) {
      send(to, clubName + ': meeting scheduled', intro(m, book, start, clubName));
      sent.scheduled = true;
      /* Already inside the five-day window when first seen — the notice above
         covers it, so don't fire a second near-identical email. */
      if (daysLeft <= REMIND_DAYS) sent.days = true;
      changed = true;
    }

    if (!sent.days && daysLeft <= REMIND_DAYS) {
      send(to, clubName + ': ' + Math.max(1, Math.round(daysLeft)) + ' days to go',
        intro(m, book, start, clubName));
      sent.days = true;
      changed = true;
    }

    if (!sent.soon && minsLeft <= REMIND_MINUTES) {
      send(to, clubName + ': starting in ' + Math.max(1, Math.round(minsLeft)) + ' minutes',
        intro(m, book, start, clubName));
      sent.soon = true;
      changed = true;
    }

    if (changed) store.setProperty(key, JSON.stringify(sent));
  });
}

function meetingStart(m) {
  var parts = String(m.date).split('-');
  if (parts.length !== 3) return null;
  var time = String(m.time || '19:00').split(':');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]),
                   Number(time[0]) || 0, Number(time[1]) || 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Members who asked for every meeting, or for this book in particular.
 *
 * The address itself comes from this script's private store, keyed by the
 * notifyRef the repo holds. A member with a plain `email` in state.json is an
 * older record from before addresses were withheld — it still works, but it is
 * sitting in a public repo, and the site flags it for removal.
 */
function recipients(members, bookId) {
  var out = {};

  /* Members manage their own subscriptions once they've signed in, and those
     live here rather than in the public repo. */
  var dir = directory();
  Object.keys(dir).forEach(function (email) {
    var want = (dir[email] || {}).books || [];
    if (want.indexOf('*') !== -1 || want.indexOf(bookId) !== -1) out[email] = 1;
  });

  /* Anyone the organiser ticked by hand on the Members tab, from before. */
  members.forEach(function (m) {
    var want = m.notify || [];
    if (want.indexOf('*') === -1 && want.indexOf(bookId) === -1) return;
    var address = lookupEmail(m.notifyRef) || m.email || '';
    if (address && address.indexOf('@') !== -1) out[address.toLowerCase()] = 1;
  });

  return Object.keys(out);
}

function intro(m, book, start, clubName) {
  var tz = Session.getScriptTimeZone();
  var lines = [
    clubName,
    '',
    'Book:     ' + (book ? book.title + ' by ' + book.author : 'to be confirmed'),
    'When:     ' + Utilities.formatDate(start, tz, "EEEE d MMMM yyyy 'at' h:mm a"),
    'Where:    ' + (m.place || 'to be confirmed')
  ];
  if (m.chapters) lines.push('Chapters: ' + m.chapters);
  if (m.pages) lines.push('Pages:    ' + m.pages);
  lines.push('', 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/');
  return lines.join('\n');
}

/* Everyone goes in bcc, so no recipient learns anyone else's address. */
function send(to, subject, body) {
  MailApp.sendEmail({
    to: propEmail('ORGANISER_EMAIL') || to[0],
    bcc: to.join(','),
    subject: subject,
    body: body
  });
}

/* ---------------------------------------------------------------- one-offs */

/** Run once from the editor to start the reminder timer. */
function setUpTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendMeetingEmails' || fn === 'weeklyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendMeetingEmails').timeBased().everyMinutes(5).create();
  /* the round-up — DIGEST_DAY / DIGEST_HOUR if they're set, else Sunday 6pm */
  ScriptApp.newTrigger('weeklyDigest').timeBased()
    .onWeekDay(ScriptApp.WeekDay[digestDay()]).atHour(digestHour()).create();
  Logger.log('Meeting emails: every 5 minutes. Round-up: ' + digestSchedule() + '.');
}

function digestInstalled() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'weeklyDigest';
  });
}

/**
 * Run ONCE from the editor to start the voting timer.
 *
 * Safe to run again: it removes its own trigger before making a new one, so
 * it cannot end up with two of them double-ticking.
 *
 * It asks for one permission the rest of the script does not need --
 * "Allow this application to run when you are not present" -- because that
 * is what a time-driven trigger is.
 *
 * Kept apart from setUpTrigger() on purpose. Two triggers that fail
 * independently are better than one that stops meeting reminders when a vote
 * goes wrong, or the other way round.
 */
function installVoteTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'voteTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('voteTick').timeBased().everyMinutes(VOTE_TICK_MINUTES).create();
  Logger.log([
    'Voting timer installed: every ' + VOTE_TICK_MINUTES + ' minutes.',
    '',
    'Exact, with no lag at all:',
    '  a vote opening at opensAt and shutting at closesAt. Both are worked',
    '  out from the clock on every read, so a ballot is accepted or refused',
    '  to the second whether or not the timer has run.',
    '',
    'Up to ' + VOTE_TICK_MINUTES + ' minutes late:',
    '  the start email',
    '  the ' + VOTE_REMIND_HOURS + '-hour nudge',
    '  the result appearing on the site after the deadline',
    '',
    'Apps Script schedules "every ' + VOTE_TICK_MINUTES + ' minutes" loosely, so add a',
    'minute or so of its own drift on a busy day.'
  ].join('\n'));
}

function voteTriggerInstalled() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'voteTick';
  });
}

/**
 * Run from the editor to READ the vote emails without sending anything.
 *
 * Prints the start email and the nudge for the vote currently in state.json,
 * exactly as they would go out, plus who would get each one and how much
 * email allowance is left today.
 */
function previewVoteEmails() {
  stateForget();
  var state;
  try { state = JSON.parse(stateRead().content || '{}'); }
  catch (err) { Logger.log('Could not read state.json: ' + err); return; }
  var v = voteOf(state, '');
  if (!v) { Logger.log('No vote in state.json to preview.'); return; }

  var who = v.test ? voteTestRecipients() : voteAddresses(state);
  var nudge = voteStillToVote(state, v);
  var quota = -1;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (err) {}
  var open = voteMailCopy(state, v, 'open');
  var remind = voteMailCopy(state, v, 'remind');
  var span = Date.parse(v.closesAt) - Date.parse(v.opensAt);

  Logger.log([
    'Vote ' + v.id + ' (' + (v.kind || 'rate') + ')' + (v.test ? ' -- A TEST VOTE' : ''),
    'Status now: ' + voteStatus(v),
    'Opens:  ' + voteEastern(v.opensAt),
    'Closes: ' + voteEastern(v.closesAt),
    'Timer:  ' + (voteTriggerInstalled() ? 'installed' : 'NOT INSTALLED -- run installVoteTrigger()'),
    'Email allowance left today: ' + quota + ' recipients (' + VOTE_MAIL_RESERVE +
      ' held back for sign-in codes)',
    '',
    '--- START EMAIL -> ' + who.list.length + ' recipient(s)' +
      (who.missing.length ? ', no address on file for: ' + who.missing.join(', ') : ''),
    'Subject: ' + open.subject,
    '',
    open.body,
    '',
    '--- ' + VOTE_REMIND_HOURS + '-HOUR NUDGE -> ' +
      (v.test ? who.list.length : nudge.length) + ' recipient(s) who have not voted',
    (isFinite(span) && span <= VOTE_REMIND_HOURS * 3600000
      ? '(SKIPPED: the window is ' + VOTE_REMIND_HOURS + ' hours or less)' : ''),
    'Subject: ' + remind.subject,
    '',
    remind.body,
    '',
    '--- what the timer has done so far',
    JSON.stringify(voteMailFlags(v.id), null, 2)
  ].join('\n'));
}

/** Run once from the editor to check the GitHub token works. */
function testGitHub() {
  var file = ghGetFile(STATE_PATH);
  Logger.log(file.sha ? 'Read state.json, ' + file.content.length + ' bytes' : 'state.json not found');
}

/**
 * Run from the editor when email is going out and you want to know why.
 * Logs every subscription from both places they can live, every meeting still
 * due to send, and what each has already sent. Sends nothing.
 */
/** Run from the editor: the version of the code in the EDITOR. Compare it with
 *  what the /exec URL shows in a browser, which is the DEPLOYED version. */
function scriptVersion() {
  Logger.log('Editor code: ' + SCRIPT_VERSION +
    '\nNow open your /exec URL in a browser. If the "version" it shows is not ' +
    SCRIPT_VERSION + ', the deployment is stale: Deploy \u2192 Manage deployments ' +
    '\u2192 edit the deployment whose URL the site uses \u2192 Version: New version \u2192 Deploy.');
}

function whoGetsEmails() {
  var out = [];
  var store = PropertiesService.getScriptProperties();

  /* Subscriptions live in two places and it is easy to check only one:
     members who signed in and chose their own books are here... */
  var dir = directory();
  var names = Object.keys(dir);
  out.push('=== Signed-in members, subscriptions kept in this script ===');
  if (!names.length) out.push('  (nobody has signed in)');
  names.forEach(function (email) {
    var e = dir[email] || {};
    var books = e.books || [];
    out.push('  ' + email + '  ->  ' +
      (books.indexOf('*') !== -1 ? 'EVERY meeting'
        : books.length ? books.length + ' book(s): ' + books.join(', ')
        : 'nothing'));
  });

  /* ...and members the organiser ticked by hand are in the repo. */
  var state = {};
  try { state = JSON.parse(ghGetFile(STATE_PATH).content || '{}'); } catch (err) {}
  out.push('', '=== Ticked by hand under Admin \u2192 Members ===');
  var ticked = (state.members || []).filter(function (m) { return (m.notify || []).length; });
  if (!ticked.length) out.push('  (nobody)');
  ticked.forEach(function (m) {
    out.push('  ' + m.name + '  ->  ' +
      (m.notify.indexOf('*') !== -1 ? 'EVERY meeting' : m.notify.join(', ')) +
      (m.notifyRef ? '' : '   [no address held, so gets nothing]'));
  });

  out.push('', '=== Meetings still due to send ===');
  var now = new Date();
  var any = false;
  (state.meetings || []).forEach(function (m) {
    if (m.done || !m.date) return;
    var start = meetingStart(m);
    if (!start || start < now) return;
    any = true;
    var book = (state.books || []).filter(function (b) { return b.id === m.bookId; })[0];
    var sent = {};
    try { sent = JSON.parse(store.getProperty('sent:' + m.id) || '{}'); } catch (err) {}
    out.push('  ' + m.date + '  ' + (book ? book.title : m.bookId) +
      '   goes to ' + recipients(state.members || [], m.bookId).length + ' address(es)' +
      '   already sent: ' + (['scheduled', 'days', 'soon'].filter(function (k) { return sent[k]; }).join(', ') || 'nothing yet'));
  });
  if (!any) out.push('  (none \u2014 nothing more will go out)');

  out.push('', 'To stop your own: open the site, click your badge, ' +
    '\u201cTurn them all off\u201d. To stop everyone\u2019s: delete the ' +
    'sendMeetingEmails trigger under the clock icon.');
  Logger.log(out.join('\n'));
}

/**
 * Run from the editor to see who is signed up for meeting emails. The
 * addresses live only here, so this log is the way to read them back. Nothing
 * is written anywhere — close the log and they're private again.
 */
function listSubscribers() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var rows = Object.keys(all)
    .filter(function (k) { return k.indexOf('email:') === 0; })
    .map(function (k) { return k.slice(6) + '  ' + all[k]; });
  Logger.log(rows.length ? rows.join('\n') : 'Nobody has signed up yet.');
}

/**
 * Run before any risky change. Writes every script property to a file in your
 * Drive and logs its name.
 *
 * These properties are the one thing here that git does not hold: the club's
 * addresses, the reference each one hides behind, live sessions, the login
 * salt. state.json and inbox.json are recoverable from the repo's history;
 * this is not, so it is worth a minute before a deploy.
 *
 * The file contains real email addresses. Keep it in your Drive \u2014 don't
 * commit it, don't share the folder.
 */
function backupProperties() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var name = 'book-club-properties-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmm') + '.json';
  var file = DriveApp.createFile(name, JSON.stringify(all, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('Saved ' + Object.keys(all).length + ' properties to ' + name +
    ' in your Drive.\nTo put them back, run restoreProperties() with the file id: ' + file.getId());
}

/**
 * The way back from backupProperties(). Put the file id below \u2014 it is in
 * that run's log \u2014 and run it. Existing properties with the same names are
 * overwritten; anything added since is left alone.
 */
function restoreProperties() {
  var fileId = '';                                // <- put the backup file id here
  if (!fileId) { Logger.log('Set fileId first.'); return; }
  var text = DriveApp.getFileById(fileId).getBlob().getDataAsString();
  var all = JSON.parse(text);
  PropertiesService.getScriptProperties().setProperties(all, false);
  Logger.log('Restored ' + Object.keys(all).length + ' properties.');
}

/**
 * Forget one person's address — run this when someone asks to be removed, or
 * when a parent asks you to take their child's details out. Set the reference
 * (the "sub-…" value shown beside them under Admin → Members) below first.
 */
function forgetSubscriber() {
  var ref = '';                                   // <- put the sub-… reference here
  if (!ref) { Logger.log('Set ref first.'); return; }
  PropertiesService.getScriptProperties().deleteProperty('email:' + ref);
  Logger.log('Forgot ' + ref + '. Also untick their boxes under Admin → Members.');
}
