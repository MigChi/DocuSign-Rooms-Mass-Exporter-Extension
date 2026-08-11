# Docusign Rooms Mass Exporter

A Manifest V3 Chrome extension that bulk-exports documents from a Docusign
Rooms account. It automates the same manual steps a human would take —
open a room's Documents page, Select All, Download, wait for the ZIP —
across as many rooms as you point it at, with a date-range filter to
control batch size, a resumable job that survives interruptions, and a
CSV report of exactly what happened to every room.

Built to make bulk exports practical at **10,000+ rooms**, a scale where
naive single-tab/fixed-delay approaches become impractical (the original
design's runtime projected to 55-70 hours). The full reasoning behind
every architectural decision — including the ones that were later
reversed or corrected once real testing exposed a wrong assumption — is
documented in [`Docusign rooms download/Claude Code/DESIGN.md`](Docusign%20rooms%20download/Claude%20Code/DESIGN.md).

## Features

- **Auto-scan the Rooms list** — auto-switches to List View and
  auto-selects the "Created (Oldest)" sort before scanning (both
  required for the date-range logic to work; the extension refuses to
  scan and explains why if either can't be set automatically).
- **Manual From/To date range** — controls batch size per run without
  editing code.
- **Scan & Export List (CSV)** — a dry-run mode: scans and saves a CSV
  of what would be processed, without downloading anything.
- **Upload CSV to Run/Resume** — skip the live scan entirely by feeding
  in a previously exported CSV. Uploading a *download report* from an
  interrupted run automatically resumes it: rooms already marked
  `Downloaded` are skipped, everything else (including rooms the run
  never even reached) is re-queued.
- **Start/Stop and Pause/Resume**, each a single toggle button whose
  label and color are driven by the extension's actual live state, not
  guessed from the last click.
- **Persistence across interruptions** — progress is checkpointed to
  `chrome.storage.local` as the run progresses. If Chrome kills the
  extension's background service worker mid-run (an expected, not rare,
  event for Manifest V3 — see `DESIGN.md`), the next time it wakes up it
  picks the job back up instead of losing it.
- **Per-room download pipeline** — Select All, Bulk Download, confirm
  modal, wait for the ZIP to actually start downloading — all driven by
  real page-state signals rather than fixed timers. Empty rooms are
  detected and skipped in under a second instead of waiting out a full
  timeout.
- **Download report CSV** after every run (or Stop) — one row per room
  that was ever queued, with its outcome (`Downloaded`, `Failed`,
  `Download Error`, or `Waiting` for anything not yet reached), reason,
  saved filename, and timestamp.
- **Docusign-styled floating panel** — appears on any Rooms page,
  reflects the run's live status regardless of which tab is doing the
  processing.

## Install

1. Unzip this folder (or clone the repo).
2. Go to `chrome://extensions`.
3. Turn on Developer Mode.
4. Click **Load unpacked**.
5. Select the `Docusign rooms download` folder (the one containing
   `manifest.json`).

## Usage

1. Go to the main Docusign Rooms list page and let it load.
2. Use the floating panel at the bottom-right.
3. Set a **From** and **To** date to control which rooms get included.
4. Optional: click **Scan & Export List (CSV)** first to preview what
   would be processed, with no downloads triggered.
5. Click **Start** to scan, confirm the room count, and begin
   processing — or click **Upload CSV to Run/Resume** to skip the scan
   and run from (or resume) a CSV instead.
6. Use **Pause/Resume** or **Stop** as needed. If Chrome asks to allow
   multiple downloads, click Allow.
7. When the run finishes or is stopped, a CSV report is saved
   automatically — see Output below for where.

## Output

| What | Where |
|---|---|
| Each room's documents | `Downloads/Docusign Rooms/<Room Name>/<Room Name>.zip` |
| Scan List CSV (from "Scan & Export List") | `Downloads/Docusign Rooms/_Scan Lists/Scan List <timestamp>.csv` |
| Download Report CSV (after Start finishes or Stop) | `Downloads/Docusign Rooms/_Download Reports/Docusign Rooms Download Report <timestamp>.csv` |

The Download Report is also the file to re-upload via "Upload CSV to
Run/Resume" if a run gets interrupted.

## Project structure

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 config: permissions, content script load order, service worker registration |
| `background.js` | The service worker — queue engine, pause/resume/stop, `chrome.storage.local` persistence, CSV report generation, download-folder routing |
| `content/utils.js` | Shared string/URL/CSV helpers with no DOM dependency — loaded by the other content scripts *and* by `background.js` via `importScripts()`, since a service worker and content scripts run in separate JS contexts and can't otherwise share code |
| `content/scan.js` | Rooms-list scanning: scrolling, row parsing, date-range filtering, forcing List View/oldest-first sort |
| `content/room.js` | Room-page helpers (currently just reading the room name from its Details page) |
| `content.js` | The floating panel UI, and the single-room download pipeline (Select All → Bulk Download → confirm → wait) |
| `popup.html` / `popup.js` | Leftover from the original 1.0.2 toolbar popup — unused since the in-page panel replaced it; not referenced by `manifest.json`, kept for reference only |
| `Claude Code/DESIGN.md` | The full architecture and decision-by-decision case study |

## Architecture & Design

The short version: this extension automates 10,000+ independent,
variable-cost tasks (documents-per-room varies a lot), which makes it an
**embarrassingly parallel** workload best served by a shared work queue
rather than a static split — Manifest V3's single-threaded service worker
gives that queue a natural critical section with no explicit locking
needed. Persistence is built around the fact that MV3 service workers are
*deliberately* ephemeral (Chrome can and will kill this one mid-run), not
treated as an edge case. Every fixed `sleep()` in the original design was
replaced with either a real event or a timeout sized to what's actually
being waited for.

None of that was assumed upfront — `DESIGN.md` walks through each
decision in the order it was actually made, including the official
Docusign REST API path that was seriously considered and rejected (blocked
by an account-permissions boundary, not a technical one), and several
"critical correction" entries where live testing disproved an earlier
assumption and the fix — plus the reasoning for it — is recorded rather
than silently rewritten into the original text.

## Roadmap

Everything below is genuinely unbuilt, not just untested. They build on
each other in this order:

1. **Multi-tab worker queue** — currently one tab processes rooms
   strictly sequentially. The design for this (a shared queue with
   concurrency-safe claiming) is already worked out in `DESIGN.md`
   (Decisions 2 & 3) but not yet implemented in code.
2. **Per-room live status in the panel** (queued/in-progress/done/
   failed/empty) — only meaningful once there's more than one worker
   tab to show statuses for.
3. **Adaptive worker-tab count** — a suggested concurrency level based
   on measured time-per-room, within safe min/max bounds. Depends on
   real timing data from #1.

## Development Process

This project was built through an ongoing conversation with Claude
(Anthropic's Claude Code), with the two roles kept deliberately
separate and documented as they changed rather than blurred together:
the scanning and date-range-filtering logic (the parts requiring the
most design judgment) were written and debugged by hand; CSV export,
manifest wiring, and everything from that point forward were written by
the AI under human review and direction — a deliberate choice made
under real time pressure, not a quiet drift. The full account, including
exactly which bugs were caught by which side of that process, is in
`DESIGN.md`'s "Development Process: Human-Authored, AI-Guided" section.

---

## Version History

Detailed build log, preserved in full for anyone who wants the blow-by-blow
of how this was built — Features/Usage above reflect the current state;
this section is the historical record underneath it.

### Version 1.0.2 (original release, by jannelthetech)

Clicking the Chrome extension icon opened a popup with Start, Pause,
Resume, and Stop controls.

If the popup said it couldn't start:
1. Open the main Docusign Rooms list page.
2. Refresh the Docusign page.
3. Click the extension icon again.
4. Click Start.

### Version 2.0 (rewrite by Miguel Chica)

A major reorganization and rewrite, aimed at making bulk exports
practical at 10,000+ rooms instead of a few dozen.

- Removed the toolbar popup (Start/Pause/Resume/Stop) added in 1.0.2.
  Its Start button sent a message (`DS_COLLECT_AND_START`) that
  `content.js` never actually listened for, so clicking Start from the
  popup always failed with "Could not start." The floating in-page
  panel was the only control surface that ever worked correctly, so
  it's now the only one. `manifest.json` no longer declares
  `action.default_popup`; `popup.html`/`popup.js` remain in the folder
  but are unused.
- **Build Step 1: scanning, filtering, list export** (tested in
  isolation before any download logic was touched):
  - Split the scanning/utility code out of `content.js` into three
    focused files: `content/utils.js` (shared, no-DOM-context
    string/URL helpers), `content/scan.js` (the Rooms-list
    scan/scroll flow), and `content/room.js` (room-page-only helpers).
    Grouped by actual dependency relationships, not by where the code
    originally happened to be pasted.
  - Replaced the old generic `getRoomCardsAndLinks` (which climbed the
    DOM from any `a[href]` and guessed the room name from surrounding
    text) with a version built on confirmed `data-qa` selectors read
    directly off the live page: `tr[data-qa="room-list-row"]`,
    `strong[data-qa="room-name"]` (using its untruncated `title`
    attribute), and `strong[data-qa="room-date"]`. Each room also
    carries a parsed `createdDate`, used by date-range filtering.
  - Replaced the heuristic `findBestScrollContainer` (which scanned
    every `div`/`main`/`section`/`body`/`html` guessing which one
    scrolls) with `getScrollContainer`, a one-line function reflecting
    a DevTools-confirmed fact rather than a guess: this page has no
    internally-scrolling wrapper at all, it's plain document scrolling.
  - Added date-range filtering to the scan. Rooms before the range are
    skipped without stopping the scan; once several consecutive rooms
    are found past the end date, scrolling stops entirely (valid only
    because the list is sorted oldest-first — see the sort-order fix
    below).
  - Registered `content/utils.js`, `content/scan.js`, and
    `content/room.js` in `manifest.json`'s `content_scripts` array in
    dependency order, with `content.js` loading last.
  - Added CSV export of the scanned/filtered room list: a "Scan &
    Export List (CSV)" button separate from Start (so it could be
    tested without touching the download pipeline), a
    `DS_EXPORT_SCAN_LIST` message, and a `background.js` handler
    saving to `Downloads/Docusign Rooms/_Scan Lists/`.
  - Replaced the last of the guesswork in single-room processing
    (`processCurrentRoom`) with selectors confirmed against captured
    room-page markup: `selectAllDocuments()` now clicks
    `input[data-qa="select-all-docs"]` directly; empty rooms are
    detected instantly by reading `[data-qa="group-name"]`'s document
    count instead of waiting out the full 45-second Select All timeout;
    the final download confirmation targets the modal's own form ID
    (`#formDownloadDocuments button[type="submit"]`) with an actual
    wait instead of a fixed `sleep(3500)` guess.
  - **Fixed a critical bug in the date-range scan:** the skip/collect/
    stop logic assumed the room list is always sorted oldest-first, but
    the sort direction turned out not to be a fixed account setting — a
    later check showed it set to "Created (Newest)" instead, which
    would silently return zero rooms under that scan logic. Fixed by
    reading the sort dropdown's actual label
    (`getSortLabel()`) before scanning and refusing to proceed —
    reporting the problem through the status line — unless it reads
    exactly "Created (Oldest)".
  - **Fixed a second scan bug found during real-account testing:** the
    Rooms list has two view modes (Grid and List); scanning only ever
    knew how to read List View's markup, so scanning while in Grid View
    silently returned 0 rooms. `ensureListView()` now forces List View
    at the start of every scan, and `ensureOldestSort()` auto-selects
    the correct sort order (a custom `role="listbox"` popover, not a
    native `<select>`) — both with the existing guards still refusing
    to proceed and explaining why if either doesn't stick.
  - **Fixed the actual blocker on single-room downloads:** every live
    test failed with "Bulk download button was not found," which
    looked like a selector problem but wasn't — the selector was
    already correct. The real cause: `checkbox.click()` on the Select
    All input was being silently reverted by the page (most likely
    because `.click()` produces an untrusted `isTrusted: false` event,
    and the site's custom checkbox component only applies real user
    clicks), so nothing ever actually got selected and the bulk-actions
    toolbar never appeared. `selectAllDocuments()` is now `async` and
    tries multiple interaction strategies — a click on the checkbox's
    associated `<label>` (confirmed via live testing to be the one that
    actually works, since the page's real click handler is bound to the
    label, not the input) with a manually dispatched `MouseEvent` as
    fallback — verifying success by checking the real DOM state instead
    of assuming success just because a checkbox element existed.
  - **Sped up per-room processing**, confirmed faster in live testing:
    trimmed `selectAllDocuments()` to lead with the confirmed-working
    strategy instead of always wasting time on one that never works on
    this page; replaced three fixed sleeps in `background.js`'s
    `runQueue()` (totaling ~10.5s of pure guessing per room) with real
    signals — `processCurrentRoom()`'s own readiness polling instead of
    a redundant pre-wait, and `waitForDownloadStart()` polling the real
    `chrome.downloads.onDeterminingFilename` event instead of a flat
    guess.
  - **Fixed Stop/Pause only being checked once per room instead of
    during it:** these flags were only checked at the very top of the
    room loop, so clicking Stop mid-room did nothing until that room's
    entire pipeline finished (up to roughly a minute worst case).
    Added checks after the tab-load wait and after a room's processing
    response comes back, so Stop/Pause take effect within a room
    instead of only between rooms. (One real remaining limit: while
    the content script is actively mid-room, `background.js` is
    blocked on that one message call and can't interrupt it — Stop
    still waits for that single response.)
  - **System check turned up three more bugs**, none visible without
    tracing the logic: the progress counter used the raw loop index,
    which a Stop-triggered `break` skips incrementing, undercounting by
    one on an interrupted run (fixed by driving the display off
    `results.length` instead); `STATE.downloads` was never reset
    between runs, risking a stale match from a previous run (now reset
    in `DS_START_QUEUE`); the completion desktop notification was
    silently dead (`"notifications"` was never declared in
    `manifest.json`'s permissions, and the icon file it referenced
    didn't exist) — removed rather than patched, since the panel's own
    status text already covers it. The unused `"scripting"` permission
    was also removed.
  - **Deduplicated `background.js`'s copy of shared helpers**
    (`sleep`, `cleanName`, `getRoomIdFromUrl`, `roomUrlToDocumentsUrl`)
    — identical logic to `content/utils.js`, kept as a hand-maintained
    second copy only because a service worker can't reach content
    script globals directly. Fixed with `importScripts("content/utils.js")`,
    after confirming the two `window`-dependent fallback paths inside
    those functions are unreachable from how `background.js` actually
    calls them.
  - **Manual date range** replaces the hardcoded scan constants — the
    panel now has From/To date inputs read by both "Scan & Export" and
    "Start", instead of requiring a code edit to change batch size.
  - **Panel UI redesign**: white background, black text, Docusign's
    signature yellow (`#ffcc22`) as the single accent color, replacing
    the original dark placeholder theme.
  - **Renamed** to Docusign Rooms Mass Exporter throughout.
  - **Merged Start/Stop and Pause/Resume into two toggle buttons**
    instead of four separate ones, each driven by the extension's
    actual live state rather than guessed from the last click.
    Pause/Resume is disabled whenever nothing is running.
  - **Persistence via `chrome.storage.local`**: the resumable state
    (queue, index, results, paused, startedAt) is snapshotted at every
    point that changes it, and a startup check in `background.js`
    resumes a job that was still running when the service worker's
    memory was lost. Two accepted limitations: resume only fires the
    next time something wakes the service worker (not instantly on
    crash), and a crash landing mid-room can cause that one room to be
    reprocessed (`conflictAction: "uniquify"` means the worst case is a
    duplicate ZIP, not lost data). Full reasoning in `DESIGN.md`'s
    Decision 6.
  - **CSV upload as a second, more durable resume path**, independent
    of `chrome.storage.local` (which doesn't survive a cleared profile
    or a different computer): "Upload CSV to Run/Resume" reads either
    exported CSV back in via a hand-written `parseCsv()`, skips the
    live scan, and — for a download report — automatically drops rows
    already marked `Downloaded`.
  - **Fixed the download report only covering rooms that were actually
    reached:** it was built from `STATE.results`, which only gets an
    entry once a room is processed, so a run stopped partway through
    produced a report where every untouched room was silently absent
    rather than marked pending — breaking the CSV-upload resume path
    for exactly the scenario it exists for. Fixed by walking
    `STATE.queue` (the full original list) instead, writing
    `Status: "Waiting"` for anything without a real result yet.
  - **Fixed a progress-counter glitch**: the counter added `+1` while a
    run was active to show "currently on room N," but since `running`
    stays `true` for the rest of the loop iteration after a room's
    result is recorded, the `+1` fired a second time on the room that
    had just finished — jumping the counter one room ahead of reality
    until the next room actually started. Simplified to a strictly
    monotonic "rooms completed" count.

---

## Credits

Created by Miguel Chica.

Versions 1.0.x (original release, through the popup feature) were
created by jannelthetech. Version 2.0 onward is a substantial rewrite
and reorganization by Miguel Chica, built on top of that original
extension.
