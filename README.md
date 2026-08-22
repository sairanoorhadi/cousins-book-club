# Cousins Book Club

The club's website — what we're reading, what we've finished, what we might read next, and a badge tree of the whole record.

**Live site:** https://sairanoorhadi.github.io/cousins-book-club/

## What's in here

| File | What it is |
|---|---|
| `index.html` | The entire site — markup, styles and behaviour in one file. |
| `data/state.json` | All the content: books, meetings, recommendations, members, reviews, images. |

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

Open the live site and click **Admin**. Five tabs:

- **Reading list** — three lanes (Currently reading / Up next / Finished) with one-click moves, a "finish it and start the next one" button, and a per-book editor for details, cover, badge, dates, progress and who read it.
- **Recommendations** — approve, edit, unpublish or delete anything on the recommendations shelf.
- **Meetings** — schedule and reschedule, set chapters and pages covered, mark meetings finished, write summaries.
- **Members** — names, join dates, profile pictures, Fable and Goodreads links.
- **Settings** — club name, tagline, logo, and the token above.

Every save commits `data/state.json` to `main`. GitHub Pages redeploys automatically and the live site catches up about a minute later.

### Book suggestions

The **Suggest a Book** tab opens a prefilled issue on this repo labelled `book suggestion`. Read them under [Issues](https://github.com/sairanoorhadi/cousins-book-club/issues), then add the ones the club wants from **Admin → Recommendations**, and close the issue.

### Covers, badges and photos

The site can't load images from other websites, so every image is uploaded through the admin panel: it's shrunk in your browser and stored inside `data/state.json`. Books with no uploaded cover get a generated typographic one, so the site always looks complete.

Keep an eye on file size — if `data/state.json` grows past a few megabytes, saves get slow. Reuse smaller source images rather than full-resolution scans.

### Editing by hand

`data/state.json` is plain JSON and can be edited directly on GitHub if you'd rather. The `rev` number at the top only needs to go up, never down. **Download state.json** in Admin → Settings gives you a backup copy any time.

## A note on privacy

This repo is public, which GitHub Pages requires on a free account. Everything in `data/state.json` — member names, photos, profile links, reviews — is visible to anyone who finds the URL. Don't put anything in here you wouldn't post publicly.
