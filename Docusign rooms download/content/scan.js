/**************************************************************
 * content/scan.js
 * Room-LIST scanning: finds every room row on the Rooms list page,
 * scrolls to load more, and filters by a caller-supplied created-date
 * range (set via the panel's own date inputs, not hardcoded here).
 *
 * Depends on content/utils.js (cleanName, getRoomIdFromUrl,
 * roomUrlToDocumentsUrl, sleep) - manifest.json must load utils.js
 * first. Does not depend on content/room.js or content.js; nothing in
 * this file cares what page you're processing, only the list page.
 **************************************************************/

/**
 * Confirmed (via DevTools computed-style check, 2026-08) that this page
 * has no internally-scrolling wrapper - the Rooms list scrolls with the
 * plain document, not a nested div. document.scrollingElement is the
 * browser's own reference to whatever the document scrolls (~always
 * <html>); documentElement is a fallback for browsers without it.
 */
function getScrollContainer() {
    return document.scrollingElement || document.documentElement;
}

/**
 * Reads the current value of the Rooms list's own "Created (Oldest)" /
 * "Created (Newest)" sort control. The entire skip/collect/stop
 * date-range algorithm below depends on the list being sorted oldest
 * first - this is not a fixed property of the account, it can be either
 * direction depending on what was last selected, so it must be checked
 * at scan time rather than assumed.
 */
function getSortLabel() {
  return document.querySelector('[data-qa="filter-sort-drop-down-button"] span[title]')?.getAttribute("title") || null;
}

/**
 * The Rooms page has two view modes toggled by button[data-qa="grid"] /
 * button[data-qa="list"] (data-selected="true" on whichever is active).
 * getRoomCardsAndLinks() only knows how to read the List View markup
 * (tr[data-qa="room-list-row"]) - Grid View uses a completely different
 * card layout (div[data-qa="room-card"]) with none of those rows, which
 * is why a scan run in Grid View silently found 0 rooms. Rather than
 * maintain two parallel sets of selectors, force List View before every
 * scan.
 */
function ensureListView() {
  const listButton = document.querySelector('button[data-qa="list"]');
  if (!listButton || listButton.getAttribute("data-selected") === "true") return;
  listButton.click();
}

/**
 * The sort control isn't a native <select> - it's a button that opens a
 * portal-rendered div[role="listbox"] of button[data-qa="option-<label>"]
 * options (confirmed via the opened-menu markup, 2026-08). Setting the
 * value takes a click to open it, then a click on the matching option.
 * Polls briefly for the option to appear since the popover renders after
 * the click, not synchronously with it.
 */
async function ensureOldestSort() {
  if (getSortLabel() === "Created (Oldest)") return;

  const trigger = document.querySelector('[data-qa="filter-sort-drop-down-button"]');
  if (!trigger) return;
  trigger.click();

  let option = null;
  for (let i = 0; i < 10 && !option; i++) {
    await sleep(200);
    option = document.querySelector('[data-qa="option-Created (Oldest)"]');
  }
  option?.click();
  await sleep(300);
}

/**
 * Core scraper for the Rooms LIST page. Reads every currently-rendered
 * tr[data-qa="room-list-row"], pulls {roomId, roomName, documentsUrl,
 * createdDate} out of each fully-rendered one, dedupes by documentsUrl,
 * and returns { ready, incompleteUrls }: `ready` is that array; `incompleteUrls`
 * lists the documentsUrl of every row that has a real link but is still
 * missing its name/date content this pass (see the inline comment where
 * that's checked) - `autoScrollAndCollectRooms()` below tracks these
 * across the whole scan to detect a room that never finishes rendering
 * before the scan itself ends, not just to retry it silently. Only sees
 * rows that have loaded into the DOM so far - that's why
 * autoScrollAndCollectRooms() calls this again after every scroll, not
 * just once.
 */
function getRoomCardsAndLinks() {
  const rows = [...document.querySelectorAll('tr[data-qa="room-list-row"]')];

  // Every row with a real link that this pass could NOT read as a
  // complete room - name/date element missing, or present but still
  // empty (see below). Deliberately kept even though rows here are
  // expected to be picked up again on a later call once they finish
  // rendering: autoScrollAndCollectRooms() unions this across the whole
  // scan and, at the very end, checks whether any of these URLs *never*
  // made it into a real result - a room that stays stuck incomplete for
  // the entire rest of the scan is exactly the silent-loss scenario a
  // per-iteration retry alone can't catch, and it needs to be reported,
  // not just quietly retried forever.
  const incompleteUrls = [];

  const rooms = rows.map(row => {
    const link = row.querySelector('a[href]');
    if (!link) return null;

    const documentsUrl = roomUrlToDocumentsUrl(link.href);
    if (!documentsUrl) return null;

    const roomId = getRoomIdFromUrl(documentsUrl);

    // Both required, not optional, for a row to count as read at all -
    // a documented real risk with scraping infinite-scroll/virtualized
    // lists under a framework that batches its DOM updates (confirmed
    // against how other scrapers hit this same class of bug): a row can
    // exist in the DOM - <tr> present, link present - a few render passes
    // before its own child content (name, date) has actually painted in.
    // The previous version fell back to a placeholder name and a null
    // date for a row caught in that state, which is far worse than it
    // looks: autoScrollAndCollectRooms() dedupes by documentsUrl the
    // *first* time a room is ever seen, so a room read mid-render got
    // permanently marked "already seen" right then - it would never be
    // re-read later once its real date actually rendered, and a null
    // createdDate fails the final date-range filter, so the room just
    // silently vanished from the export entirely. Returning null here
    // instead - exactly like the "no link yet" case above already did -
    // means a not-yet-rendered row is simply skipped *this* iteration and
    // picked up again on a later one, once getRoomCardsAndLinks() re-runs
    // and finds it fully populated (the whole reason this function is
    // re-called after every scroll instead of once).
    const nameEl = row.querySelector('strong[data-qa="room-name"]');
    const dateEl = row.querySelector('strong[data-qa="room-date"]');
    // dateEl *existing* isn't enough on its own - a React element can be
    // created before its own text child paints in, so an empty-but-present
    // date element is just as much "not ready yet" as a missing one.
    // new Date("") is an Invalid Date, which is a real object (truthy) -
    // it would slip straight past a plain `!dateEl` check and then fail
    // every comparison in the final range filter silently, indistinguishable
    // from a room that's legitimately out of range. Checked here, at the
    // source, instead of trusting every downstream comparison to happen
    // to handle Invalid Date correctly.
    const dateText = dateEl?.textContent?.trim();
    if (!nameEl || !dateText) {
      if (documentsUrl) incompleteUrls.push(documentsUrl);
      return null;
    }

    const roomName = nameEl.getAttribute("title") || `Docusign Room ${roomId}`;
    const createdDate = new Date(dateText);

    return { roomId, roomName: cleanName(roomName), documentsUrl, createdDate };
  }).filter(Boolean);

  // Get unique rooms based on documentsUrl
  const unique = [];
  const seen = new Set();

  for (const room of rooms) {
    if (!seen.has(room.documentsUrl)) {
        seen.add(room.documentsUrl);
        unique.push(room);
    }
  }

  return { ready: unique, incompleteUrls };
}

/**
 * Removes all but the most recently-rendered `keepLastN` room rows from
 * the DOM. Docusign's Rooms list is a plain infinite-scroll page - every
 * room ever loaded stays in the DOM forever, nothing is recycled as you
 * scroll past it. Confirmed live as a real, serious bug: on a large
 * account, the tab itself crashes (or hangs unresponsive) partway through
 * a long scan, once enough rooms have piled up that the browser can't
 * keep holding and re-rendering all of them - not tied to any specific
 * date, just to how much has accumulated by that point. Safe to call
 * mid-scan because autoScrollAndCollectRooms() below has already copied
 * anything it needs out of the DOM into its own JS-side accumulator
 * before this ever runs, so nothing is lost by removing a row here.
 * Removes from the *start* of the list (the oldest-loaded rows, furthest
 * above the viewport, since the list is sorted oldest-first and new rows
 * always load at the bottom) - `keepLastN` is a generous buffer meant to
 * stay well clear of whatever Docusign's own infinite-scroll trigger is
 * watching near the bottom of the rendered list, which this code has no
 * way to inspect directly. If a scan ever seems to stall out right after
 * a trim (rather than for a genuine end-of-data reason - see
 * noNewRoomAttempts below), that buffer is the first thing to widen.
 * Returns how many rows were actually removed (0 if under the keep
 * threshold) - autoScrollAndCollectRooms() accumulates this across the
 * whole scan and reports it periodically, so trimming's effect on DOM
 * size is something the user can actually see happening, not just a
 * silent internal detail to trust blindly.
 */
function trimOldRoomRows(keepLastN) {
  const rows = [...document.querySelectorAll('tr[data-qa="room-list-row"]')];
  if (rows.length <= keepLastN) return 0;
  const toRemove = rows.slice(0, rows.length - keepLastN);
  toRemove.forEach(row => row.remove());
  return toRemove.length;
}

/**
 * Spin-waits while `scanControl.paused` is true (mirrors background.js's
 * waitIfPausedOrStopped() for the download-run phase - same pattern, this
 * is the scan-phase equivalent). Returns false once `scanControl.stopped`
 * is true, true otherwise. `scanControl` is optional and client-side only
 * (no chrome.storage.local persistence) - a scan is a single content-script
 * execution with no natural resume-after-reload point the way a download
 * run has, so Stop/Pause here only ever apply within one page session.
 */
async function waitIfScanPausedOrStopped(scanControl, updateStatus) {
  if (!scanControl) return true;

  while (scanControl.paused && !scanControl.stopped) {
    updateStatus?.("Scan paused.");
    await sleep(500);
  }

  return !scanControl.stopped;
}

/**
 * Entry point for scanning - called from content.js's DS_BEGIN_SCAN
 * listener when the standalone panel window (panel.js) requests a scan,
 * passing the date range it read from its own date inputs
 * (`{ start: Date, end: Date }`, relayed through background.js since the
 * panel has no DOM access of its own - see DESIGN.md Decision 24) - this
 * used to be a pair of hardcoded module constants; now the caller
 * controls batch size directly instead of needing a code edit per run.
 *
 * `scanControl` (optional, `{ stopped, paused }`) lets the panel's
 * Start/Stop and Pause/Resume buttons interrupt a long scan - confirmed
 * live as a real gap at real scale: an 8000-room scan has no way to stop
 * or pause it once started, only Ctrl+scroll-and-wait. Checked once per
 * loop iteration (before the next scroll), not continuously - pausing or
 * stopping takes effect within one scroll cycle (~1.5-2s), not instantly,
 * which is a fine tradeoff against polling more aggressively. Stopping
 * mid-scan still returns whatever rooms were collected up to that point
 * (the same `getRoomCardsAndLinks().filter(...)` call after the loop runs
 * whether the loop finished naturally or was interrupted) rather than an
 * empty list - a stopped scan's partial results are still usable.
 *
 * Forces List View via ensureListView() first (Grid View has no readable
 * rows for getRoomCardsAndLinks()), then attempts to set the sort to
 * "Created (Oldest)" via ensureOldestSort(). Still refuses to run
 * (throws) if that didn't stick - checked via getSortLabel() - since
 * the whole skip/collect/stop algorithm below depends on ascending order
 * and a UI change could silently break the auto-select without breaking
 * the safety check. Also throws if the sort *did* stick but the table
 * never renders a single row for the whole noNewRoomAttempts window -
 * confirmed live as a real, distinct case from the sort-order one (an
 * account/range already known to hold thousands of rooms produced a
 * silently "successful" 0-room export instead), so it gets the same
 * failure treatment rather than being read as a genuinely empty range.
 * Otherwise repeatedly scrolls the container found by
 * getScrollContainer() and re-runs getRoomCardsAndLinks() until either:
 * no new rooms appear for several tries (noNewRoomAttempts), or several
 * consecutive rooms are found past dateRange.end (outOfRangeStreak) -
 * valid as a stop signal only because the list is confirmed ascending by
 * this point. Deliberately has no scroll-count ceiling (see DESIGN.md
 * Decision 35) - `outOfRangeStreak` is the one signal that actually means
 * "done." Periodically trims already-seen rows out of the DOM (see
 * trimOldRoomRows()) so a large account's tab doesn't crash under its own
 * weight - confirmed live as a real, serious failure ("Aw, Snap!") on a
 * ~13,000-room scan - which is why results are now accumulated into a
 * JS-side array as the scan progresses instead of only ever being read
 * back out of the DOM at the very end; the DOM can no longer be trusted
 * to still hold everything once trimming is in play. `onCheckpoint`
 * (optional) is called periodically with everything collected so far,
 * filtered to the requested range - lets the caller save real progress to
 * disk during a long scan rather than only at the very end, so an
 * interruption doesn't lose hours of work the way a tab crash otherwise
 * would (this session's own next real request, raised alongside the
 * crash report). `onActivity` (optional) fires at the same 1,000-room
 * cadence as `onCheckpoint`, plus once more right before returning - a
 * periodic aggregate ("N rooms found so far, M in range, T DOM rows
 * trimmed"), not a per-room diary, which would be both impractical to
 * render and pointless to read at this project's real scale
 * (13,000+ rooms) - lets the caller surface scan progress through the
 * same Activity Log the download side already has, requested directly:
 * "kinda like you did for the download... nice visual like it was for
 * downloads." Before returning, reconciles every room ever glimpsed
 * as an incomplete row (a real link, but name/date never finished
 * rendering - see getRoomCardsAndLinks()) against what actually made it
 * into the final result, and throws if any never resolved - explicitly
 * requested after the fact: "we cannot tolerate a room being glossed
 * over." A per-iteration retry alone only handles a room that *later*
 * completes; this is the check that catches one that never does.
 * Returns the final list, filtered to [dateRange.start, dateRange.end].
 */
async function autoScrollAndCollectRooms(updateStatus, dateRange, scanControl = null, onCheckpoint = null, onActivity = null) {
    ensureListView();
    await sleep(500);

    await ensureOldestSort();

    const sortLabel = getSortLabel();

    if (sortLabel !== "Created (Oldest)") {
      // Thrown, not returned as an empty result - confirmed live as a real,
      // confusing gap: a `return []` here was indistinguishable downstream
      // from a genuine "this date range really has zero rooms" outcome,
      // since content.js's DS_BEGIN_SCAN handler only treats a *throw* as a
      // failure worth reporting (see its own comment) - an empty array
      // takes the normal success path straight through to a real, silently
      // unhelpful 0-room CSV export. This case isn't "no rooms match" at
      // all; it means the scan couldn't even start, most often because the
      // page isn't in the state a scan needs it to be in - logged out,
      // reloaded, or reset to a different sort/view since the panel was
      // last used, which can happen after the tab sat backgrounded through
      // a system sleep/lock-screen interruption. Throwing routes this
      // through the existing DS_SCAN_FAILED path instead, which reports a
      // real, visible reason rather than a status line easy to miss if
      // nobody's watching when it happens.
      throw new Error(`Set the sort dropdown to "Created (Oldest)" before scanning (currently: ${sortLabel || "unknown"}) - if you weren't expecting this, make sure you're still logged into Docusign and on the Rooms list page.`);
    }

    const { start: dateStart, end: dateEnd } = dateRange;

    const scrollContainer = getScrollContainer();

    // Accumulated independently of the live DOM, not read back out of it
    // at the end the way this used to work - trimOldRoomRows() below means
    // the DOM can no longer be trusted to still hold everything that's
    // ever been seen. `seenUrls` is what makes trimming safe: a room
    // that's already been recorded and then removed from the DOM won't be
    // mistaken for "new" the next time getRoomCardsAndLinks() reads
    // whatever's currently rendered.
    const seenUrls = new Set();
    // Every documentsUrl ever seen as an incomplete row (a real link, but
    // name/date not yet rendered) across the *whole* scan, not just the
    // current iteration - see getRoomCardsAndLinks()'s own comment. A row
    // that's incomplete on one pass is expected to complete on a later
    // one; a room whose URL is still in here but never made it into
    // `seenUrls` by the time the scan ends is the residual case that
    // matters - checked explicitly right before returning, below.
    const everIncompleteUrls = new Set();
    const collected = [];
    let roomsSinceCheckpoint = 0;
    // Total rows ever removed by trimOldRoomRows() below, across the whole
    // scan - purely for onActivity reporting (see this function's own
    // comment); trimOldRoomRows() itself doesn't need this, it only ever
    // looks at the DOM's current state.
    let totalTrimmed = 0;

    let noNewRoomAttempts = 0;
    let totalScrolls = 0;
    let outOfRangeStreak = 0
    let stoppedEarly = false;

    // Keeps the DOM from ever growing much past this many rendered room
    // rows, regardless of how many the scan has collected in total by
    // that point - see trimOldRoomRows()'s own comment for why, and why
    // this specific number is a generous-but-arbitrary buffer rather than
    // a value confirmed safe against Docusign's own scroll-trigger logic.
    const DOM_TRIM_KEEP = 500;
    // How many newly-collected rooms trigger a checkpoint save. Chosen so
    // a crash loses at most a few minutes of progress (~1000 rooms at this
    // account's observed ~7.3 rooms/scroll is roughly 137 scrolls, ~3-4
    // minutes) without checkpointing so often that it floods the Downloads
    // folder / downloads shelf with saves on a long scan.
    const CHECKPOINT_EVERY = 1000;

    while (noNewRoomAttempts < 15) {
      if (!(await waitIfScanPausedOrStopped(scanControl, updateStatus))) {
        updateStatus?.("Scan stopped.");
        stoppedEarly = true;
        break;
      }

      const { ready: domRooms, incompleteUrls } = getRoomCardsAndLinks();
      incompleteUrls.forEach(url => everIncompleteUrls.add(url));
      const newRooms = domRooms.filter(room => !seenUrls.has(room.documentsUrl));

      // Includes the scroll count now that nothing bounds how long this
      // loop can legitimately run for a large account - without it, a
      // scan still working through scroll #4000 looks identical, from the
      // status line alone, to one that's silently frozen.
      updateStatus?.(`Loading rooms... found ${collected.length + newRooms.length} total (scroll ${totalScrolls})`);

      for (const room of newRooms) {
        seenUrls.add(room.documentsUrl);
        collected.push(room);
        roomsSinceCheckpoint++;

        if (room.createdDate && room.createdDate > dateEnd) {
          outOfRangeStreak++;
        } else {
            outOfRangeStreak = 0;
        }
      }

      if (outOfRangeStreak >= 5) {
        updateStatus?.(`Stopping scroll: ${outOfRangeStreak} consecutive rooms out of date range.`);
        stoppedEarly = true;
        break;
      }

      if (newRooms.length > 0) {
        noNewRoomAttempts = 0;
      } else {
        noNewRoomAttempts++;
      }

      if (roomsSinceCheckpoint >= CHECKPOINT_EVERY) {
        roomsSinceCheckpoint = 0;
        const inRange = collected.filter(room => room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd);
        onCheckpoint?.(inRange);
        onActivity?.({ totalFound: collected.length, inRangeFound: inRange.length, totalTrimmed, final: false });
      }

      totalTrimmed += trimOldRoomRows(DOM_TRIM_KEEP);

      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: "smooth"
      });

      await sleep(1500);
      totalScrolls++;
    }

    // The loop-condition exit (as opposed to a `break` above) was
    // previously silent - no updateStatus() call at all, unlike every other
    // way the loop can end. That made a scan that legitimately ran out of
    // new rooms to load indistinguishable, from the panel's perspective,
    // from one that just stopped updating for no visible reason - exactly
    // the kind of thing worth surfacing explicitly rather than leaving the
    // user to guess whether something went wrong.
    if (!stoppedEarly && noNewRoomAttempts >= 15) {
      // Checked against rooms actually *within* the requested range, not
      // just collected.length - confirmed live as a real, distinct
      // failure mode on this account: a range whose start date is far
      // into the account's history (e.g. 2023, when the account also
      // holds thousands of rooms from 2020-2022 sorted before it) can
      // take long enough to scroll through everything before dateStart
      // that the scan stalls - a network hiccup, brief tab-focus loss,
      // or any other reason DOM growth briefly pauses - before it ever
      // reaches a single in-range room. collected.length is very much
      // nonzero in that case (thousands of pre-range rooms genuinely
      // found), so the original version of this check, which only
      // guarded collected.length === 0, missed it entirely and let it
      // through as a normal "0 rooms in range" success: repeatable, live,
      // header-only CSV exports for exactly this account/range while the
      // same code correctly handled smaller, closer-to-the-start ranges.
      // outOfRangeStreak (above) is the *only* legitimate way to prove a
      // range was actually reached and scrolled past with nothing in it;
      // ending via a stall instead means we genuinely don't know whether
      // the range is empty or was just never reached, so - same
      // reasoning as the sort-order check above - that ambiguity is
      // treated as a failure rather than let through as a silently
      // "successful" empty export.
      const inRangeCount = collected.filter(room => room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd).length;
      if (inRangeCount === 0) {
        if (collected.length === 0) {
          throw new Error("No rooms loaded after scrolling for a while - the Rooms list table may not have finished loading. Make sure you're logged into Docusign and on the Rooms list page, then try again.");
        }
        throw new Error(`Scan stalled after finding ${collected.length} room(s), but none were within the requested date range - it likely stopped before reaching that range rather than the range genuinely being empty. Try again; if it keeps happening, try scanning in smaller date chunks so each scan has less to scroll through before reaching its range.`);
      }
      updateStatus?.(`Finished scrolling: no new rooms loaded after ${noNewRoomAttempts} attempts (${collected.length} found so far).`);
    }

    // Final reconciliation, not just a per-iteration retry - a room stuck
    // incomplete (real link, but name/date never finished rendering) on
    // every single pass for the rest of the scan is exactly the silent-
    // loss shape of bug this project has already shipped once (see
    // getRoomCardsAndLinks()'s own comment) and was asked directly not to
    // let happen again: "we cannot tolerate a room being glossed over."
    // Thrown, not just warned about in a status line that the next
    // updateStatus() call would immediately overwrite - this routes
    // through the same DS_SCAN_FAILED path every other real scan failure
    // does, and any checkpoint already saved (see onCheckpoint above)
    // still holds everything collected up to the last 1,000-room
    // milestone, so this isn't a full loss even when it fires.
    const neverCompleted = [...everIncompleteUrls].filter(url => !seenUrls.has(url));
    if (neverCompleted.length > 0) {
      throw new Error(`${neverCompleted.length} room${neverCompleted.length === 1 ? "" : "s"} could not be fully read before the scan ended (found a link, but the room's name/date never finished loading) - re-run the scan; if this keeps happening, try a smaller date range. Affected room URL${neverCompleted.length === 1 ? "" : "s"}: ${neverCompleted.slice(0, 5).join(", ")}${neverCompleted.length > 5 ? ` (+${neverCompleted.length - 5} more)` : ""}`);
    }

    const finalRooms = collected.filter(room => {
        return room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd;
    });

    // One last activity report, even if the loop ended after fewer than
    // CHECKPOINT_EVERY new rooms since the previous one (or found none at
    // all) - without this, a scan collecting under 1,000 rooms total would
    // never produce a single activity entry, and the Activity Log would
    // look exactly like nothing happened.
    onActivity?.({ totalFound: collected.length, inRangeFound: finalRooms.length, totalTrimmed, final: true });

    return finalRooms;
}

// Test-only, same reasoning and shape as content/utils.js's own tail
// (see its comment) - `module` never exists in a real content script, so
// this is a no-op in the extension itself. Under Node, exports these for
// require() against the actual module-scoped functions rather than a
// re-implementation of their logic, so a test failure here means the
// shipped code is actually broken, not just a parallel copy of it.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getScrollContainer,
    getSortLabel,
    ensureListView,
    ensureOldestSort,
    getRoomCardsAndLinks,
    trimOldRoomRows,
    waitIfScanPausedOrStopped,
    autoScrollAndCollectRooms
  };
}