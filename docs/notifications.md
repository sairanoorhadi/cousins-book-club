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
| `ANTHROPIC_API_KEY` | *optional* — "Write one for me" and "Fill in the details for me" |
| `GOOGLE_API_KEY` | *optional* — Google Images cover search |
| `GOOGLE_CSE_ID` | *optional* — the search engine id that goes with it |

The optional three each switch on one button. Leave them out and that button
says the feature isn't set up; everything else works regardless.

### Google Images for covers (optional)

Google has no open image API. The one programmable route is a **Programmable
Search Engine**, and it needs a key — which is exactly why this goes through
the script rather than the page: a key in a public web page is a key anyone can
spend.

1. Create a search engine at <https://programmablesearchengine.google.com/>.
   Set it to **search the entire web** and turn **Image search** on.
2. Copy its **Search engine ID** into `GOOGLE_CSE_ID`.
3. Get an API key at <https://console.cloud.google.com/apis/credentials>, enable
   the **Custom Search API** for the project, and put the key in
   `GOOGLE_API_KEY`.

The free tier is 100 searches a day, which is far more than a book club will
use. Without it, cover search still works — it just uses Google Books and Open
Library only.

> **Paste the value, not the description.** The right-hand column below says
> what each key is *for*; the value box wants the key itself. Pasting the
> description in is easy to do and hard to spot afterwards — an
> `ORGANISER_EMAIL` reading "where new submissions should be emailed" is not
> empty, so it reaches the mail call and throws, which takes the whole reminder
> run down with it. The script now checks the shape of each value and ignores
> anything that clearly isn't the real thing, but it can only fall back to
> "unset" — the feature stays off until a real value is there.

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

## Already set this up? Update the script

Signing in was added after the first version. To switch it on:

1. Open your script at <https://script.google.com>.
2. Replace all of `Code.gs` with the current version from this repo.
3. **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.**
4. Run `setUpTrigger` once from the editor, so the weekly round-up gets its
   Sunday trigger alongside the meeting one.

The URL stays the same, so nothing changes on the site. No new keys are needed
— sign-in codes go out through the same mail permission the reminders already
use.

## Signing in

Members sign in with a **six-digit code emailed to them**. There are no
passwords anywhere in this system: nothing to leak, nothing to reset, and no
password database for a club that includes children.

- A code lasts ten minutes and dies after five wrong guesses.
- Codes are stored hashed, with a salt unique to your script.
- A session lasts thirty days and lives in the script; the browser only holds
  an opaque token.
- Asking for a code always gives the same answer, so nobody can use the form to
  work out who is a member.

Being signed in only changes what the site *offers*. Every action that matters
is checked again at the endpoint against the session, so an edited browser
gets nothing.

### What signing in gets a member

- **Their own reminders**, changed whenever they like — a book at a time, or
  every meeting including books the club hasn't started. This takes effect
  straight away.
- **Their name filled in** when they put a book forward.
- **One-click endorsing**, without typing their name each time.
- **A progress panel** for the books they've recommended.
- **A badge colour** they pick themselves.

Changing a badge colour is the one member action that writes to
`data/state.json`. The script does it under a lock and retries once if the
organiser happened to save at the same moment; if both land together, whoever
was second is told to try again rather than overwriting.

## Party photos

A meeting can be a **Party**, and a party can have photos.

- **Anyone visiting the site can see them.** That's a deliberate choice by the
  club, not an accident.
- **Only a signed-in member can add one**, and only remove their own — you, as
  organiser, can remove any.
- They're stored in a Drive folder called *Cousins Book Club photos*, created
  automatically the first time someone uploads, and shared as
  "anyone with the link can view".

They are **not** committed to this repo, for two practical reasons: images as
base64 would bloat `data/state.json` and slow every save, and git would keep
them forever even after they were deleted. On Drive, deleting one actually
deletes it — from the site and from the folder.

Photos are shrunk to 1400px wide in the browser before they're sent, up to ten
at a time, forty per party.

### Removing a photo for good

Delete it from the party's notes on the site. That trashes the Drive file too.
If you'd rather clear a whole party, open the Drive folder and delete the files
there — the site drops anything it can't load.

## Where the addresses live

**No email address is ever written into this repo.** The repo is public and
some of the club are children, so the script splits the address off the moment
a submission arrives:

- the address goes into the script's own properties, inside your Google
  account, under an opaque reference like `sub-4f2a91c0e7bb`;
- `data/inbox.json` and `data/state.json` get only that reference and a masked
  hint, `s••••@gmail.com`, so you can tell one person from another;
- `sendMeetingEmails` swaps the reference back for the real address at the
  moment it sends.

The notification email you get when someone signs up **does** carry the real
address — that goes to your inbox, not the repo, and it's the easiest way to
see it.

Reminders go out with every recipient in **bcc**, so no child ever sees another
child's address.

### Reading and deleting addresses

In the script editor:

- `listSubscribers` logs everyone currently signed up, with their references.
- `forgetSubscriber` deletes one. Put the `sub-…` reference — shown beside the
  member under **Admin → Members** — at the top of the function first, run it,
  then untick their boxes on the site.

If a parent asks you to remove their child's details, those two steps are the
whole job.

### If an address did get committed

Addresses added by hand before this existed are flagged in red under **Admin →
Members** with a button to remove them. That takes it out of the current file,
but **git keeps history** — the old commit still holds it. For a family book
club that's usually fine; if it isn't, the address has to be scrubbed from the
history (`git filter-repo`) and the repo force-pushed, which rewrites every
commit hash.

## Who gets meeting emails

A member gets emailed about a meeting when the script holds an address for them
and they've asked for **every meeting** or for **that book**. People sign
themselves up from the site with the **Email me about this** button on the
meeting card; the request lands in your inbox and takes effect when you accept
it. You can tick and untick the books under **Admin → Members**, but you can't
type an address in — that's deliberate, so one can't end up in the repo by
accident.

Each meeting gets at most three emails. What's already gone out is remembered
in the script's own properties, so re-saving the site never re-sends anything.

## What the organiser gets emailed

**One email a week, on Sunday evening.** Submissions land in the site's inbox
the instant they arrive — that file is written before the endpoint answers — so
nothing here is urgent enough to interrupt you. The round-up covers what came in
that week, grouped by kind, plus a count of what's still waiting. A week with
nothing new *and* an empty inbox sends no email at all.

Join requests carry the real address in this email. That's the one place it
appears in readable form — it never goes into the repo.

To see the round-up without waiting for Sunday, run `previewDigest` from the
script editor; it logs what would be sent and mails nothing. If you'd rather it
came on a different day or hour, change `DIGEST_HOUR` and the `onWeekDay(...)`
line in `setUpTrigger`, then run `setUpTrigger` again.

## Costs and limits

- Apps Script: free. A consumer Google account can send 100 emails a day, which
  is far more than a book club needs.
- GitHub API: free.
- Anthropic API: only used when someone presses **Write one for me**. A blurb is
  a fraction of a cent.

## If something stops working

- **"Couldn't reach the club's inbox"** — the deployment's access is probably
  not set to *Anyone*. Redeploy and check step 4.
- **Sign-in won't send a code** — the box under Admin → Settings has a **Test
  it** button that says which of these it is. It does more than check the
  address answers: it asks the script a question only the current version
  understands, so it catches a deployment that's still running old code.
  The three things it can report:
  - *"The deployed script is an older copy"* — the code in the editor was
    updated but never deployed. **Deploy → Manage deployments → edit (pencil)
    → Version: New version → Deploy.** Saving in the editor is not enough; the
    live URL keeps serving whichever version was last deployed.
  - *"The script hit an error"* — it has never been given permission to send
    email. Open the script, pick `setUpTrigger` from the function dropdown and
    press **Run** once. Google will ask for permission; grant it. (You'll see a
    "Google hasn't verified this app" warning — *Advanced* → *Go to … (unsafe)*.
    It's your own script.)
  - *"Couldn't reach the script"* — the address is wrong, or the deployment's
    access isn't *Anyone*.
- **Submissions stop arriving** — the GitHub token has expired. Make a new one
  and update `GITHUB_TOKEN`.
- **"Couldn't link that just now" when a member picks their name** — same
  cause. Linking a name writes to `data/state.json`, so it needs the GitHub
  token; signing in doesn't, which is why sign-in can keep working while this
  fails. Make a new token (step 1) and update `GITHUB_TOKEN` under
  **Project Settings → Script properties**. No redeploy needed for a property
  change.
- **No weekly round-up** — the Sunday trigger is missing. Run `setUpTrigger`
  from the editor; it installs both that and the meeting one.
- **No meeting emails** — check the trigger still exists under the clock icon in
  the script editor, and that members have both an email address and a ticked
  box under Admin → Members.
- **Editing the script** — after any change, **Deploy → Manage deployments →
  edit → New version**, or the live URL keeps running the old code.
