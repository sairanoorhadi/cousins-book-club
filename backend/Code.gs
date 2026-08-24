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

var REPO_OWNER  = 'sairanoorhadi';
var REPO_NAME   = 'cousins-book-club';
var REPO_BRANCH = 'main';
var INBOX_PATH  = 'data/inbox.json';
var STATE_PATH  = 'data/state.json';

/* How long before a meeting the two reminder emails go out. */
var REMIND_DAYS    = 5;
var REMIND_MINUTES = 30;

/* Submissions the web app will accept. Anything else is rejected. */
var KINDS = ['suggest', 'join', 'profile', 'endorse', 'notify'];

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

/* ------------------------------------------------------------ web endpoint */

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'bad json' });
  }

  var kind = String(body.kind || '');

  /* The site's "Test it" button. */
  if (kind === 'ping') return json({ ok: true, pong: true });

  /* "Write one for me" on the suggestion form. */
  if (kind === 'summarise') return json(summarise(body.payload || {}));

  /* "Fill in the details for me" — page count, age rating, genres, summary. */
  if (kind === 'details') return json(bookDetails(body.payload || {}));

  /* Cover search against Google Images. */
  if (kind === 'images') return json({ ok: true, images: imageSearch(body.payload || {}) });

  if (KINDS.indexOf(kind) === -1) return json({ ok: false, error: 'unknown kind' });

  var item = {
    id: kind + '-' + Utilities.getUuid().slice(0, 12),
    kind: kind,
    at: new Date().toISOString(),
    payload: withheldEmail(clean(body.payload || {}))
  };

  try {
    appendToInbox(item);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }

  notifyOrganiser(item);
  return json({ ok: true, id: item.id });
}

/* Apps Script needs a doGet for the deployment to be reachable at all. */
function doGet() {
  return json({ ok: true, service: 'cousins-book-club inbox' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Trim anything oversized before it reaches the repo. */
function clean(payload) {
  var out = {};
  Object.keys(payload).slice(0, 24).forEach(function (k) {
    var v = payload[k];
    if (Array.isArray(v)) out[k] = v.slice(0, 20).map(function (x) { return String(x).slice(0, 200); });
    else if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v).slice(0, 4000);
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

/* --------------------------------------------------------------- the inbox */

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

function notifyOrganiser(item) {
  var to = prop('ORGANISER_EMAIL');
  if (!to) return;
  var lines = Object.keys(item.payload).map(function (k) {
    var v = item.payload[k];
    return k + ': ' + (Array.isArray(v) ? v.join(', ') : v);
  });
  /* This email goes to your own inbox, not the repo, so it can carry the real
     address — it's the one place you can see it without opening the script. */
  var address = lookupEmail(item.payload.emailRef);
  if (address) lines.push('address: ' + address + '  (kept private, not in the repo)');
  MailApp.sendEmail({
    to: to,
    subject: 'Book club — new ' + item.kind,
    body: lines.join('\n') + '\n\nOpen the site and go to Admin → Inbox to accept or dismiss it.'
  });
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

function ghGetFile(path) {
  var res = UrlFetchApp.fetch(ghUrl(path) + '?ref=' + encodeURIComponent(REPO_BRANCH), {
    headers: ghHeaders(),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return { content: '', sha: null };
  if (res.getResponseCode() >= 300) throw new Error('GitHub read failed: ' + res.getResponseCode());
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
  if (res.getResponseCode() >= 300) throw new Error('GitHub write failed: ' + res.getResponseCode());
}

/* ----------------------------------------------------------- AI summaries */

function summarise(payload) {
  var key = prop('ANTHROPIC_API_KEY');
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

/* ------------------------------------------------------- book details (AI)
   Google's AI Overview is not something any program can read — there's no API
   for it, and the search page can't be fetched from a browser or scraped
   within Google's terms. This asks Claude the same question instead and
   returns the answer as structured fields the form can drop straight in. */

function bookDetails(payload) {
  var key = prop('ANTHROPIC_API_KEY');
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
  var key = prop('GOOGLE_API_KEY');
  var cx = prop('GOOGLE_CSE_ID');
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
  return members.filter(function (m) {
    var want = m.notify || [];
    return want.indexOf('*') !== -1 || want.indexOf(bookId) !== -1;
  }).map(function (m) {
    return lookupEmail(m.notifyRef) || m.email || '';
  }).filter(function (address) {
    return address && address.indexOf('@') !== -1;
  });
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
    to: prop('ORGANISER_EMAIL') || to[0],
    bcc: to.join(','),
    subject: subject,
    body: body
  });
}

/* ---------------------------------------------------------------- one-offs */

/** Run once from the editor to start the reminder timer. */
function setUpTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMeetingEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendMeetingEmails').timeBased().everyMinutes(5).create();
}

/** Run once from the editor to check the GitHub token works. */
function testGitHub() {
  var file = ghGetFile(STATE_PATH);
  Logger.log(file.sha ? 'Read state.json, ' + file.content.length + ' bytes' : 'state.json not found');
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
