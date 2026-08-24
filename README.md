# Cousins Book Club

The club's website — what we're reading, what we've finished, what we might read next, and a badge tree of the whole record.

**Live site:** https://sairanoorhadi.github.io/cousins-book-club/

## What's in here

| File | What it is |
|---|---|
| `index.html` | The entire site — markup, styles and behaviour in one file. |
| `data/state.json` | All the content: books, meetings, recommendations, members, reviews, images. |
| `data/inbox.json` | Submissions sent from the site by people without a GitHub account. |
| `backend/Code.gs` | Optional Google Apps Script that receives those submissions and sends meeting emails. |
| `docs/notifications.md` | How to set that script up. |

There is no build step and nothing to install. `index.html` reads `data/state.json` when the page loads and renders everything from it.

## First-time setup

### 1. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment**: set *Source* to **Deploy from a branch**, then **Branch: `main`**, folder **`/ (root)`**, and Save. The site appears at the link above within a minute or two.

### 2. Make an editing token

Everything on the site is read-only until you add a GitHub token, which is what lets the admin panel commit changes back to this repo.

1. Go to **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** Only select repositories → `sairanoorhadi/cousins-book-club`.
3. **Permissions:** Repository permissions → **Contents: Read and write**. Nothing else is needed.
4. Set an expiry you're comfortable with, generate it, and copy the token.
5. On the live site, click **Admin → Settings → Personal access token**, paste it, and press **Save token**. **Test connection** confirms it works.

The token is stored in that browser only — never in this repo — so you'll add it once on each device you edit from. If it expires, the site goes read-only and you paste a fresh one.

## Editing the site

Open the live site and click **Admin**. Six tabs:

- **Reading list** — three lanes (Currently reading / Up next / Finished) with one-click moves, a "finish it and start the next one" button, and a per-book editor for details, cover, badge, dates, progress and who read it. The club can have several books on the go at once; put more than one in *Currently reading* and the home page grows a slider between them.
- **Recommendations** — approve, edit, shortlist, unpublish or delete anything on the recommendations shelf, and remove a second someone added by mistake.
- **Meetings** — schedule and reschedule, set chapters and pages covered, mark meetings finished, write summaries.
- **Members** — names, join dates, profile pictures, Fable and Goodreads links, email addresses and which meetings each person wants emails about.
- **Inbox** — everything sent from the site by people without a GitHub account. Accept a book suggestion and it drops into Recommendations awaiting approval; accept a join request and the member is added.
- **Settings** — club name, tagline, logo, the token above, and the submissions endpoint.

Every save commits `data/state.json` to `main`. GitHub Pages redeploys automatically and the live site catches up about a minute later.

### Reading levels

A book's reading level is an age range set with a two-handle slider. Push the right-hand handle all the way up and the range is shown open-ended: 18–100 displays as **Ages 18+**, while 8–11 stays **Ages 8–11**. The recommendations page can be filtered by the same slider.

### Book suggestions and seconding

The **Suggest a Book** tab searches for the title as you type, then fills in the author, page count, genres and a summary from the book's listing. The summary can come from the listing, be written for you, or be typed from scratch — all three stay editable.

Anyone can also **second** a recommendation from its page, and the recommendations shelf is ordered by seconds first, then by the author's surname.

Both of these need the submissions endpoint set up — see `docs/notifications.md`. Until then, suggestions fall back to opening a prefilled issue on this repo labelled `book suggestion`, and seconding is switched off.

### Meeting emails

Members who have an email address and have asked for reminders get three emails per meeting: one when it's scheduled, one five days before, and one thirty minutes before. This is part of the same Apps Script — again, `docs/notifications.md`.

### Covers, badges and photos

Two ways to set a cover:

- **Search the web for a cover** looks the book up on Google Books and Open Library and offers the top five; picking one stores a link to it.
- **Upload** takes a file from your computer, shrinks it in the browser and stores it inside `data/state.json`.

Badges and profile pictures are upload-only. Books with no cover at all get a generated typographic one, so the site always looks complete.

Keep an eye on file size — if `data/state.json` grows past a few megabytes, saves get slow. Searched covers cost nothing here since they're only links; uploads are what add weight.

### Editing by hand

`data/state.json` is plain JSON and can be edited directly on GitHub if you'd rather. The `rev` number at the top only needs to go up, never down. **Download state.json** in Admin → Settings gives you a backup copy any time.

## A note on privacy

This repo is public, which GitHub Pages requires on a free account. Everything in `data/state.json` and `data/inbox.json` — member names, photos, profile links, reviews, **and the email addresses people sign up with** — is visible to anyone who finds the URL. Don't put anything in here you wouldn't post publicly, and tell people that when they hand over an address.

The **Admin** button is visible to everyone and the panel opens for anyone who clicks it, but nothing can be saved without the GitHub token above. There is no password, because a password checked inside a public page is not a password — anyone can read it in the page source. The token is the real lock, and it never leaves the browser it was pasted into.
