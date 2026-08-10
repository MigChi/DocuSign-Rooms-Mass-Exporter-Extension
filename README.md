# Docusign Rooms Bulk Downloader

This Chrome extension bulk-downloads Docusign Rooms documents by automating the same manual process:
Room Documents page → Select All → Download → ZIP.

## What it does

- Auto-scrolls the Docusign Rooms list page to load all rooms.
- Collects room links.
- Opens one worker tab.
- Goes directly to each room's `/documents` page.
- Clicks Select All using the working selector:
  `[data-qa="select-all-docs-label-text"]`
- Clicks the bulk download button:
  `button[data-qa="Download"][data-dd-action-name="Bulk Action - Download"]`
- Saves every ZIP inside a folder:
  `Downloads/Docusign Rooms/Room Name/Room Name.zip`
- Creates a CSV report after it finishes:
  `Downloads/Docusign Rooms/_Download Reports/Docusign Rooms Download Report <timestamp>.csv`
- Includes Start, Pause, Resume, and Stop buttons.

## Install

1. Unzip this folder.
2. Go to `chrome://extensions`.
3. Turn on Developer Mode.
4. Click Load unpacked.
5. Select the unzipped folder.

## Use

1. Go to the main Docusign Rooms list page.
2. Let the page load.
3. Use the floating Docusign Bulk Downloader panel at the bottom-right.
4. Click Start.
5. If Chrome asks to allow multiple downloads, click Allow.

## Notes

Chrome page scripts cannot rename Docusign downloads by themselves. This extension uses the Chrome Downloads API to put each room download in its own folder and rename the ZIP.


Tiny credit line below the control buttons: created by Miguel Chica

Versions 1.0.x (original release, through the popup feature) were created
by jannelthetech. Version 2.0 onward is a substantial rewrite and
reorganization by Miguel Chica, built on top of that original extension.


## Version 1.0.2 (original release, by jannelthetech)

Clicking the Chrome extension icon now opens a popup with Start, Pause, Resume, and Stop controls.

If the popup says it cannot start:
1. Open the main Docusign Rooms list page.
2. Refresh the Docusign page.
3. Click the extension icon again.
4. Click Start.


## Version 2.0 (current - rewrite by Miguel Chica)

A major reorganization and rewrite of the extension, aimed at making bulk
exports practical at 10,000+ rooms instead of a few dozen. Full reasoning
behind every design decision below is documented in
`Docusign rooms download/Claude Code/DESIGN.md`.

Done so far:
- Removed the toolbar popup (Start/Pause/Resume/Stop) added in 1.0.2. Its
  Start button sent a message (`DS_COLLECT_AND_START`) that content.js
  never actually listened for, so clicking Start from the popup always
  failed with "Could not start." The floating in-page panel was the only
  control surface that ever worked correctly, so it's now the only one.
  `manifest.json` no longer declares `action.default_popup`; `popup.html`
  / `popup.js` remain in the folder but are unused.
- Started Build Step 1 (scanning + filtering + list export, tested in
  isolation before any download logic is touched):
  - Split the scanning/utility code out of `content.js` into three
    focused files: `content/utils.js` (shared, no-DOM-context string/URL
    helpers), `content/scan.js` (the Rooms-list scan/scroll flow), and
    `content/room.js` (room-page-only helpers). Grouped by actual
    dependency relationships, not by which file the code originally
    happened to be pasted into.
  - Replaced the old generic `getRoomCardsAndLinks` (which climbed the
    DOM from any `a[href]` and guessed the room name from surrounding
    text) with a version built on confirmed `data-qa` selectors read
    directly off the live page: `tr[data-qa="room-list-row"]`,
    `strong[data-qa="room-name"]` (using its untruncated `title`
    attribute), and `strong[data-qa="room-date"]`. Each room now also
    carries a parsed `createdDate`, needed for the date-range filtering
    step still in progress.
  - Replaced the heuristic `findBestScrollContainer` (which scanned
    every `div`/`main`/`section`/`body`/`html` on the page guessing
    which one scrolls) with `getScrollContainer`, a one-line function
    reflecting a DevTools-confirmed fact rather than a guess: this page
    has no internally-scrolling wrapper at all, it's plain document
    scrolling. The now-unreachable `try/catch` fallback around the
    scroll call (a safety net for the old heuristic possibly returning
    something without `.scrollTo`) was removed as dead code.

  - Added date-range filtering to the scan (`SCAN_DATE_START`/
    `SCAN_DATE_END` in `content/scan.js`, hardcoded constants for now -
    a UI date picker is a panel-phase task, not yet built). Rooms before
    the range are skipped without stopping the scan; once several
    consecutive rooms are found past the end date, scrolling stops
    entirely, since the list is sorted oldest-first and everything after
    is guaranteed to also be out of range.
  - Registered `content/utils.js`, `content/scan.js`, and `content/room.js`
    in `manifest.json`'s `content_scripts` array, in that dependency
    order, with `content.js` loading last. The extension is loadable
    again as of this change.
  - Added CSV export of the scanned/filtered room list: a "Scan & Export
    List (CSV)" button on the panel (separate from Start, so it can be
    tested without touching the download pipeline), a new
    `DS_EXPORT_SCAN_LIST` message, and a `background.js` handler that
    saves to `Downloads/Docusign Rooms/_Scan Lists/Scan List
    <timestamp>.csv`.
  - Replaced the last of the guesswork in single-room processing
    (`content.js`'s `processCurrentRoom`) with selectors confirmed
    against captured room-page markup:
    - `selectAllDocuments()` now clicks `input[data-qa="select-all-docs"]`
      directly instead of climbing several possible parent levels
      guessing at a clickable ancestor.
    - Empty rooms are now detected instantly by reading
      `[data-qa="group-name"]`'s document count (`"Room Docs (0)"`),
      instead of waiting out the full 45-second Select All timeout on
      every empty room - the checkbox never renders at all when there's
      nothing to select.
    - `findFinalDownloadButton()` now targets the download-confirmation
      modal's own form ID (`#formDownloadDocuments button[type="submit"]`)
      instead of text-matching every visible button on the page, and the
      fixed `sleep(3500)` guessing when that modal would appear was
      replaced with an actual wait for it.
  - **Fixed a critical bug in the date-range scan:** the skip/collect/stop
    logic assumed the room list is always sorted oldest-first, but the
    sort direction turned out not to be a fixed account setting - a later
    check showed it set to "Created (Newest)" instead. Under that
    ordering the scan would silently stop after its very first check
    (every visible room looks "too late" when scanning from newest to
    oldest) and return zero rooms, no error shown. `content/scan.js` now
    reads the sort dropdown's actual label before scanning
    (`getSortLabel()`) and refuses to proceed - reporting the problem
    through the status line instead of returning wrong results - unless
    it reads exactly "Created (Oldest)".

  - **Fixed a second scan bug found during real-account testing:** the
    Rooms list has two view modes (Grid/gallery and List), toggled by
    `button[data-qa="grid"]` / `button[data-qa="list"]`. All along,
    `getRoomCardsAndLinks()` only knew how to read List View's markup
    (`tr[data-qa="room-list-row"]`) - Grid View uses an entirely
    different card layout with no matching rows, so scanning while in
    Grid View silently returned 0 rooms. `content/scan.js` now calls
    `ensureListView()` at the start of every scan, which clicks List
    View if it isn't already active.
  - Also added `ensureOldestSort()`, which automatically opens the sort
    dropdown (a custom `role="listbox"` popover, not a native `<select>`)
    and clicks "Created (Oldest)" if it isn't already selected, using
    selectors confirmed against the opened dropdown's real markup. The
    manual instruction below is now a fallback only - the existing
    `getSortLabel()` guard still refuses to scan and reports why if the
    auto-select doesn't stick for any reason.
  - **Fixed the actual blocker on single-room downloads:** every live test
    was failing with "Bulk download button was not found," which looked
    like a selector problem but wasn't - `button[data-qa="Download"]
    [data-dd-action-name="Bulk Action - Download"]` was already correct
    and confirmed against captured markup. Console logging added to
    `selectAllDocuments()` showed the real cause: calling
    `checkbox.click()` on the Select All input left `checkbox.checked`
    at `false` and left every per-document checkbox unchecked, so the
    bulk-actions toolbar (which only renders once something is selected)
    never appeared - `findBulkDownloadButton`/the wait for it wasn't
    broken, it was correctly waiting for a button that could never show
    up. Root cause: the page cancels the checkbox's default toggle on
    click, most likely because `.click()` produces a synthetic
    (`isTrusted: false`) event and the site's custom checkbox component
    only applies the change for real user clicks. `selectAllDocuments()`
    is now `async` and tries three interaction strategies in order -
    the native checkbox `.click()`, clicking the associated
    `<label data-qa="select-all-docs-label">`, and a manually dispatched
    `MouseEvent` - verifying success after each attempt by checking
    whether any `input[data-qa="document-checkbox"]` actually shows as
    checked in the DOM, rather than assuming success just because a
    checkbox element existed and `.click()` didn't throw. This was also
    a bug in the original code independent of the click-trust issue: it
    returned `true` unconditionally whenever it found the checkbox,
    never confirming the click had any real effect.

**Before running a real scan:** the extension now auto-switches to List
View and auto-selects "Created (Oldest)" sort for you. It will still
refuse to scan and tell you why if either one doesn't take effect for
some reason, rather than silently returning nothing.

- **Sped up per-room processing, confirmed faster in live testing:**
  - `selectAllDocuments()` trimmed to try the confirmed-working strategy
    first (`label.click()`) instead of always wasting ~400ms on the
    native checkbox click that's confirmed to never work on this page,
    saving that time on every single room.
  - Replaced the three fixed sleeps in `background.js`'s `runQueue()`
    with real signals/shorter buffers: the flat `sleep(3500)` before
    processing a room dropped to `sleep(500)` (`processCurrentRoom()`
    already polls for the page being ready itself, so this was pure
    double-guessing on top of a real wait); the flat `sleep(4500)` after
    processing replaced with `waitForDownloadStart()`, which polls
    `STATE.downloads` - populated by the real
    `chrome.downloads.onDeterminingFilename` event - instead of always
    paying the full guessed delay; the `sleep(2000)` pacing gap between
    rooms dropped to `sleep(500)`. Roughly 7-9 seconds of pure guessed
    waiting removed per successful room. This is the "Real event-based
    waits" item from the Planned list below, now done.
- **Fixed Stop/Pause only being checked once per room instead of during
  it:** `STATE.stopped`/`STATE.paused` were only checked at the very top
  of the room loop - clicking Stop mid-room did nothing until that
  room's *entire* pipeline finished (tab load + the content script's own
  waits + the download-start wait, up to roughly a minute worst case),
  which read as "the Stop button doesn't work." Added checks right after
  the tab-load wait and right after a room's processing response comes
  back, so Stop/Pause take effect within a room instead of only between
  rooms. (Genuine remaining limit: while `processCurrentRoom()` is
  actually running inside the room tab, `background.js` is blocked on
  that one message call and can't interrupt it mid-flight - Stop still
  waits for that single response, just not the rest of the pipeline
  after it.)
- **System check requested after the Stop/Pause fix turned up three more
  bugs**, none of them visible without tracing the logic:
  - The progress counter (`X / Y` in the panel) used the raw loop index,
    which a `break` (from the new Stop checks) skips incrementing -
    undercounting completed rooms by one specifically on an interrupted
    run. Fixed by driving the display off `results.length` (ground
    truth: rooms actually recorded) instead of the loop index.
  - `STATE.downloads` was never reset between runs - Stop, then Start
    again over a list containing an already-processed room, could make
    `waitForDownloadStart()` match a stale entry from the *previous* run
    and report a download as started when this run's hadn't begun yet.
    Now reset in the `DS_START_QUEUE` handler alongside the other state.
  - The completion desktop notification (`chrome.notifications.create`)
    silently never fired: `"notifications"` was never declared in
    `manifest.json`'s permissions, and the `icon.png` it referenced
    didn't exist anywhere in the extension folder either. Removed rather
    than added a placeholder icon - the panel's own "Done." status
    message already covers this. Also removed the `"scripting"`
    permission, which was declared but never used anywhere in the code.

**Authorship note:** the scanning and date-range-filtering logic above
was written and debugged by hand. The CSV export and manifest wiring
were written by the AI assistant under human review, a deliberate choice
made under time pressure - see the "Development Process" section at the
end of `DESIGN.md` for the full explanation and where the line is drawn.

Planned (in progress):
- A shared work queue with multiple worker tabs claiming rooms
  concurrently, instead of one tab processing rooms one at a time.
- Persisted progress (via chrome.storage.local) so a run can resume after
  a browser restart, a killed extension service worker, or a long pause -
  not just a manual pause/resume within one session.
- Per-room status tracking through its full lifecycle (queued, in
  progress, done, failed, empty) shown live in the panel, per worker tab.
- A suggested worker-tab count based on measured average time-per-room,
  within safe min/max bounds.

See `Docusign rooms download/Claude Code/DESIGN.md` for the full
reasoning behind each of these decisions, including alternatives that
were considered and rejected along the way.

