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

## The one thing it can't do

**Submissions and sign-in are switched off there.** Both go through the Google
Apps Script, and that script writes to the *real* repo and emails *real*
members — a test "ask to join" would land in your real inbox and a test sign-in
would write to the real members list. Rather than risk that, the test site
refuses to reach the endpoint at all, so those buttons report themselves as not
switched on.

So: everything in Organiser tools, the reading list, recommendations, filters,
badges and meetings can be tested there. Signing in, submitting a book from the
public form, and party photos have to be checked on the real site — or on a
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
re-apply by hand and nothing to forget. It's rebuilt with:

```
node tools/build-dev.js
```

which refuses to write anything if `index.html` no longer has the flag, rather
than quietly producing a test site that behaves like the real one.
