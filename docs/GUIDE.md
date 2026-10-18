# Stream Recorder Pro Guide

_Last updated 2026-10-16_

## What it does

Stream Recorder Pro (version 4.3.2) records everything a streaming site does in your browser while you use it, so a resolver or extractor can be written for NovaPlay from real evidence instead of guesses. You browse and play normally; it records in the background, then exports the recording as JSON files.

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
3. Check the version on the card: it must show the new number (currently **4.3.2**).

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
4. **Use the site normally in that tab.** For a server: open the movie, pick the server, press play. For a new site: homepage, a category, a movie page, Watch, and for series one season and one episode.
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
Extension version: 4.3.2
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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Manifest shows an old version | Files updated but not reloaded | `brave://extensions` > reload on the card; check the version |
| `Scripts captured: 0 OK, 0 failed` | Old version running, or XHR/Fetch only was on | Reload; turn XHR/Fetch only off; record again |
| Scripts listed as failed | The site refused the extension's copy of a script | Send the export anyway: each failure records its reason |
| A section's file is missing from Split | That section was empty | Check the manifest counts; record again if it matters |
| `Page/iframe HTML captured: 0` | Old version, or the recording started after the page loaded | Start first, then load the page |
| Network count doesn't move when you press play | The video never really started | Close ad tabs, press play again, let it run |
| Nothing captured from a new tab | Record was Current Tab and the tab wasn't opened from the recorded one | Open the player from the recorded tab, or switch to All Tabs |
| No "Save as" window | Intended: files go to Downloads | Look in Downloads for `stream_recording_...` |
| Exported JSON is huge | Long session with many pages | One short recording per job; use Split by section |
| Solve CF never says solved | Challenge still showing after 30 s | Solve it in the tab it opens, then try again |
| Two Stream Recorder Pro cards | An old copy still installed | Remove the old one; keep the one at 4.3.2 |

## What it can't capture

- **Video data itself:** it records the requests and the playlists, not the video segments.
- **Scripts over 5 MB:** the rest is cut and marked `"truncated": true`.
- **API replies over 1000 KB:** cut at the Options limit.
- **WebAssembly decryptors:** the `.wasm` file is a request in `networkLog`, but its code isn't readable from the recording.
- **What happened before Start:** start recording first, then load the page.
- **A page's changes after the snapshot limit:** auto-snapshot keeps up to 4 per page address; take a manual snapshot for anything later.
- **Working code on its own:** Gen Extractor writes a starting point. A real resolver for a protected player still needs reading and testing by hand.
