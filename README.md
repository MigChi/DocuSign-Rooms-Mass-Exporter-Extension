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

**Status: feature-complete.** Confirmed working at real scale (an
8000-room production run), including crash/service-worker-restart
recovery. The one item left on the [Roadmap](#roadmap) below —
suggesting a worker-tab count instead of only accepting a manual one —
is a nice-to-have refinement, not a gap in core functionality.

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
  `Downloaded` are preserved as-is (not re-run, but still counted in the
  new report), everything else (including rooms the run never even
  reached) is re-queued.
- **Start/Stop and Pause/Resume**, each a single toggle button whose
  label and color are driven by the extension's actual live state, not
  guessed from the last click. Controls scanning too, not just the
  download run — useful at real scale, where a scan across thousands of
  rooms can take several minutes on its own. Scan-phase Stop/Pause only
  apply within the current page session (not crash-persistent the way
  the download run's are), and a stopped scan's partial results are
  still used, not discarded.
- **Concurrent multi-tab processing** — a pool of worker tabs (1-8,
  user-configurable via the panel's "Worker Tabs" field, default 3)
  claim rooms from a shared queue independently, with no explicit
  locking: the claim itself is a single synchronous step, safe because
  the extension's background service worker is inherently
  single-threaded. A worker tab dying mid-run (closed, crashed, or
  reclaimed by Chrome) is detected and replaced automatically.
- **Persistence across interruptions** — progress is checkpointed to
  `chrome.storage.local` as the run progresses, and resume is computed
  as "whatever doesn't have a result yet" rather than a saved position -
  safe even if several tabs had rooms claimed-but-unfinished at the
  moment of a crash. If Chrome kills the extension's background service
  worker mid-run (an expected, not rare, event for Manifest V3 — see
  `DESIGN.md`), the next time it wakes up it picks the job back up
  instead of losing it.
- **Per-room download pipeline** — Select All, Bulk Download, confirm
  modal, wait for the ZIP to actually start downloading — all driven by
  real page-state signals rather than fixed timers. Empty rooms are
  detected and skipped in under a second instead of waiting out a full
  timeout.
- **Organized by year** — each room's ZIP saves to `Docusign Rooms/<Year
  the room was created>/<Room Name>/<Room Name>.zip`, using the same
  "created" date already captured during scanning and used for the
  From/To filter, not the date you happened to run the download. A room
  with no usable created date (only possible from an older-format CSV
  upload) falls into an `Unassigned` folder rather than being silently
  misfiled or dropped. See `DESIGN.md` Decision 25.
- **An `Unassigned` catch-all for what genuinely can't be placed** — a
  room with no usable created date lands here (above), and separately, a
  real Docusign document download that couldn't be matched to any tracked
  room lands as a flat file directly under `Docusign Rooms/Unassigned/`
  instead of silently escaping the folder structure to Chrome's own
  default download location. Scoped narrowly on purpose — only a download
  whose URL actually looks like a Docusign document is ever redirected
  this way; anything else (an unrelated download from some other tab,
  this extension's own CSV report exports) is left completely alone. See
  `DESIGN.md` Decision 27.
- **Download report CSV** after every run (or Stop) — one row per room
  that was ever queued, with its outcome (`Downloaded`, `Complete
  (Empty)` for a room with nothing to download, `Failed`, `Download
  Error`, or `Waiting` for anything not yet reached), reason, saved
  filename, and timestamp. `Downloaded` and `Complete (Empty)` rooms are
  both skipped (not re-run) if this report is re-uploaded via "Upload
  CSV to Run/Resume". The status line at the end of a run is honest about
  what's left too — a flat "Done" only shows once every room is actually
  `Downloaded` or `Complete (Empty)`; otherwise it says exactly how many
  rooms still need attention.
- **Verifies before re-downloading** — a room marked `Success/Attempted`
  had a download genuinely triggered, just never confirmed complete, and
  sometimes it actually did finish (the confirmation event was never
  recorded — a tab closed right after triggering it, or the browser
  restarted before Chrome reported it done). Before re-processing such a
  room — both automatically before the very first report is written, and
  again on any CSV-upload resume — the extension checks Chrome's own
  download history for a real, completed, still-existing file matching
  that room, and skips re-downloading it if one's found, avoiding a
  genuine duplicate ZIP. `Failed` rooms are never checked this way, since
  nothing was ever downloaded for them in the first place. See `DESIGN.md`
  Decision 26.
- **Standalone panel window** — opened via the toolbar icon, independent
  of any Docusign tab. Reflects the run's live status (including which
  rooms are actively processing across all worker tabs) regardless of
  which tab is doing the processing, and survives a Docusign page
  refresh or switching tabs — the original in-page panel died on both.
  Scanning still requires an actual Docusign tab (it's DOM automation),
  so the panel relays scan requests to it and back; see `DESIGN.md`
  Decision 24 for the full message-relay design.
- **Per-worker-tab status breakdown** — the panel shows a live row per
  worker tab ("Worker 1: Room Name · 12s", "Worker 2: idle") plus a
  results-by-outcome tally (Downloaded / Failed / Errors / Waiting)
  updated as the run progresses, instead of only an aggregate count.

## Install

1. Unzip this folder (or clone the repo).
2. Go to `chrome://extensions`.
3. Turn on Developer Mode.
4. Click **Load unpacked**.
5. Select the `Docusign rooms download` folder (the one containing
   `manifest.json`).

## Usage

1. Go to the main Docusign Rooms list page and let it load.
2. Click the extension's toolbar icon to open the panel — a standalone
   window, not part of the page, so it stays put through refreshes and
   tab switches.
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
| Each room's documents | `Downloads/Docusign Rooms/<Year Created>/<Room Name>/<Room Name>.zip` |
| Scan List CSV (from "Scan & Export List") | `Downloads/Docusign Rooms/_Scan Lists/Scan List (<date range>) <timestamp>.csv` |
| Download Report CSV (after Start finishes or Stop) | `Downloads/Docusign Rooms/_Download Reports/Docusign Rooms Download Report (<date range>) <timestamp>.csv` |
| Activity Log CSV (after Start finishes or Stop) | `Downloads/Docusign Rooms/_Activity Logs/Activity Log (<date range>) <timestamp>.csv` |

`<Year Created>` is the room's own created date (or `Unassigned` if
that's ever unavailable), not the date you ran the download — see
`DESIGN.md` Decision 25. The three CSV report categories themselves stay
flat under `_Scan Lists`/`_Download Reports`/`_Activity Logs`, not
year-organized — only the room ZIPs are.

All three filenames include the scan's From/To date range (e.g.
`(2026-01-01 to 2026-03-01)`) so they're identifiable without opening
them — useful after several test/production runs pile up in the same
Downloads folder. The `(<date range>)` segment is omitted for a run
started via "Upload CSV to Run/Resume" instead of a live scan, since
that path has no date range to begin with (falls back to the plain
`<name> <timestamp>.csv` form these exports always used). The Download
Report is also the file to re-upload via "Upload CSV to Run/Resume" if a
run gets interrupted. The Activity Log is the same worker/service-worker
lifecycle history shown in the panel's Activity Log (see `DESIGN.md`'s
Decision 15) — service worker restarts, why resume did or didn't
proceed, worker tabs dying and being replaced — saved to a file so it
doesn't only exist in a panel that scrolled past its cap or a job that's
already been cleared.

## Testing

Automated tests cover the project's pure logic (string/URL/CSV helpers,
queue claiming, folder-name collision handling, download-to-room
matching) — not the DOM-driving/browser-orchestration code, which is
still verified by live testing against a real account, as it always has
been. See `DESIGN.md`'s [Decision 13](Docusign%20rooms%20download/Claude%20Code/DESIGN.md#decision-13-automated-testing-strategy)
for the reasoning behind what is and isn't covered this way.

Requires [Node.js](https://nodejs.org) (v18+; built with v24 LTS) — no
other dependencies, no `npm install` needed:

```
cd "Docusign rooms download"
npm test
```

## Project structure

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 config: permissions, content script load order, service worker registration |
| `background.js` | The service worker — queue engine, pause/resume/stop, `chrome.storage.local` persistence, CSV report generation, download-folder routing |
| `content/utils.js` | Shared string/URL/CSV helpers with no DOM dependency — loaded by the other content scripts *and* by `background.js` via `importScripts()`, since a service worker and content scripts run in separate JS contexts and can't otherwise share code |
| `content/scan.js` | Rooms-list scanning: scrolling, row parsing, date-range filtering, forcing List View/oldest-first sort |
| `content/room.js` | Room-page helpers (currently just reading the room name from its Details page) |
| `content.js` | DOM automation only — the single-room download pipeline (Select All → Bulk Download → confirm → wait) and the scan relay (`DS_BEGIN_SCAN`/`DS_SCAN_STOP`/`DS_SCAN_PAUSE`/`DS_SCAN_RESUME`) that lets the standalone panel trigger and control a scan it has no DOM access to run itself |
| `panel.html` / `panel.js` | The standalone control panel window (opened via the toolbar icon), replacing the old in-page panel that used to live inside `content.js` — see `DESIGN.md` Decision 24 |
| `package.json` | Just a `test` script (`node --test`) — no dependencies, not part of the loaded extension, exists purely so `npm test` works |
| `tests/utils.test.js` | Tests for `content/utils.js`'s pure helpers |
| `tests/background.test.js` | Tests for `background.js`'s pure/`STATE`-driven logic, including regression tests for several real bugs found via live testing at scale (see `DESIGN.md`) |
| `tests/helpers/` | Minimal `chrome.*` stub and a fresh-module-load helper, both test-only — see `DESIGN.md`'s Decision 13 |
| `Claude Code/DESIGN.md` | The full architecture and decision-by-decision case study |

## Architecture & Design

The short version: this extension automates 10,000+ independent,
variable-cost tasks (documents-per-room varies a lot), which makes it an
**embarrassingly parallel** workload — implemented as a shared work queue
that a pool of worker tabs claim from concurrently, rather than a static
split. Manifest V3's single-threaded service worker gives that queue a
natural critical section with no explicit locking needed: the claim
itself is one synchronous function with no `await` inside it. Persistence
is built around the fact that MV3 service workers are *deliberately*
ephemeral (Chrome can and will kill this one mid-run), not treated as an
edge case — and resume is computed as "whatever doesn't have a result
yet" rather than a saved position, which matters once several tabs can
each have a room claimed-but-unfinished at the moment of a crash. Every
fixed `sleep()` in the original design was replaced with either a real
event or a timeout sized to what's actually being waited for.

None of that was assumed upfront — `DESIGN.md` walks through each
decision in the order it was actually made, including the official
Docusign REST API path that was seriously considered and rejected (blocked
by an account-permissions boundary, not a technical one), and several
"critical correction" entries where live testing disproved an earlier
assumption and the fix — plus the reasoning for it — is recorded rather
than silently rewritten into the original text.

## Roadmap

Multi-tab processing (Decisions 2 & 3 in `DESIGN.md`) is done — a pool of
worker tabs claim rooms from a shared queue concurrently, with
persistence reworked to stay crash-safe under concurrency (see `DESIGN.md`
Decision 6's corrections). The panel now shows a live per-worker-tab
breakdown and a results-by-outcome tally (`DESIGN.md` Decision 14), a
Node-based automated test suite covers the project's pure logic
(Decision 13), and the worker-tab count is user-configurable within
bounds (1-8, Decision 17) instead of a hardcoded constant. One item
remains:

1. **Adaptive worker-tab count suggestion** — Decision 17 added the
   *manual, bounded* half of this (a number field, clamped 1-8); what's
   still missing is *suggesting* a value based on measured time-per-room
   rather than just accepting whatever the user enters. Real timing data
   to build this against now exists, since concurrent processing is live.

Also open, not yet scoped as a real feature: a full per-*room* (not just
per-worker-tab) status breakdown covering all 10,000+ rooms in a run
would need pagination/virtualization to stay usable in a 320px panel —
a bigger feature than the per-worker breakdown above, and not currently
planned.

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

## Development Phases

A scannable map of *when* things were built and *what broke along the way*,
before diving into the full blow-by-blow in Version History below. Phase
numbering matches `DESIGN.md`'s [Final Build Plan](Docusign%20rooms%20download/Claude%20Code/DESIGN.md#final-build-plan-deliberately-risk-ordered)
and [Current Implementation Status](Docusign%20rooms%20download/Claude%20Code/DESIGN.md#current-implementation-status)
tables, which is the canonical source of truth for status — this table is a
summary of it, not a second copy that can drift.

| Phase | Goal | Status | Issues hit during this phase |
|---|---|---|---|
| 0. Baseline audit | Understand the original 1.0.2 extension before changing anything | Done | Runtime for 10,000 rooms projected to 55-70 hours (single tab, ~11.5s of fixed sleeps per room) — the number that motivated the whole rewrite. Toolbar popup's Start button was already silently broken (`DS_COLLECT_AND_START` had no listener). |
| 1. Scanning, date-range filtering, list export | Read the Rooms list reliably and cheaply, before touching any download logic | Done | Two DOM-shape heuristics (`getRoomCardsAndLinks`, `findBestScrollContainer`) replaced with confirmed `data-qa` selectors. Sort order assumed "oldest first" turned out not to be a fixed account setting — a session found it set to "Newest," which would've silently returned zero rooms; fixed with a runtime check that refuses to scan otherwise. Scanning only worked in List View, not Grid View, until `ensureListView()` was added. A hand-wired `manifest.json` bug (`"utils.js"` instead of `"content/utils.js"`) would've failed to load every content script. |
| 2. Single-room download pipeline, event-driven waits | Replace fixed sleeps with real signals; get one room's Select All → Download → confirm flow fully reliable | Done | The real blocker wasn't a selector — `checkbox.click()` on Select All was silently reverted by the page (untrusted synthetic click), so the bulk-actions toolbar never appeared; fixed by clicking the associated `<label>` instead, verified against real DOM state rather than assumed. The final download confirmation button had no `data-qa` at all (an older jQuery modal bolted onto the React UI); fixed with a selector scoped to the modal's own form ID. |
| 3. Panel UI + Start/Stop/Pause/Resume | A single always-visible control surface reflecting real state | Done, later extended with a per-worker-tab breakdown (phase 5b) | The original toolbar popup was removed entirely rather than fixed, since the in-page panel already worked and having two half-working control surfaces was worse than one working one. |
| 4. Persistence & resume | Survive Chrome killing the (deliberately ephemeral) MV3 service worker mid-run | Done, then reworked in phase 5 | Early version resumed from a saved queue *index* — safe only because single-tab guaranteed at most one claimed-but-unfinished room at a time. The CSV-upload resume path initially dropped already-`Downloaded` rows instead of preserving them, losing the record of everything already completed. The download report itself only covered rooms actually reached, silently omitting anything still queued when a run stopped. |
| 5. Multi-tab worker pool (concurrency) | Multiple tabs claiming from one shared queue, without a mutex | Done, fixed tab count | The index-based resume from phase 4 became actively unsafe under concurrency (could silently drop claimed-but-unfinished rooms) — replaced with "resume = queue minus anything with a result." A synchronous "already running" guard had a race window an `await` earlier had left open. Downloads stopped registering at all under concurrency; first suspected `active: false` on worker tabs, but the same symptom persisted after reverting it — the real cause was worker tabs' downloads opening in a `target="_blank"` browsing context, so `DownloadItem.tabId` never matched the tab that triggered it. The first fix's regex matched `/rooms/<id>/` but the real download URL used DocuSign's internal `/transaction/<id>/` path. Once folder routing worked again, two distinct rooms sharing the same display name were found silently merging into one folder. |
| 5a. Automated testing | Cover the project's pure logic with a real test suite, without pretending DOM/timing-heavy code can be unit tested | Done — 78 tests as of phase 5h, `node:test`, growing as new pure logic is added | This machine had no Node/npm/Homebrew installed at all; installed Node's official `.pkg` via a GUI admin-privileges prompt (`osascript ... with administrator privileges`) since this environment's shell has no interactive `sudo`. `content/utils.js` and `background.js` were never written to be `require()`-able (plain globals / `importScripts()`, by design) - solved with guarded export tails that are no-ops in the real browser/service-worker runtime. |
| 5b. Per-worker-tab status breakdown | Show which worker tab has which room, and a results-by-outcome tally | Done | `currentRooms` was already sent to the panel but had its tab-ID keys flattened away by `Object.values()`; `workerTabIds` (needed to label rows "Worker 1/2/3") wasn't sent at all. Both fixed by sending more of what `background.js` already had, not by inventing new tracking. |
| 5c. 10k-scale readiness pass | Stress-test the assumptions behind "designed for 10,000 rooms" instead of just trusting the architecture | Done, persistence and dead-tab recovery confirmed live | A dead worker tab had no recovery mid-run - confirmed live by closing one (twice, including two at once), now fixed and confirmed working. The real persistence test (deliberately killing the service worker via `chrome://serviceworker-internals`, then reopening a Rooms tab) **succeeded** - confirmed twice in one session, each restart correctly resuming with a decreasing pending-room count. A stuck "Exporting CSV..." status was traced to a stale content script after an extension reload (`DESIGN.md` Decision 16) and fixed. Two risks flagged here as still open were resolved by real-scale testing later, not left open: the report-timing race (rooms that finished downloading but still showed "stuck in progress") was fixed in phase 5g; `chrome.storage.local`'s ~10MB quota (no `unlimitedStorage` permission declared) held up fine through the 8000-room run in phase 5f onward, though it remains untested at the very top of the 10k+ range this was designed for. |
| 5d. Configurable worker-tab count | Manual, bounded control over concurrency (1-8), ahead of the fuller adaptive-suggestion version in phase 6 | Done | A first version of the validation function silently mishandled `null`/empty input as "the number zero" (via `Number(null) === 0`) instead of "no value provided" - caught by the tests written for it, before it ever reached live testing. A second, more consequential bug - `ensureWorkerTabs()` never *shrinking* the tab pool, so lowering the count between two runs in one session silently had no effect - was found in phase 5e's code review, not live testing. |
| 5e. Pre-real-run review pass | Full code/logic/documentation/test audit before committing to a run larger than ~25 rooms | Done | Found the `ensureWorkerTabs()` shrink bug above and wrote up a live-confirmed "kept opening new tabs after Stop" fix that had shipped previously but was never documented. Found three pure helper functions (date-range labeling, worker-tab-count validation, activity-log event descriptions) sitting untested purely because they were written inside `content.js`'s closure instead of `content/utils.js` - moved, given real coverage, no functional change (44 → 53 tests). Along the way, a doc comment that accidentally contained the literal characters `*/` broke `content/utils.js`'s syntax - caught immediately by `node --check`, before it reached anything. |
| 5f. First real-scale test (8000 rooms) | Actually run the tool at something close to the 10,000-room scale it was designed for, not just a ~25-room smoke test | Found two real gaps | CSV export hung forever with no error - `encodeURIComponent()` throwing on a lone UTF-16 surrogate somewhere in 8000 real room names, outside the handler's `try` block, so `sendResponse()` never fired and the caller never knew anything was wrong. Fixed with `safeEncodeURIComponent()` plus a widened `try/catch`, and the same latent bug closed in `createReport()`/`createEventLogReport()` before it could cause an identical silent failure there. Separately: scanning had no Stop/Pause at all, fine for a 25-room test that finishes in seconds, a real gap for an 8000-room scan running several minutes - added, session-scoped (not crash-persistent like the download run's). See `DESIGN.md` Decisions 20 and 21. |
| 5g. CSV-upload resume reliability | Make Stop-then-reupload actually trustworthy, raised mid-run on the same 8000-room test | Done | A room whose ZIP was still downloading when the report was generated could show `Success/Attempted` instead of `Downloaded`, even though it finished fine seconds later - since resume only skips rows marked `Downloaded`, that room would get needlessly re-downloaded. Fixed with a bounded wait for in-flight downloads before writing the reports. Separately, empty rooms were marked `Failed` (not their own outcome), so every resume re-checked every empty room from scratch - fixed with a distinct `Complete (Empty)` status, also skipped on resume. `parseUploadedCsv()` was found to be pure and untested, sitting inside `content.js`'s closure the same way three other functions were in phase 5e - moved to `content/utils.js`, given real coverage of the exact behavior changed here. See `DESIGN.md` Decision 22. |
| 5h. Trailing-period filename bug | Diagnose "some files did not get saved to the Docusign Rooms folder" from the same 8000-room run | Done | Confirmed via the user's own console (`Unchecked runtime.lastError: Invalid filename`) and the actual Download Report CSV - 5 real rooms, all named with a street-abbreviation period (`"124 Rosman Rd."`, `"1 Landmark Sq."`, etc.), all landed in the flat Downloads root. First diagnostic pass looked at the wrong CSV column (`Downloaded Filename`, which Chrome overwrites with its own fallback name) and seemed to contradict the trailing-period theory until the *Room Name* column was checked instead. Fixed in `cleanName()` - the single function every folder/file name in this codebase passes through - plus a Windows-reserved-device-name guard added at the same time. Regression tests added using the exact 5 confirmed room names, at both `cleanName()` and `computeFolderNames()` (the function `background.js` actually calls). See `DESIGN.md` Decision 23. |
| 5i. Detached panel window | Move the control panel out of the Docusign page into its own standalone window, raised as a design problem (not a bug) once long runs made refresh/tab-switch fragility actually matter | Done | The panel and the scan it triggers structurally can't share one execution context - a standalone window has no DOM access, and scanning must run as DOM automation inside an actual Docusign tab. Solved with a message relay through `background.js` (`chrome.tabs.sendMessage` reaches a tab but not other extension pages; `chrome.runtime.sendMessage` reaches the reverse) - four hops for one logical scan request. Found two gaps via code review before calling it done, not live testing: a synchronous-guard race on `STATE.scanning` (same class of bug already fixed once for `STATE.running`), and no recovery if the Docusign tab closes mid-scan (fixed with a `chrome.tabs.onRemoved` listener and a new `DS_SCAN_FAILED` message). See `DESIGN.md` Decision 24. |
| 5j. Year-based folder organization | Route each room's ZIP into `Docusign Rooms/<Year Created>/<Room Name>/...` instead of a flat `Docusign Rooms/<Room Name>/...`, requested directly by the user | Done | Building this exposed a real, pre-existing bug: the Scan List CSV's "Created Date" column used `String(date).slice(0, 10)`, which silently produces a weekday/day fragment with no year at all on any non-UTC-midnight machine (confirmed directly: "2021-01-04" became "Sun Jan 03") - fixed with a proper `toISOString()`-based helper before building the year-folder logic on top of it, since the feature depended on that column actually being trustworthy. Collision disambiguation (the "(roomId)" suffix for two same-named rooms) was rescoped to per-(year, name) rather than per-name - two identically-named rooms created in different years no longer need it, since they're not actually sharing a folder anymore. The Download Report CSV gained its own new "Created Date" column so a CSV-upload resume still knows which year folder a re-queued room belongs in. See `DESIGN.md` Decision 25. |
| 5k. Verify-before-re-download | Stop re-uploaded CSVs from blindly re-triggering rooms that actually already finished, raised after investigating "why does it say 1085 still Waiting when the previous CSV said it was complete" | Done | Root cause of the *specific* 1085 turned out to be a run stopped ~5.5 minutes after it started (confirmed via the Activity Log's timestamps, not guessed) - not a queue bug. But the underlying complaint was real: a "Success/Attempted" room sometimes already has a real file on disk, and re-clicking Download for it risks a genuine duplicate. Fixed with `chrome.downloads.search()` (already covered by the existing "downloads" permission) matching a room's expected filename against Chrome's own download history - scoped to `Success/Attempted` only, not `Failed` (nothing was ever downloaded for a Failed room to verify), per direct correction mid-conversation. Runs automatically before the very first report is written, not only on a CSV re-upload, per a follow-up request - so the first report is already accurate instead of needing a second pass just to reconcile. The "Done" status message was also fixed to say how many rooms still need attention instead of a flat "Done" regardless of outcome. See `DESIGN.md` Decision 26. |
| 5l. "Unassigned" catch-all | Give both "can't determine a year" and "can't identify the room at all" a real landing spot instead of a silent fallback or an escape from the folder structure entirely | Done | Renamed the existing year-fallback bucket from "Unknown Year" to "Unassigned" - no logic change, just a shared name for both failure modes. The real risk was the second case: `onDeterminingFilename` fires for *every* download in the browser, not just this extension's, so routing every "unmatched" download into `Docusign Rooms/Unassigned/` would have redirected a user's unrelated download (e.g. a Gmail attachment) into this extension's folder - a worse bug than the one being fixed. Scoped narrowly: only a download whose URL actually matches the same `/rooms/<id>/`/`/transaction/<id>/` pattern `findCurrentRoomForDownload()` already checks is treated as "ours, but unidentifiable"; that existing function itself (already corrected twice - Decision 2) was left untouched rather than refactored, to avoid risking a third regression in code with that history. See `DESIGN.md` Decision 27. |
| 6. Adaptive concurrency suggestion | Suggest (not auto-apply) a worker-tab count from measured per-room timing | Not started | The bounds half of this landed early, in phase 5d - what's left is the *measured, suggested* half. Depends on real timing data, which now exists to build against. |

Every issue above is one line here and a full paragraph in either
`DESIGN.md` (the reasoning and the fix) or Version History below (the
build-log framing) — this table exists so you don't have to read either in
full just to see *where* a given problem was found and fixed.

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
  - **Multi-tab concurrent processing.** A pool of worker tabs (a
    hardcoded `WORKER_TAB_COUNT = 3` for this first pass) now claim
    rooms from a shared queue independently, per the design already
    worked out in `DESIGN.md` Decisions 2 & 3: `claimNextRoom()` is a
    single synchronous function (no `await` inside it) that reads and
    advances the shared claim pointer, safe without an explicit lock
    because the service worker is inherently single-threaded and can
    never truly run two workers' claims simultaneously. Each worker
    (`runWorker()`) claims, processes, and repeats independently until
    the queue is empty or Stop ends it; `STATE.currentRoom` (one room)
    became `STATE.currentRooms` (keyed by tab ID, since several rooms
    are now genuinely in flight at once).
  - **Fixed downloads never being redirected into per-room folders.**
    First suspected cause: worker tabs navigating with `active: false`
    (added to stop several tabs fighting over focus), on the theory that
    Chrome's protection against a page silently triggering multiple
    downloads was dropping background-tab-triggered ones - `Download ID`
    stayed empty and status never advanced past `Success/Attempted` for
    every room. Reverting to `active: true` didn't fix it - the exact
    same symptom persisted, with files confirmed landing directly in the
    flat Downloads root. The real cause: the download-confirmation
    form is `<form ... method="post" target="_blank" ...>`, so submitting
    it opens a **new browsing context** to receive the response - the
    resulting download's tab ID belongs to that new tab, never the
    worker tab that triggered it, so looking it up in `STATE.currentRooms`
    by tab ID never matched anything. Fixed with `findCurrentRoomForDownload()`,
    which falls back to parsing a room ID out of the download's own URL
    when the tab-based lookup fails - and confirmed via a diagnostic
    `console.warn` that a real download's `referrer` is empty and its
    `url` uses DocuSign's internal `/transaction/<id>/...` path, not
    `/rooms/<id>/...` like the room's own page - the first version of
    this fix matched only `rooms` and silently missed the ID anyway.
    All three attempts (the `active` red herring, the right diagnosis,
    and the regex miss) are recorded in `DESIGN.md`'s Decision 2 rather
    than only keeping the version that turned out fully correct.
  - **Fixed two different rooms with the same name silently sharing one
    folder.** Once the fix above got real downloads landing in
    `Docusign Rooms/<Room Name>/` again, a live run showed 12 attempted
    downloads but only 11 folders on disk. Cause: two distinct rooms
    (different IDs) both named "Ponchak - Listing" - folder naming was
    purely `cleanName(roomName)`, so both targeted the same folder, and
    `conflictAction: "uniquify"` only dedupes filenames within a folder,
    not the folder itself. Fixed with `computeFolderNames()`, which
    builds a `roomId -> folderName` map once per run and appends the
    room ID to the folder name only for rooms whose name actually
    collides with another room's in that run, leaving everyone else
    with a plain name. See `DESIGN.md`'s Decision 2 for the full
    writeup.
  - **Reworked the persistence model to stay crash-safe under
    concurrency.** The existing resume logic saved `STATE.index` and
    continued from it - safe under single-tab, where at most one room
    was ever claimed-but-unfinished when a crash hit. With several tabs
    claiming concurrently, `index` can already be past multiple rooms
    that were claimed but never finished at the moment of a crash;
    resuming from that saved index would have silently dropped them
    instead of retrying them. Fixed by no longer persisting `index` at
    all - `persistJob()` now saves only the full `queue` and whatever
    `results` actually exist, and resume rebuilds the working list as
    "queue filtered down to rooms with no result yet," which correctly
    catches both "never reached" and "claimed but interrupted" rooms
    without needing to tell them apart.
  - **CSV upload now preserves already-downloaded rooms instead of
    discarding their record.** Uploading a download report used to just
    drop rows already marked `Downloaded` and queue the rest, which
    meant the resumed run's own new report only covered whatever got
    reprocessed - losing the record of everything that had already
    succeeded. `parseUploadedCsv()` (replacing `roomsFromCsvRows()`) now
    splits the file into rooms still needing work and `priorResults` for
    the completed ones (full result data preserved: reason, filename,
    download ID, timestamp), and `DS_START_QUEUE` seeds the new run's
    results with them - so the final report, and the live progress
    counter during the run, reflect the true complete picture instead of
    restarting the count from zero against a shrunk total.
  - **Added an automated test suite** (`tests/`, run via `npm test`) covering
    the project's pure logic - `content/utils.js`'s string/URL/CSV helpers
    and `background.js`'s `computeFolderNames`, `csvEscape`, `nowStamp`,
    `claimNextRoom`, and `findCurrentRoomForDownload` - using Node's
    built-in `node:test`, no dependencies to install. Neither file was
    originally written to be `require()`-able (both are plain global
    function declarations, by design, for the content-script/service-worker
    runtimes they actually load in); both got a small guarded export tail
    that's a no-op in the browser and only activates under Node. Two of
    the 24 tests are direct regressions for this session's own
    `computeFolderNames`/`findCurrentRoomForDownload` bugs. This machine
    had no Node/npm/Homebrew installed at all going in - Node's official
    installer needed `sudo`, which needs an interactive terminal this
    environment doesn't have, worked around via macOS's native
    admin-privileges GUI prompt instead. Full reasoning in `DESIGN.md`'s
    Decision 13.
  - **Added a per-worker-tab status breakdown to the panel.** Previously
    the panel only showed an aggregate "N active" count and a flat list of
    room names, with no way to tell which worker tab had which room or how
    long it had been on it. `background.js` now sends `workerTabIds` (for
    stable "Worker 1/2/3" labels) and tags each `currentRooms` entry with
    its own `tabId` and a `claimedAt` timestamp; the panel renders one row
    per worker ("Worker 2: Room Name · 14s", or "idle") plus a
    results-by-outcome tally (Downloaded/Failed/Errors/Waiting) built from
    the existing results array - no new tracking, just exposing data
    `background.js` already had. Full reasoning in `DESIGN.md`'s
    Decision 14.
  - **Fixed a worker tab dying mid-run having no recovery - confirmed live
    by closing one on purpose.** `ensureWorkerTabs()` only ever checked
    tab health once, at the very start of a run; a tab dying afterward
    (closed by the user, reclaimed by Chrome, a crash) had no recovery at
    all, and since all workers claim from one shared queue, a dead-tab
    worker could burn through the remaining rooms far faster than the
    healthy ones could do real work, mass-marking a chunk of the queue
    "Failed" for a reason unrelated to those rooms. Fixed by checking tab
    liveness inside `runWorker()`'s own loop, before every claim, and
    creating a replacement tab in place if it's gone. Full reasoning in
    `DESIGN.md`'s Decision 2, fifth correction.
  - **Added a worker/service-worker lifecycle event log**, prompted by a
    live persistence test reporting "it did not resume" with no way to
    tell why. `logWorkerEvent()` records service-worker-start, why resume
    did-or-didn't proceed, and worker-tab death/replacement to
    `STATE.workerEvents` - console-logged immediately and persisted
    alongside the job specifically so a restart (the one event most worth
    seeing) doesn't also wipe the record of it. Shown in the panel under a
    collapsed "Activity Log". This is diagnostic infrastructure, not a fix
    for the resume report itself - that investigation is still open; see
    `DESIGN.md`'s Decision 15.
  - **Fixed "Scan & Export List" getting stuck on "Exporting CSV..."
    forever.** Real cause: `content.js:724` threw `Uncaught (in promise)
    Error: Extension context invalidated` - a stale content script left
    over from before the extension was last reloaded. An earlier fix
    added `.catch()` to `DS_STOP`/`DS_PAUSE`/`DS_RESUME` for this exact
    scenario but missed `DS_START_QUEUE` and `DS_EXPORT_SCAN_LIST`, both
    of which used the two-argument `sendMessage(message, callback)` form.
    First fix attempt chained `.catch()` directly onto those - wrong,
    since `sendMessage` returns `undefined` (not a Promise) when a
    callback is given, which would have thrown on every single call, a
    worse bug than the one being fixed. Caught before landing; corrected
    by converting all of them (plus the initial `DS_GET_STATUS` panel-load
    fetch, same gap) to the single-argument promise form already proven
    correct elsewhere. Immediate workaround if you ever hit this: reload
    the Docusign tab, not just the extension. Full incident in
    `DESIGN.md`'s Decision 16.
  - **The Activity Log now saves to a file too, not just the panel.**
    `createEventLogReport()` exports the full accumulated worker/service-
    worker event history to `Docusign Rooms/_Activity Logs/` alongside
    the download report, whenever a run finishes or is Stopped - the
    panel only shows the most recent 20 events and only while that tab
    stays open, so without this the diagnostic history behind a run's
    outcome couldn't be inspected after the fact.
  - **Made the worker-tab count user-configurable (1-8), replacing the
    hardcoded `WORKER_TAB_COUNT`.** A new "Worker Tabs" field in the panel
    is validated and clamped (`clampWorkerTabCount()`), persisted with the
    job so a resumed run keeps whatever count it started with, and bounded
    rather than an open number field - several 10k-scale risks are still
    under active investigation at the default of 3, and letting the count
    go arbitrarily high before those are resolved would compound the
    risks being chased rather than help isolate them. A bug in the first
    version of the validation - `Number(null)` and `Number("")` both
    evaluate to `0`, a real finite number, so missing/empty input was
    silently clamped up to the minimum instead of falling back to the
    default - was caught by the tests written for this feature, before it
    ever reached live testing. Full reasoning in `DESIGN.md`'s Decision 17.
  - **Added the scan's date range to all three exported CSV filenames**
    (Scan List, Download Report, Activity Log), e.g. `Scan List
    (2026-01-01 to 2026-03-01) 2026-08-11_16-43-05.csv` - requested after
    several same-day test runs made the Downloads folder full of files
    distinguishable only by generation timestamp. Falls back to the
    original plain-timestamp filename for a run started via CSV upload
    instead of a live scan, since that path has no date range to label
    with in the first place. Full reasoning in `DESIGN.md`'s Decision 18.
  - **Full pre-real-run review pass**, requested explicitly before
    committing to a run larger than the ~25-room tests done so far:
    code, logic, documentation, and test coverage all checked, not just
    whatever the next live test happened to surface. Found two real bugs
    by reading the code rather than running it: `ensureWorkerTabs()`
    only ever grew the worker-tab pool, never shrank it, so starting a
    *second* run with a lower Worker Tabs count than a previous one in
    the same session would silently keep using the old, larger count -
    directly undermining the feature's main intended use (dialing
    concurrency down to isolate the ongoing 10k-scale investigation).
    Also wrote up the "kept opening new tabs after Stop" fix from live
    testing, which had shipped in a prior turn but was never documented.
    Separately, found that three genuinely pure helper functions
    (`formatDateRangeLabel`, the Worker Tabs field's validation,
    `describeEvent`) were untestable purely because they'd been written
    inside `content.js`'s closure rather than `content/utils.js` -
    moved, given real test coverage, no functional change. Test suite
    grew from 44 to 53. Full reasoning, including a small self-caught
    mistake (a doc comment that accidentally contained `*/` and broke
    the file's syntax, caught by `node --check` before it reached
    anything), in `DESIGN.md`'s Decision 19.
  - **Fixed CSV export hanging forever with no error, found live on the
    first real-scale test (an 8000-room scan).** Root cause:
    `encodeURIComponent()` throws on a lone UTF-16 surrogate, which
    `DS_EXPORT_SCAN_LIST`'s handler didn't guard against - the odds of
    hitting one in a 25-room test are near zero, but real at 8000 real
    room names. Since the throw happened outside the handler's `try`
    block, `sendResponse()` was never called and the content script's
    `sendMessage()` call just hung indefinitely - it only rejects when
    the message channel itself closes, not when the other side throws
    internally. Fixed with `safeEncodeURIComponent()` (falls back to
    replacing only genuinely unpaired surrogates, preserving valid ones
    like an emoji in a room name) used everywhere a CSV becomes a
    `data:` URL, plus widening the `try/catch` to cover the whole
    handler so any future throw there is reported instead of hanging.
    The identical vulnerability in `createReport()`/
    `createEventLogReport()` was silent rather than a hang (a bare
    `.catch(() => "")` swallowed it) - now logged via a new
    `report_failed` Activity Log event instead of vanishing without a
    trace. Full reasoning in `DESIGN.md`'s Decision 20.
  - **Added Stop/Pause/Resume for scanning**, not just the download run -
    confirmed live as a real gap once scans reached real scale (an
    8000-room scan has no way to interrupt it once started, only wait
    it out). The same Start/Stop and Pause/Resume buttons now control
    whichever phase is active; scan-phase control is session-only, not
    crash-persistent like the download run's, since scanning has no
    natural checkpoint the way `chrome.storage.local`-backed run
    persistence does. A stopped scan still uses whatever rooms it had
    already collected, rather than discarding them. Full reasoning in
    `DESIGN.md`'s Decision 21.
  - **Made CSV-upload resume actually reliable**, prompted mid-run on the
    same 8000-room test: "I've seen CSVs where the room downloaded but
    the status was Success/Attempted." Two fixes. First, a report-timing
    race - `createReport()` ran the instant every worker ran out of
    rooms to claim, not once every started download had actually
    finished, so a room whose ZIP was still downloading could get
    reported as `Success/Attempted` even though it finished fine
    moments later - and since re-uploading a report only skips rows
    marked `Downloaded`, that room would get needlessly re-downloaded.
    Fixed with `waitForInFlightDownloadsToSettle()`, a bounded
    (20s-max) wait for in-flight downloads before the reports are
    written. Second: empty rooms were marked `Failed`, so every
    CSV-upload resume re-visited and re-confirmed every empty room from
    scratch - fixed with a distinct `Complete (Empty)` status that
    `parseUploadedCsv()` now also skips re-running, without adding the
    wasted 15s-download-wait that simply flipping the room to
    "succeeded" would have caused. Full reasoning in `DESIGN.md`'s
    Decision 22.
  - **Fixed some rooms silently downloading to the flat Downloads root
    instead of their own folder** - found live ("some files did not get
    saved to the Docusign Rooms folder"), confirmed by the user's own
    DevTools console showing `Unchecked runtime.lastError: Invalid
    filename` and exactly 7 misplaced files out of thousands processed.
    Root cause: `cleanName()` never stripped a trailing period or space,
    and Chrome's downloads API rejects a suggested filename whose path
    segment ends in either (a Windows rule Chrome enforces
    cross-platform) - with no error-checking on the `suggest()` call,
    the failure was completely silent, falling back to Chrome's default
    download location. Business names ending in an abbreviation ("LLC.",
    "Inc.", "Jr.") are common enough to hit this reliably at real scale
    while never showing up in small test runs. Fixed at the source in
    `cleanName()` (the one function every folder/file name in this
    codebase passes through), also guarding against Windows reserved
    device names (`CON`, `NUL`, etc.) as a related, cheap addition. A
    separate `[DSBD] Unmatched download` warning in the same console
    dump turned out to be an unrelated, already-expected symptom (the
    CSV report exports themselves triggering the same listener, not a
    second bug) - confirmed by checking the actual URL before assuming.
    Full reasoning in `DESIGN.md`'s Decision 23.
  - **Moved the control panel out of the Docusign page into a standalone
    window**, opened via the toolbar icon instead of auto-injected into
    the page - raised as a design problem, not a bug ("anytime the page
    is refreshed or it moves from tab to tab it becomes super hard to
    press any of the buttons or accurately see progress"). The download
    run itself needed no DOM access and moved cleanly; scanning
    (`autoScrollAndCollectRooms()`) does, and must still run inside an
    actual Docusign tab, so the panel now relays scan requests to it and
    back through `background.js` - `chrome.tabs.sendMessage` reaches a
    tab but not other extension pages, `chrome.runtime.sendMessage`
    reaches the reverse, so no single message can go straight from the
    panel to a content script. Long-running scans are acknowledged
    immediately and deliver their result later over a follow-up message,
    the same decoupling pattern already used for the download run itself,
    rather than holding one message channel open for several minutes.
    The original confirm()-before-starting UX is preserved unchanged.
    Two gaps found via code review (not live testing) before calling this
    done: a synchronous-guard race on the new `STATE.scanning` flag (the
    same class of bug already fixed once for `STATE.running`), and no
    recovery if the Docusign tab closes mid-scan, which would otherwise
    leave `STATE.scanning` stuck `true` forever - fixed with a
    `chrome.tabs.onRemoved` listener and a new `DS_SCAN_FAILED` message
    that resets the panel's state and shows why. Full reasoning in
    `DESIGN.md`'s Decision 24.
  - **Organized downloads by year**, requested directly: each room's ZIP
    now saves to `Docusign Rooms/<Year Created>/<Room Name>/<Room
    Name>.zip` instead of a flat `Docusign Rooms/<Room Name>/...`, using
    the room's own created date (the same one already captured during
    scanning and used for the From/To filter) rather than the date the
    download happened to run. Building this surfaced a real, pre-existing
    bug in the Scan List CSV's "Created Date" column - it used
    `String(date).slice(0, 10)`, which is not an ISO string and silently
    drops the year entirely on any non-UTC-midnight machine (confirmed
    directly: "2021-01-04" became "Sun Jan 03") - fixed with a proper
    `toISOString()`-based helper before relying on that column for
    anything. `computeFolderNames()`'s same-name collision handling was
    rescoped from per-name to per-(year, name), since two identically-
    named rooms created in different years no longer share a folder and
    don't need the `(roomId)` disambiguation suffix anymore. The Download
    Report CSV gained its own new "Created Date" column (it never had
    one) so a CSV-upload resume still knows which year a re-queued room
    belongs in. A room with no usable created date - only possible from
    an older-format CSV that predates this column - falls into an
    `Unknown Year` folder rather than being silently misfiled or dropped.
    Full reasoning in `DESIGN.md`'s Decision 25.
  - **Verify a room against Chrome's own download history before
    re-downloading it**, prompted by investigating "why does it say 1085
    still Waiting when the previous CSV said it was complete." That
    specific case traced to a run stopped ~5.5 minutes after it started
    (confirmed via the Activity Log's own timestamps) - not a queue bug -
    but the underlying complaint held up: a `Success/Attempted` room
    (download triggered, never confirmed complete) sometimes really did
    finish, and blindly re-clicking Download for it risks a genuine
    duplicate ZIP rather than fixing anything. Fixed with
    `chrome.downloads.search()` (covered by the existing `"downloads"`
    permission already declared - no manifest change) matching a room's
    expected filename against Chrome's own persistent download history,
    checking the leaf filename only so it works regardless of whether the
    real file landed under the old flat structure or the new year-folder
    one. Deliberately scoped to `Success/Attempted` only, not `Failed` -
    corrected directly mid-conversation ("don't check for the failed
    ones, only for the success/attempted") - a Failed room never had a
    download triggered, so there's nothing to verify. Runs in two places,
    the second added after a direct follow-up request ("can this be done
    before the final CSV is generated, not just on re-upload"): once
    automatically before the very first report is ever written (so it
    starts out accurate), and again on any CSV-upload resume (catching
    older reports that predate this fix). The "Done" status message was
    also fixed to report how many rooms still need attention instead of a
    flat "Done" regardless of what actually happened. Full reasoning in
    `DESIGN.md`'s Decision 26.
  - **Added an `Unassigned` catch-all**, requested directly as a
    follow-up. Renamed the existing "Unknown Year" fallback to
    "Unassigned" (no behavior change), and separately gave a real
    Docusign document download that can't be matched to any tracked room
    a landing spot inside `Docusign Rooms/Unassigned/` instead of letting
    it silently escape the folder structure to Chrome's own default
    download location. Deliberately narrow: `onDeterminingFilename` fires
    for every download in the browser, not just this extension's, so only
    a download whose URL actually matches the same Docusign
    document-download pattern `findCurrentRoomForDownload()` already
    checks gets redirected this way - anything else (an unrelated
    download from some other tab, this extension's own CSV exports) is
    left completely alone, since blindly redirecting *every* unmatched
    download would have been a worse bug than the one being fixed. Full
    reasoning in `DESIGN.md`'s Decision 27.

---

## Credits

Created by Miguel Chica.

Versions 1.0.x (original release, through the popup feature) were
created by jannelthetech. Version 2.0 onward is a substantial rewrite
and reorganization by Miguel Chica, built on top of that original
extension.
