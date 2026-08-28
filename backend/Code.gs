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
var SCRIPT_VERSION = '2026-08-28b';

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
  if (kind === 'approve-notify') return json(approveNotify(payload));
  if (kind === 'notes-add') return json(notesAdd(payload));
  if (kind === 'notes-del') return json(notesDel(payload));
  if (kind === 'photo-add') return json(photoAdd(payload));
  if (kind === 'photo-list') return json(photoList(payload));
  if (kind === 'photo-delete') return json(photoDelete(payload));

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

/* ------------------------------------------------------------- signing in
   There are no passwords anywhere in this system. A member types their email,
   gets a six-digit code, and types it back; that exchanges for a session token
   the browser keeps. Nothing to leak, nothing to reset, and no password
   database for a club that includes children.

   Codes are stored hashed with a per-install salt, expire in ten minutes, and
   are thrown away after five wrong guesses. Sessions last thirty days. */

var CODE_MINUTES = 10;
var CODE_TRIES = 5;
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

function loginRequest(payload) {
  var email = normEmail(payload.email);
  if (!email || email.indexOf('@') < 1) return { ok: false, error: 'bad email' };

  /* Three answers, and only one of them sends anything. Someone waiting on the
     organiser is told so rather than left wondering; someone we have never
     heard of is pointed at signing up. Neither gets a code, so neither gets a
     session. */
  if (!memberFor(email)) {
    return { ok: false, error: pendingFor(email) ? 'pending' : 'not a member' };
  }

  var code = String(Math.floor(100000 + Math.random() * 900000));
  PropertiesService.getScriptProperties().setProperty('code:' + email, JSON.stringify({
    hash: hashCode(code, email),
    expires: Date.now() + CODE_MINUTES * 60000,
    tries: 0
  }));

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
  if (!memberFor(email)) {
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
  try { state = JSON.parse(ghGetFile(STATE_PATH).content || '{}'); }
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
  try { state = JSON.parse(ghGetFile(STATE_PATH).content || '{}'); }
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
    name: entry.name || (member ? member.name : ''),
    books: entry.books || [],
    memberId: member ? member.id : (entry.memberId || ''),
    hue: member ? (member.hue || '') : '',
    isMember: !!member
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

function notesAdd(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var member = memberFor(email);
  if (!member) return { ok: false, error: 'not a member yet' };

  var key = noteField(String(payload.field || ''));
  if (!key) return { ok: false, error: 'bad field' };
  var text = String(payload.text || '').trim().slice(0, 400);
  if (!text) return { ok: false, error: 'no text' };
  var by = String(payload.by || '').trim().slice(0, 60);

  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
      try { file = ghGetFile(STATE_PATH); }
      catch (err) { return { ok: false, error: 'no github token', detail: String(err) }; }
      var state;
      try { state = JSON.parse(file.content || '{}'); } catch (err) { return { ok: false, error: 'unreadable state' }; }

      var meeting = (state.meetings || []).filter(function (m) { return m.id === payload.meetingId; })[0];
      if (!meeting) return { ok: false, error: 'no such meeting' };
      if (meeting.done) return { ok: false, error: 'meeting closed' };
      if (!Array.isArray(meeting[key])) meeting[key] = [];

      var item = { id: payload.field + '-' + Utilities.getUuid().slice(0, 12), text: text, by: by };
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
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };
  var member = memberFor(email);
  if (!member) return { ok: false, error: 'not a member yet' };

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
              deletedBy: member.name || email
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

function profileSet(payload) {
  var email = whoIs(payload.token);
  if (!email) return { ok: false, error: 'signed out' };

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

  if (!propKey('GITHUB_TOKEN', '')) return { ok: false, error: 'no github token' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      var file;
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
      state.rev = Number(state.rev || 0) + 1;

      try {
        ghPutFile(STATE_PATH, JSON.stringify(state, null, 2), file.sha, 'Member updated their profile');
        if (wantName) {
          var dir = directory();
          if (dir[email]) { dir[email].name = wantName; dir[email].memberId = member.id; saveDirectory(dir); }
        }
        return { ok: true, name: member.name, hue: member.hue };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: 'busy, try again' };
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'busy' };
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
  try { state = JSON.parse(ghGetFile(STATE_PATH).content || '{}'); }
  catch (err) { return { ok: false, error: 'unreadable state' }; }
  var member = (state.members || []).filter(function (m) { return m.notifyRef === ref; })[0];
  if (!member) return { ok: false, error: 'not approved' };

  var store = PropertiesService.getScriptProperties();
  var sentKey = 'approved:' + ref;
  if (store.getProperty(sentKey)) return { ok: true, already: true };

  var site = 'https://sairanoorhadi.github.io/cousins-book-club/';
  var club = (state.club && state.club.name) || 'Cousins Book Club';
  MailApp.sendEmail({
    to: address,
    subject: "You're in \u2014 " + club,
    body:
    'Hi ' + (member.name || 'there') + ',\n\n' +
    'An organiser has approved your account, so you\u2019re a member of the ' + club + ' now.\n\n' +
    'Sign in at ' + site + ' with this address \u2014 you\u2019ll get a six-digit code by email each ' +
    'time, so there\u2019s no password to remember.\n\n' +
    'See you at the next meeting.'
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
var PHOTOS_PER_MEETING = 40;

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

function photoKey(meetingId) { return 'photos:' + String(meetingId).slice(0, 60); }

function readPhotos(meetingId) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(photoKey(meetingId)) || '[]'); }
  catch (err) { return []; }
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
      email: email          /* so the uploader can delete their own */
    };
    list.push(entry);
    PropertiesService.getScriptProperties().setProperty(photoKey(meetingId), JSON.stringify(list));
    return { ok: true, photo: publicPhoto(entry) };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  } finally {
    lock.releaseLock();
  }
}

/* the uploader's address is not part of what anyone else gets to see */
function publicPhoto(entry) {
  return { id: entry.id, by: entry.by, at: entry.at };
}

function photoList(payload) {
  var meetingId = String(payload.meetingId || '');
  if (!meetingId) return { ok: false, error: 'no meeting' };
  return { ok: true, photos: readPhotos(meetingId).map(publicPhoto) };
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
    PropertiesService.getScriptProperties().setProperty(photoKey(meetingId), JSON.stringify(list));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
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
    var state = JSON.parse(ghGetFile(STATE_PATH).content || '{}');
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
