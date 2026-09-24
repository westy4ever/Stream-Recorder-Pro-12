# Stream Recorder Pro — Capture Workflow Guide

A step-by-step guide for capturing site data and getting it to an AI session in a form
that's actually usable — written from what worked (and didn't) reverse-engineering
EgyDead this session, so you can run the same process cleanly on wecima and every site
after it.

---

## Part 1 — The sequence to follow, start to finish

### Step 1: Turn on Auto-Snapshot before you start recording

Open the popup → make sure **Auto-Snapshot** is enabled before you click Start. This one
setting is what makes the extension automatically re-capture a page after you click
something that reveals new content (a "Watch" button, a form submit, a redirect) —
without it, you have to manually re-snapshot every single reveal by hand, which is most
of what slowed EgyDead down. As of the latest fix, this defaults to on — but double
check it if you're not sure which version you're running.

### Step 2: Click Start, then browse the site normally

Once recording is on, just use the site the way a real visitor would:

- Open the homepage.
- Click into a category / listing page.
- Click into an actual item (movie, episode, series).
- **Click "Watch" or whatever reveals the actual player/server list.** This is the step
  people skip. The landing page and the revealed page are usually *different HTML* — if
  you only capture the landing page, whoever's writing the extractor (me) never sees the
  server list at all.
- If there's a season → episode structure, click through at least one full chain:
  series page → season page → one episode page → click Watch on that episode.
- If there's a download section separate from the watch/stream servers, open that too.

**Why this matters:** every real bug found and fixed this session came from seeing the
*actual* page state, not a guess at what it might look like. A captured landing page
that never got clicked into is close to useless for building extraction logic.

### Step 3: Take a manual snapshot at each meaningfully different state

Even with Auto-Snapshot on, it's worth manually hitting **📸 Snapshot** at each of these
moments, just to be sure:

1. The category/listing page (shows the item-list markup)
2. A single item's landing page, before clicking Watch (shows metadata: genre, year,
   country, quality, runtime — whatever the site displays)
3. The same page *after* clicking Watch (shows the server list)
4. If there's a separate download list, that section too
5. One embed/player page directly, if you can reach it (this is where obfuscated JS or
   deferred JSON data usually lives — the single most useful kind of capture for
   anything involving a packed script or an API-driven player)

### Step 3.5: Check the popup's counts before you click Stop

Before stopping, glance at the popup itself — it already shows something like
`X actions, Y network entries` once recording is running. If you just clicked "Watch"
and expected the server list to appear, but the network-entry count didn't move, the
click likely didn't register as a capture-worthy action. It's much faster to notice this
while the tab is still open (just click Watch again, or manually hit 📸 Snapshot) than to
discover it after uploading a capture that turns out to be missing the one thing that
mattered.

### Step 4: Click Stop

This is what makes the recorded data available to export. Nothing is downloadable until
you stop.

### Step 5: Choose what to export (see Part 2 below for exactly what each option gives you)

For a first-pass capture of a new site, **"🗂️ Split by section"** is almost always the
right choice — it gives a manageable, labeled set of files instead of one large combined
dump, and a manifest listing what's in each.

### Step 6: Send the files to the AI session

Upload the split files (or the single scoped file if you only needed one section) plus
any raw `.html` snapshot files from Step 3. If a network capture and an HTML snapshot
both exist for the same interaction, send both — they answer different questions (the
HTML shows structure/markup; the network log shows headers, status codes, and timing).

**If the site has a dedicated extraction button in the popup** (wecima has "🇸🇦 WeCima" —
check whether the site you're capturing has an equivalent), click it once during the
session and paste its raw output alongside the rest of the capture. These buttons run
built-in, site-specific parsing that may or may not match the site's actual current
markup — sending the output lets that be checked directly against the real HTML instead
of trusted blindly. See the WeCima-specific note in Part 3 below for why this matters
right now.

---

## Part 2 — What each export option actually gives you

| Option | Contains | Use it when... |
|---|---|---|
| **📦 Everything (1 file)** | The entire session in one JSON or MD file | The session is small, or you specifically want one file to keep as a complete record |
| **🗂️ Split by section** | One file per data type (`networkLog`, `xhrBodies`, `actions`, `contentPipeline`, etc.) plus a manifest listing each file and its size. Any single section over ~4MB is automatically broken further into numbered parts (`_part1of3`, etc.) | **This is the default choice for most captures.** Keeps files small and focused; lets you send only what's relevant |
| **🌐 Network Log only** | Every request made during the session: URL, method, status code, headers | Diagnosing a failed request, a wrong header, a redirect chain, or a CDN block (like the MixDrop Range/403 issue) |
| **📄 Response Bodies only** | The actual body content of XHR/fetch responses — this is where API JSON responses and (critically) obfuscated/packed JavaScript live | Anything involving an embed page, a player's own JS, an API-driven site, or suspected packed/obfuscated content |
| **🖱️ Actions / Journey only** | The sequence of clicks, form submits, and navigations you performed, in order | Reconstructing *how* to reach a particular page/state (e.g. "click Watch, which POSTs, which reveals the server list") |
| **🎬 Content (movies/downloads) only** | Whatever the extension's own content-pipeline parsing already extracted (movie list entries, download links) | Quick sanity check on what the extension itself found, before diving into raw data |

**One honest limit to know about:** splitting is by *category*, not by page/interaction.
If you captured 50 different pages in one long session, all 50 pages' network requests
still land together in one `networkLog` file (now auto-chunked if it's large, but still
one continuous stream). If you want data cleanly separated *per page or per site
you're comparing*, that still means running separate, shorter recording sessions rather
than one long one — Stop, export, Start again for the next page — since the extension
doesn't currently tag entries by "which click/page produced this."

---

## Part 3 — What actually mattered this session (apply these to wecima)

These are the concrete lessons from getting EgyDead working, in the order they tend to
bite:

1. **Raw HTML beats a markdown/text conversion every time.** A markdown export shows
   text and links but strips the `class="..."` attributes that any extractor's regex has
   to match against. Every real fix this session started from raw HTML with real class
   names. If you're ever unsure which format to send, send the raw `.html` snapshot.

2. **The "before" and "after" state of any reveal are both needed.** If a site has a
   "Watch" button, a "View more" button, or any client-side redirect before the real
   content shows up, capture both states separately (see Step 3 above). Don't assume the
   landing page tells the whole story.

3. **Cross-origin embed pages (the actual player) need their own capture.** The main
   page's HTML often just contains an `<iframe src="...">` — the real player markup,
   including any obfuscated JS, lives on a *different domain's* page entirely. Navigate
   into the iframe's own URL directly if you can, and snapshot that.

4. **If a script looks like `eval(function(p,a,c,k,e,d){...})`, that's packed
   JavaScript** — the real content (usually a stream URL) is hidden inside it and
   won't appear anywhere as plain text in the page. Don't worry about decoding it
   yourself; just make sure the **Response Bodies** capture includes the full script,
   uncut. That's now something both this extension's own deobfuscator and I can decode
   correctly.

5. **A JSON response with `"component":` at the top is an Inertia.js page** (used by
   MegaMax, and possibly others). These often load their real data via a *second*
   request after the page loads, not in the initial HTML — if something seems to be
   missing from a capture, check whether the site made a follow-up XHR request shortly
   after the page loaded, and make sure that response's body was captured too.

6. **A 403 on a media/CDN URL isn't always what it looks like.** It can mean an actual
   Cloudflare-style bot check, but it can equally mean a plain anti-hotlink rule tied to
   a specific request shape (like a `Range` header) that has nothing to do with
   Cloudflare at all. If a stream URL comes back 403, capturing the *response headers*
   (via the Network Log export) is what actually tells them apart — real Cloudflare
   challenges carry `cf-ray`/`cf-mitigated` headers; a plain anti-leech 403 usually
   doesn't.

7. **Don't skip the download section if one exists separately from the watch/stream
   list.** Some sites (EgyDead included) have a completely separate list of direct
   download providers, with different hosts and different markup than the streaming
   servers. If you only capture the watch page, that section never gets extracted.

8. **Don't trust a site-specific button in the popup until it's been checked against a
   real, current capture.** wecima has its own dedicated "🇸🇦 WeCima" extraction button —
   but comparing it against the real, previously-built `wecima.py` extractor turned up
   real disagreements: the button treats `/watch/` links as the movie items, while the
   real extractor treats those same links as navigation noise to *skip*; the button
   tries to read rating and quality out of plain link text, while the real site actually
   carries rating in a JSON-LD block and quality in a dedicated `<span class="quality">`
   element. The button may have been correct once and the site may have changed since —
   or it may never have matched. Either way, click it once during the first real capture
   and send its raw output alongside everything else, so it can be checked against the
   actual HTML rather than assumed to work.

---

## Part 4 — Quick checklist for capturing wecima

- [ ] Auto-Snapshot is on
- [ ] Category/listing page captured
- [ ] One item's landing page captured (before any reveal)
- [ ] Same item after clicking Watch/reveal, servers visible
- [ ] Series → season → episode chain captured, if wecima has one
- [ ] Download section captured, if separate from streaming servers
- [ ] At least one embed/player page captured directly (not just the iframe's parent page)
- [ ] Popup's action/network counts checked before clicking Stop (see Step 3.5)
- [ ] The "🇸🇦 WeCima" button tried once, its raw output saved to send along with the capture
- [ ] Exported with **Split by section**
- [ ] Raw `.html` snapshots included alongside the JSON/MD exports, not instead of them
