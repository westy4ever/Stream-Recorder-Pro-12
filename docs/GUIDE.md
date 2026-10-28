# Stream Recorder Pro Guide

_Last updated 2026-10-16_

## What it does

Stream Recorder Pro (version 4.5.0) records everything a streaming site does in your browser while you use it, so a resolver or extractor can be written for NovaPlay from real evidence instead of guesses. You browse and play normally; it records in the background, then exports the recording as JSON files.

| Section | What it holds | Why it matters |
|---|---|---|
| `networkLog` | Every request: URL, method, status, request and response headers | Shows the request order and the exact headers a stream needs (Referer, Origin, cookies) |
| `xhrBodies` | The replies to the page's API calls (fetch and XHR) | Where API JSON, encrypted blobs and stream lists come back |
| `scriptBodies` | The site's JavaScript files, up to 5 MB each | Where keys, signing and decryption code live |
| `frameDocuments` | Live HTML of the page and every iframe, plus snapshots | Listing-page markup and inline player config such as `window.__EM_PLAYER__` |
| `actions`, `userJourney` | Your clicks, form submits, navigation, stream URLs spotted | How to reach a page or reveal a server list |
| `contentPipeline` | Titles, download links and encoded links the extension parsed itself | A quick check of what was found |
| `screenshots` | Pictures of the page | Visual reference |

Everything comes from the same page load, so the keys in the HTML match the API calls that used them.

## Install and update

The extension runs unpacked from a folder on your PC, so every update is two steps: new files into that folder, then **reload**. Skipping the reload is the most common mistake: the popup shows the new code, but the recording part keeps running the old one.

**First install**

1. Download the extension: `git clone https://github.com/westy4ever/Stream-Recorder-Pro-12`, or on GitHub click **Code > Download ZIP** and unzip it.
2. In Brave, open `brave://extensions` (Chrome: `chrome://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Pin it: click the puzzle icon in the toolbar, then the pin next to Stream Recorder Pro.

**Every update**

1. Get the new files into the same folder: `git pull` in it, or download the ZIP again and copy its contents over the old files.
2. Open `brave://extensions` and click the **reload** icon (circular arrow) on the Stream Recorder Pro card.
3. Check the version on the card: it must show the new number (currently **4.5.0**).

Not sure which folder Brave uses? Click **Details** on the card and read **Loaded from**. Make sure only one Stream Recorder Pro is installed.

## Settings

The defaults are already the right ones for capturing a player, so most of the time you change nothing. The popup resets to these defaults each time it opens.

| Setting | Where | Best value | Why |
|---|---|---|---|
| Max Response Body Size | Options | 1000 KB (the default and maximum) | Keeps API replies whole. Scripts have their own 5 MB limit |
| Auto-snapshot | Popup, default in Options | On | Captures the page again after each click that reveals content |
| Record | Popup, default in Options | Current Tab | Keeps other tabs out. Popups and new tabs opened from it are still followed |
| XHR/Fetch only | Popup, default in Options | **Off** | When on, scripts and page HTML are not captured |
| Hide TMDB | Popup | On | Hides TMDB API noise in the stream list |

**Changing a default for good:** right-click the extension icon, choose **Options**, change it, then scroll down and click **Save Advanced Settings**. The first button you see, **Save Domain Filters**, saves only the domain lists.

A change made in the popup applies to the next recording only, then resets.

## How to record, step by step

One recording per job keeps the files small and clear: one broken server, or one new site.

1. **Open a new, normal tab.** Not Incognito: extensions are off there by default.
2. **Open the popup**: click the icon, or press `Ctrl+Shift+E`. Check **Record: Current Tab** and **Auto-snapshot** are on, and **XHR/Fetch only** is off.
3. **Click Start** (or `Ctrl+Shift+R`). A red REC badge appears on the icon and a small indicator on the page.
4. **Use the site normally in that tab.** For a server: open the movie, pick the server, press play. For a new site: homepage, a category, **type a title in the site's search box**, a movie page, Watch, and for series one season and one episode. Typing in the search box lets the extractor generator find the site's real search request (only search boxes are recorded, never passwords or other fields).
5. **Let the video really play for 10 to 15 seconds.** The stream requests only happen once it plays. If an ad opens a new tab, close it, come back and press play again.
6. **Take a manual snapshot if needed** with **Snapshot** (`Ctrl+Shift+S`). Auto-snapshot already covers most clicks, so this is only for something you want to be sure is kept.
7. **Check the counts in the popup.** The network count should have jumped when the video started. If it didn't, press play again.
8. **Click Stop**, then **wait a second** before exporting: a last snapshot is taken at Stop.

The page and every player iframe inside it are captured automatically while you record, including pages that only show their server list after a click.

## Exporting

Pick what to export in the **Export** dropdown, then click **JSON** (best for analysis) or **MD** (readable text). Files go straight to your **Downloads** folder with names starting `stream_recording_`. There is no save dialog: it was removed because Brave gave the files random names.

| Export option | What you get | Use it for |
|---|---|---|
| Everything (1 file) | The whole recording in one file | Small recordings |
| **Split by section** | One file per section plus a manifest; big sections cut into `_part1of3` style pieces under 4 MB | **The default choice** |
| Network Log only | `networkLog` | Headers, redirects, a 403 |
| Response Bodies only | `xhrBodies` | API replies |
| Scripts (player JS) only | `scriptBodies` | Decryption or signing code |
| Page & iframe HTML only | `frameDocuments` | Page markup and inline player config |
| Actions / Journey only | `actions` + `userJourney` | How a page is reached |
| Content only | `contentPipeline` | What the extension parsed |

**Split by section** writes only the sections that have data, so a missing file means that section was empty.

**The manifest file** (`stream_recording_MANIFEST_...txt`) lists every file and its size, and starts with three check lines:

```
Extension version: 4.5.0
Scripts captured: 51 OK, 0 failed
Page/iframe HTML captured: 6
```

If the version is old, the extension wasn't reloaded after an update. If scripts or HTML show 0 when you expected some, see Troubleshooting.

**Copy** puts the whole recording on the clipboard as JSON instead of a file.

## What to send for each job

Export with **Split by section**, then attach only the files the job needs. Send every `_partNofM` piece of a section that was split.

| Job | Send | Also say |
|---|---|---|
| A server doesn't play on the box but plays on PC | `networkLog`, `xhrBodies`, `frameDocuments` | Site, server name, movie |
| A player that decrypts or signs its links | the three above + `scriptBodies` | Which server |
| VidCore or VidFast stopped working | the newest files in `Downloads/StreamRecorder-VM/` | Which server |
| A new site to add to NovaPlay | `networkLog`, `xhrBodies`, `frameDocuments`, `actions` | What you clicked through |
| A server list or episodes appear only after a click | `frameDocuments` + `actions` | What you clicked |
| A download link that fails | `networkLog`, `xhrBodies` | Which download button |

Always add the **manifest** text, so the version and capture counts can be checked first. If the box's own test (`run_site_test.py`) was run, add its report too.

You don't need to send snapshot `.html` files any more: snapshots are inside `frameDocuments`.

### Player files saved automatically (VidCore, VidFast)

Some players (VidCore, VidFast) hide their request code in a small program inside one of their script files. While you record, the extension spots that file and saves it on its own, in full, to `Downloads/StreamRecorder-VM/`, with no export needed:

- `<site>_<file>.js`: the player file itself
- `<site>_<file>_page.html`: the page that loaded it (it holds the token the player starts from)
- `<site>_<file>_info.json`: where it came from and when

Each file is saved once. When the site puts out a new version, the file name changes and it is saved again. So if VidCore or VidFast stops working in NovaPlay, record one film on that server and send the newest files from that folder.

## The other popup buttons

Recording and exporting need only Start, Stop, Snapshot and the export buttons. The rest are helpers that read the recording you just made.

| Button | What it does |
|---|---|
| Solve CF | Opens the page in a new tab so you can pass a Cloudflare check by hand; it reports when the check is gone |
| Streams | Lists the stream-looking URLs found so far |
| Pipeline | Shows what the extension parsed (titles, links) |
| YTS, WeCima, SaveFiles | Site-specific scrapers for the open tab. Their parsing may be out of date for the current site layout, so treat the result as a hint |
| Torrent API | Looks through captured replies for torrent data |
| Gen Extractor, Full Extractor | Write a Python extractor for NovaPlay from the recording. It's a starting point: test it with `run_site_test.py` before using it |

| Gen Resolver | Writes a resolver for one host you name |
| Tests | Writes a Python test file for the generated extractor |
| Import HTML Snapshot(s) | Loads saved `.html` snapshots back in for analysis |
| APIs, Structure, All Routes, SPA Map, Selectors, Schema, Regex | Analyse the recording: API endpoints, page routes, CSS selectors, JSON shapes |
| Qualities, HLS, HLS Vis | Inspect an HLS playlist: the qualities it offers |
| Deobfuscate | Tries to unpack packed JavaScript (`eval(function(p,a,c,k,e,d)...`) |
| Cookies, Sequence, Changes, Compare, Version, Magnets | Cookie use, request order, what changed between visits, two sites side by side, site version, magnet links |
| Pop out, Minimize | Move the popup into its own window, or shrink it |

### What the extractor generator reads (4.5.0)

Gen Extractor / Full Extractor now look past the raw requests and write these findings at the top of the generated file:

| Finding | What it means for the extractor |
|---|---|
| **Next.js site** | The page data is JSON in `__NEXT_DATA__` (or `/_next/data/<buildId>/…json`), not HTML. The generated file reads the home lists from it and fetches the build id from the home page each time, because it changes on every site update |
| **TMDB-numbered site** | Titles are `/movie/<TMDB id>`, `/tv/<TMDB id>`. The generated file then works in TMDB mode: TMDB lists (trending, popular, top rated) and search, movie / series / season / episode pages from TMDB, and **one server entry per server name the player shows**, each calling the site's own stream API the way the recording did (with the setup call first, if there was one). If no stream API was traced it starts with the TMDB embed servers NovaPlay already plays. An encrypted reply still needs its decoder ported by hand |
| **Where the playlist came from** | The API call that produced the video playlist, plus a setup call before it (for example a `/seed` or token request). If the reply is encrypted, the script that builds the call is quoted in `extract_stream()` so the decoder can be ported |
| **Server names → API paths** | Links the names the player shows (Miami, Boise…) to the requests they make (`/{server}/sources`) |
| **Search** | The request the site sent after you typed in its search box. If you didn't type in it, the file says so instead of guessing from any URL containing "search" |
| **Trailers ignored** | IMDb video, YouTube and `trailers.*` addresses are never offered as the film's stream |
| **NovaPlay check** | The warnings list now flags imports NovaPlay's `extractors/base.py` doesn't have, `BeautifulSoup` use, broken URL joins and wrong method signatures |

## New in 4.6 and 4.7

### Reload on start (4.7.0)
When you press **▶ Start**, the tab you're on reloads, so the page itself is
recorded from its first request: its address, headers and cookies. Before
this, a page that had already loaded was missing from the recording (a real
EgyDead recording had no EgyDead requests at all).

- Switch it off in **Options → Reload the page when recording starts**.
- If the page came from a form (a "watch" button that posts), Brave may ask
  whether to resend it. Click **Continue**.

### 🍪 For NovaPlay: Cloudflare cookies for the box (4.7.0)
Some sites (EgyDead, FaselHDX, WeCima, CWB) show the box a Cloudflare
"checking your browser" page. Brave passes it and gets a clearance cookie
(`cf_clearance`). That cookie only works with Brave's exact identity and your
internet address. The box shares your PC's address, so NovaPlay can use it.

**Step by step**

1. **Reload the extension once** after updating: `brave://extensions` → reload
   on the Stream Recorder card. 4.7.0 asks for the *cookies* permission; allow it.
2. **Open the site in Brave** (for example `https://tv10.egydead.live/`) and wait
   until the real page shows, not "Just a moment…".
3. With that tab active, open the popup and click **🍪 For NovaPlay**.
   The status line says how many sites were saved and lists the ones with a
   Cloudflare clearance. If it says *no Cloudflare clearance found*, the site
   didn't challenge Brave this time, so nothing is needed yet.
4. A file named **`novaplay_cookies.json`** is saved to your Downloads folder.
   It holds that site's cookies, every Cloudflare clearance Brave has, and
   Brave's User-Agent.
5. **Copy it to the box** as `/etc/enigma2/novaplay_cookies.json`. Any of these
   works:
   - **WinSCP / FileZilla:** connect to the box's IP (SFTP or FTP, user `root`),
     go to `/etc/enigma2/`, drop the file there.
   - **Windows command line** (Windows 10/11 has `scp` built in):
     `scp "%USERPROFILE%\Downloads\novaplay_cookies.json" root@BOX-IP:/etc/enigma2/`
   - **DreamExplorer / a file manager on the box**, from a USB stick.
6. **Nothing to restart.** NovaPlay reads the file the next time it opens a
   page, and re-reads it whenever you copy a new one.
7. **Check it worked:** on the box run
   `grep -i "browser cookies" /tmp/novaplay.log | tail -3`.
   You should see *"using N cookie(s) incl. cf_clearance for …"*.

**Good to know**

- **The clearance expires,** usually within hours to a day. When the site
  shows "Cloudflare" in NovaPlay's log again, repeat steps 2–5.
  NovaPlay skips an expired clearance by itself.
- **One file for all sites:** visit every blocked site in Brave first, then
  click the button once. It collects every clearance Brave holds.
- **Same internet connection only:** if the PC or the box changes network
  (VPN, mobile hotspot), the clearance stops working.
- **It may not be enough:** Cloudflare can also check the connection's own
  fingerprint. If the log shows the cookie being used but the site still says
  Cloudflare, use NovaPlay's browser proxy instead.
- **Privacy:** the file contains login cookies for the current site too. Keep
  it on your PC and the box only.

### Search reminder (4.7.0)
When you press **⏹ Stop**, the status line reminds you if the recording has
no search in it. The extractor generator can only find a site's search if you
typed a title in the site's own search box while recording.

### requestContext export (4.6.0, timing in 4.7.0)
The split export now has a `stream_recording_requestContext_….json` file,
built from the network log:

| Part | What it shows | Why it helps |
|---|---|---|
| `frameMap` | Every page and iframe, its parent frame, and where it was redirected from | Which player page sits inside which site page |
| `redirects` | Each HTTP redirect hop (from → to, status) | A player domain that moved, e.g. `mixdrop.ps` → `mxdrop.click` |
| `streamRequests` | Each video or playlist request next to the request of the page that issued it; `differs` lists identity headers that changed | Tokens tied to a header: LuluStream and StreamRuby needed the same `Accept-Language` on both |
| `cdnStats` | Per video server: requests, ranged requests, errors, MB, average KB/s | Many small slow requests means a server that stutters through a player (Mixdrop) |
| `cookiesByDomain` | Cookies each site set (all `Set-Cookie`s) and the names sent back | Session cookies a resolver has to carry |

Redirect hops are kept as their own `networkLog` entries since 4.6.0. They
used to be overwritten by the address they redirected to.

### Extractor generator (4.6.1)
- **Picks the real site:** the generator recognises pop-ups, ad networks and
  redirect trackers and ignores them. The site is the top-level domain the
  recording started on and stayed on. The generated file lists the site it
  picked and the ad hosts it ignored.
- **Site pages only:** categories, next-page links and detail pages come
  only from the site's own pages. A page-2 link or a single title under
  `/serie/` is no longer a "category".
- **Already in NovaPlay:** for a site NovaPlay already handles, the file
  starts with *ALREADY IN NOVAPLAY: extractors/<name>.py*. Use the file to
  compare and patch that extractor, not to replace it.
- **Honest data labels:** the extension's own list scan is no longer reported
  as "this site's listing is JSON".

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Manifest shows an old version | Files updated but not reloaded | `brave://extensions` > reload on the card; check the version |
| `Scripts captured: 0 OK, 0 failed` | Old version running, or XHR/Fetch only was on | Reload; turn XHR/Fetch only off; record again |
| Scripts listed as failed | The site refused the extension's copy of a script | Send the export anyway: each failure records its reason |
| A section's file is missing from Split | That section was empty | Check the manifest counts; record again if it matters |
| `Page/iframe HTML captured: 0` | Old version, or Reload on start switched off and the page loaded before Start | Turn Reload on start back on, or reload the page after pressing Start |
| Network count doesn't move when you press play | The video never really started | Close ad tabs, press play again, let it run |
| Nothing captured from a new tab | Record was Current Tab and the tab wasn't opened from the recorded one | Open the player from the recorded tab, or switch to All Tabs |
| No "Save as" window | Intended: files go to Downloads | Look in Downloads for `stream_recording_...` |
| Exported JSON is huge | Long session with many pages | One short recording per job; use Split by section |
| Solve CF never says solved | Challenge still showing after 30 s | Solve it in the tab it opens, then try again |
| Two Stream Recorder Pro cards | An old copy still installed | Remove the old one; keep the one at 4.7.0 |
| 🍪 button says "Reload the extension" | The new cookies permission isn't active yet | `brave://extensions` → reload on the card, allow the permission |
| 🍪 file saved but NovaPlay still blocked | Clearance expired, wrong folder, or Cloudflare also checks the connection | File must be `/etc/enigma2/novaplay_cookies.json`; export a fresh one; else use the browser proxy |

## What it can't capture

- **Video data itself:** it records the requests and the playlists, not the video segments.
- **Scripts over 5 MB:** the rest is cut and marked `"truncated": true`.
- **API replies over 1000 KB:** cut at the Options limit.
- **WebAssembly decryptors:** the `.wasm` file is a request in `networkLog`, but its code isn't readable from the recording.
- **What happened before Start:** Reload on start covers the current page; earlier pages in other tabs aren't recorded.
- **A page's changes after the snapshot limit:** auto-snapshot keeps up to 4 per page address; take a manual snapshot for anything later.
- **Working code on its own:** Gen Extractor writes a starting point. A real resolver for a protected player still needs reading and testing by hand.
