# The test site

There are two copies of the site:

| | Address | Data it uses |
| --- | --- | --- |
| **Real** | `https://sairanoorhadi.github.io/cousins-book-club/` | `data/state.json` |
| **Test** | `https://sairanoorhadi.github.io/cousins-book-club/dev/` | `dev/data/state.json` |

The test site carries a black-and-yellow band across the top and its browser tab
reads **TEST —**, so there is no mistaking one for the other.

## What it is safe to do there

Anything. That is the point.

Approve a book, delete a member, finish a meeting, wreck the reading list — it
all commits to `dev/data/state.json` and the real site never notices. When the
test data gets too messy to be useful, say so and it gets reseeded from the
real data.

## What it can and can't reach

The test site talks to the same Google Apps Script as the real one, but only
for the calls that **read**:

| Works on the test site | Blocked there |
| --- | --- |
| Fill in the details | Submitting a book |
| Ask AI (reading level) | Asking to join / signing up |
| Write one for me | Signing in |
| Cover search | Linking your name to a member |
| | Endorsing, disliking, subscribing |
| | Party photos |

The three lookups return data and write nothing; everything in the right-hand
column either writes to the *real* repo or reaches *real* members. A blocked
one says so rather than failing silently.

## The one thing it can't do

**Anything that writes to the real repo or reaches real members is blocked.**
A test "ask to join" would land in your real inbox; a test sign-in would edit
the real members list. Those buttons say so when pressed.

So: Organiser tools, the reading list, recommendations, filters, badges,
meetings and every lookup can be tested there. Submitting from the public form,
signing in, and party photos have to be checked on the real site — or on a
second Apps Script deployment of their own, which can be set up if it turns out
to be worth it.

## How a change reaches you

1. The change is built and tested here.
2. It goes to the **test site only** — `dev/index.html` moves, `index.html`
   does not. The real site carries on exactly as before.
3. You try it at the `/dev/` address and say what's wrong.
4. Once you're happy, it is copied across to `index.html` and the real site
   picks it up a minute or so later.

Nothing reaches the real page until step 4.

## Why the two files can't drift apart

`dev/index.html` is `index.html` with **one line added**:

```html
<script>window.__DEV_SITE = true;</script>
```

That's the entire difference. Everything the test site does differently — its
own data file, the endpoint being off, the warning band, the tab title — is
decided inside `index.html` itself, by a flag that line sets.

So promoting a tested change is a plain copy of one file, with nothing to
re-apply by hand and nothing to forget.

```
node tools/build-dev.js     # live page -> test page, adds the marker
node tools/promote-dev.js   # test page -> live page, takes it out again
```

`build-dev` refuses to write if `index.html` no longer has the flag, rather than
quietly producing a test site that behaves like the real one. `promote-dev`
refuses if the marker is missing or appears twice, and `--dry` says what it
would do without writing.

While something is waiting for you, the two files deliberately differ: the test
page is ahead. That's the review in progress.

## When the real site doesn't change after a promotion

GitHub publishes the page in two steps: a **build**, which packages the repo,
and a **deploy**, which puts it behind the address. The build is the reliable
one — it takes about thirty seconds. The deploy occasionally hangs on
GitHub's side, sits at `updating_pages` for ten minutes, and gives up:

```
Error: Timeout reached, aborting!
Canceling Pages deployment...
```

The commit is on `main` and the file is right; it simply never got published,
so the address carries on serving the previous version. Nothing needs
rebuilding and nothing needs changing.

What to do, in order:

1. **Re-run the failed job.** Actions → the failed "pages build and
   deployment" run → *Re-run failed jobs*. Usually enough.
2. **If the re-run sits in `queued`**, the stalled deployment is still holding
   the lock and a re-run can't get past it. Push any new commit to `main` — the
   fresh run takes a new lock and publishes.
3. **Check what is actually live** rather than trusting the run list: the last
   *successful* run's commit is the version being served. A string of green
   runs can all be test-site commits while the promotion itself is the one that
   failed.

Telling the two apart matters: a failed deploy looks exactly like "the change
didn't work" from the site itself.
