/* backend/Code.gs, run here.
 *
 * Apps Script is not a thing you can install, and the endpoints that matter
 * most are the ones the test site is forbidden to call. So the real file is
 * loaded into a sandbox with the half-dozen services it touches standing in
 * for Google's: script properties in a plain object, the lock a counter, the
 * repository a string, and every email kept rather than sent.
 *
 *   const gas = require('./lib/gas');
 *   const s = gas.load({ state: {...}, props: {...} });
 *   s.call('nom-reopen', { ... });        // one doPost, as JSON
 *   s.state();                            // the repository as it now stands
 *   s.mail;                               // every email that would have gone
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function load(opts) {
  opts = opts || {};
  const props = Object.assign({
    GITHUB_TOKEN: 'ghp_test',
    ORGANISER_EMAIL: 'organiser@example.com',
  }, opts.props || {});
  const repo = { 'data/state.json': JSON.stringify(opts.state || {}, null, 2),
                 'data/inbox.json': JSON.stringify(opts.inbox || { items: [] }, null, 2) };
  const shas = {}; Object.keys(repo).forEach(k => { shas[k] = 'sha-' + k; });
  const mail = [], log = [], fetched = [];
  let locks = 0, uuid = 0, now = opts.now ? new Date(opts.now).getTime() : Date.now();

  const b64 = {
    encode: (s) => Buffer.from(typeof s === 'string' ? s : Buffer.from(s), 'utf8').toString('base64'),
    decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
  };

  const env = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { locks++; },
        releaseLock: () => { locks--; },
        tryLock: () => true,
      }),
    },
    UrlFetchApp: {
      fetch: (url, params) => {
        params = params || {};
        fetched.push({ url, method: (params.method || 'get').toLowerCase() });
        const m = /contents\/([^?]+)/.exec(url);
        const file = m ? decodeURIComponent(m[1]) : null;
        const method = (params.method || 'get').toLowerCase();
        if (file && (method === 'put')) {
          const body = JSON.parse(params.payload || '{}');
          repo[file] = Buffer.from(String(body.content), 'base64').toString('utf8');
          shas[file] = 'sha-' + (Math.random().toString(36).slice(2));
          return reply(200, { content: { sha: shas[file] } });
        }
        if (file && repo[file] !== undefined) {
          return reply(200, { sha: shas[file], content: b64.encode(repo[file]), encoding: 'base64' });
        }
        return reply(404, { message: 'Not Found' });
      },
    },
    MailApp: {
      sendEmail: (o) => { mail.push(o); },
      getRemainingDailyQuota: () => (opts.quota === undefined ? 400 : opts.quota),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }),
        atHour: () => ({ everyDays: () => ({ create: () => {} }) }) }) }),
      deleteTrigger: () => {},
      WeekDay: {},
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid).toString().padStart(4, '0') + '-0000-0000-000000000000',
      /* Enough of a format for the emails to be read back and checked. */
      formatDate: (d, tz, fmt) => new Date(d).toISOString(),
      base64Encode: b64.encode,
      base64Decode: b64.decode,
      base64EncodeWebSafe: (s) => b64.encode(s).replace(/\+/g, '-').replace(/\//g, '_'),
      newBlob: (data, type, name) => ({
        getBytes: () => data,
        getDataAsString: () => Buffer.from(
          typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('utf8'),
        getName: () => name, getContentType: () => type,
      }),
      computeDigest: (alg, value) => Array.from(require('crypto')
        .createHash('sha256').update(String(value), 'utf8').digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    ContentService: {
      createTextOutput: (t) => ({ _text: t, setMimeType() { return this; }, getContent: () => t }),
      MimeType: { JSON: 'JSON' },
    },
    DriveApp: {
      getFolderById: () => { throw new Error('no Drive in the sandbox'); },
      getFileById: () => { throw new Error('no Drive in the sandbox'); },
      createFolder: () => { throw new Error('no Drive in the sandbox'); },
      createFile: () => { throw new Error('no Drive in the sandbox'); },
      Permission: {}, Access: {},
    },
    Logger: { log: (m) => { log.push(String(m)); } },
    console,
  };
  function reply(code, body) {
    const text = JSON.stringify(body);
    return { getResponseCode: () => code, getContentText: () => text };
  }

  /* A clock the test moves, so "closed six days ago" needs no waiting. */
  const RealDate = Date;
  function FakeDate(...a) {
    if (!a.length) return new RealDate(now);
    return new RealDate(...a);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  env.Date = FakeDate;

  /* Apps Script has no modules: every top-level declaration in the file is a
     global, and every other file's globals are there beside it. A vm context
     is the same arrangement -- the services go in as globals, the file's own
     functions land next to them, and the context is then the script. */
  const src = fs.readFileSync(path.join(ROOT, 'backend', 'Code.gs'), 'utf8');
  const vm = require('vm');
  const scope = vm.createContext(env);
  vm.runInContext(src, scope, { filename: 'backend/Code.gs' });

  return {
    scope,
    props,
    mail,
    log,
    fetched,
    locksHeld: () => locks,
    setNow: (t) => { now = new Date(t).getTime(); },
    state: () => JSON.parse(repo['data/state.json']),
    setState: (st) => { repo['data/state.json'] = JSON.stringify(st, null, 2); },
    /* One request, the way the web app receives it. */
    call: (kind, payload) => {
      const out = scope.doPost({ postData: { contents: JSON.stringify({ kind, payload }) } });
      return JSON.parse(out.getContent());
    },
  };
}

module.exports = { load };
