# Submissions and meeting emails

The site is a single HTML file on GitHub Pages. It can read from the repo, and
the organiser can write to it with a GitHub token — but a visitor with no
account can't, and a static page can't send email on a schedule.

`backend/Code.gs` fills both gaps. It's a Google Apps Script web app that:

- takes submissions from anyone (book suggestions, join requests, profile
  changes, seconds, meeting-email signups) and writes them to
  `data/inbox.json`, which the site reads;
- emails you whenever something arrives;
- emails members about meetings — once when the meeting is scheduled, once five
  days before, and once thirty minutes before;
- optionally writes a book summary when someone picks **Write one for me** on
  the suggestion form.

It runs in your own Google account. It's free at this volume, and none of the
keys ever reach the repo or the browser.

Until you set it up the site still works: suggestions fall back to opening a
GitHub issue, and seconding is switched off.

## 1. Make a GitHub token for the script

This is a second token, separate from the one in your browser.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
2. Repository access: **only** `sairanoorhadi/cousins-book-club`.
3. Permissions: **Contents → Read and write**.
4. Copy the token. You won't see it again.

## 2. Create the script

1. Go to <https://script.google.com> → **New project**.
2. Delete the sample code and paste in all of `backend/Code.gs`.
3. Rename the project something like "Book club inbox".

## 3. Add the keys

In the script editor: **Project Settings** (the gear) → **Script Properties** →
Add script property, once for each row:

| Property | Value |
| --- | --- |
| `GITHUB_TOKEN` | the token from step 1 |
| `ORGANISER_EMAIL` | where new submissions should be emailed |
| `ANTHROPIC_API_KEY` | *optional* — only for the "Write one for me" summaries |

Leave `ANTHROPIC_API_KEY` out and that one button politely says the feature
isn't switched on. Everything else works without it.

## 4. Deploy it

1. **Deploy** → **New deployment** → type **Web app**.
2. Execute as: **Me**.
3. Who has access: **Anyone**. (This is what lets your cousins post without
   signing in to anything. The script only accepts the handful of message types
   it knows about, and truncates anything oversized.)
4. Deploy, approve the permissions prompt, and copy the
   `https://script.google.com/macros/s/…/exec` URL.

## 5. Point the site at it

On the site: **Admin → Settings → Submissions endpoint**. Paste the URL, press
**Save endpoint**, then **Test it** — it should come back "the endpoint
answered".

## 6. Start the reminder timer

Back in the script editor, pick `setUpTrigger` from the function dropdown and
press **Run**. That schedules `sendMeetingEmails` every five minutes.

To check the GitHub side is wired up, run `testGitHub` and look at the log —
it should report reading `state.json`.

## Who gets meeting emails

A member gets emailed about a meeting when they have an email address and have
either asked for **every meeting** or for **that book**. Set both under
**Admin → Members**. People can sign themselves up from the site with the
**Email me about this** button on the meeting card; the request lands in your
inbox and adds them when you accept it.

Each meeting gets at most three emails. What's already gone out is remembered
in the script's own properties, so re-saving the site never re-sends anything.

## Costs and limits

- Apps Script: free. A consumer Google account can send 100 emails a day, which
  is far more than a book club needs.
- GitHub API: free.
- Anthropic API: only used when someone presses **Write one for me**. A blurb is
  a fraction of a cent.

## If something stops working

- **"Couldn't reach the club's inbox"** — the deployment's access is probably
  not set to *Anyone*. Redeploy and check step 4.
- **Submissions stop arriving** — the GitHub token has expired. Make a new one
  and update `GITHUB_TOKEN`.
- **No meeting emails** — check the trigger still exists under the clock icon in
  the script editor, and that members have both an email address and a ticked
  box under Admin → Members.
- **Editing the script** — after any change, **Deploy → Manage deployments →
  edit → New version**, or the live URL keeps running the old code.
