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
 * createdDate} out of each, dedupes by documentsUrl, and returns the
 * array. Only sees rows that have loaded into the DOM so far - that's
 * why autoScrollAndCollectRooms() below calls this again after every
 * scroll, not just once.
 */
function getRoomCardsAndLinks() {
  const rows = [...document.querySelectorAll('tr[data-qa="room-list-row"]')];

  const rooms = rows.map(row => {
    const link = row.querySelector('a[href]');
    if (!link) return null;

    const documentsUrl = roomUrlToDocumentsUrl(link.href);
    if (!documentsUrl) return null;

    const roomId = getRoomIdFromUrl(documentsUrl);

    const nameEl = row.querySelector('strong[data-qa="room-name"]');
    const roomName = nameEl?.getAttribute("title") || `Docusign Room ${roomId}`;

    const dateEl = row.querySelector('strong[data-qa="room-date"]');
    const createdDate = dateEl ? new Date(dateEl.textContent.trim()) : null;

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

  return unique;
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
 * (returns []) if that didn't stick - checked via getSortLabel() - since
 * the whole skip/collect/stop algorithm below depends on ascending order
 * and a UI change could silently break the auto-select without breaking
 * the safety check. Otherwise repeatedly scrolls the container found by
 * getScrollContainer() and re-runs getRoomCardsAndLinks() until either:
 * no new rooms appear for several tries (noNewRoomAttempts), or several
 * consecutive rooms are found past dateRange.end (outOfRangeStreak) -
 * valid as a stop signal only because the list is confirmed ascending by
 * this point. Deliberately has no scroll-count ceiling - a hard cap here
 * (400, later 10,000) was confirmed live to cut real scans short well
 * before the account's actual date range was exhausted, on an account
 * whose true size just didn't fit under whatever fixed number was picked;
 * outOfRangeStreak is the one signal that actually means "done," so it's
 * the only thing that gets to end the loop under normal conditions - Stop
 * is always available if a scan genuinely needs to be cut off by hand.
 * Returns the final list, filtered to [dateRange.start, dateRange.end].
 */
async function autoScrollAndCollectRooms(updateStatus, dateRange, scanControl = null) {
    ensureListView();
    await sleep(500);

    await ensureOldestSort();

    const sortLabel = getSortLabel();

    if (sortLabel !== "Created (Oldest)") {
      updateStatus?.(`Stopped: set the sort dropdown to "Created (Oldest)" before scanning (currently: ${sortLabel || "unknown"}).`);
      return [];
    }

    const { start: dateStart, end: dateEnd } = dateRange;

    const scrollContainer = getScrollContainer();

    let lastCount = 0;
    let noNewRoomAttempts = 0;
    let totalScrolls = 0;
    let outOfRangeStreak = 0
    let stoppedEarly = false;

    // No longer a loop-terminating condition - confirmed live as a real
    // bug, not a hypothetical: a hard `totalScrolls < 400` cap (added
    // purely as a circuit breaker against a genuinely infinite loop, never
    // meant to be a real ceiling) silently cut real scans short - two
    // separate runs on a real account, requesting 2023-01-01 to 2024-12-31,
    // both stopped at the exact same room (2913 found, room ID 8659058,
    // created 2023-06-10) out of a much larger range still remaining. The
    // reproducibility across two independent runs is what pinned this on
    // `totalScrolls` specifically, not `noNewRoomAttempts` (a
    // timing-dependent condition that wouldn't land on the identical room
    // twice) - 2913 rooms / 400 scrolls is ~7.3 rooms loaded per scroll on
    // this account. Raising the number (first tried: 400 -> 10,000) is
    // still just picking a different arbitrary ceiling - there's no scroll
    // count that's provably enough for every account, so any hard cap here
    // remains a real risk of the exact same bug at a large enough account.
    // The loop already has the actual correct signal for "really done":
    // `outOfRangeStreak` below, which only stops once several consecutive
    // rooms are confirmed *past* the requested date range - meaningful
    // specifically because the list is sorted oldest-first (enforced
    // before this loop even starts). `totalScrolls` is still tracked, just
    // no longer able to cut a legitimate scan short - `noNewRoomAttempts`
    // (the account has genuinely stopped producing new rows) is the only
    // other way the loop can end without a real stop signal, and Stop is
    // always available as a manual override if something truly runs away.
    while (noNewRoomAttempts < 15) {
      if (!(await waitIfScanPausedOrStopped(scanControl, updateStatus))) {
        updateStatus?.("Scan stopped.");
        stoppedEarly = true;
        break;
      }

      const rooms = getRoomCardsAndLinks();
      const currentCount = rooms.length;

      // Includes the scroll count now that nothing bounds how long this
      // loop can legitimately run for a large account - without it, a
      // scan still working through scroll #4000 looks identical, from the
      // status line alone, to one that's silently frozen.
      updateStatus?.(`Loading rooms... found ${currentCount} (scroll ${totalScrolls})`);

      const newRooms = rooms.slice(lastCount);
      for (const room of newRooms) {
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

      if (currentCount > lastCount) {
        lastCount = currentCount;
        noNewRoomAttempts = 0;
      } else {
        noNewRoomAttempts++;
      }

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
    // user to guess whether something went wrong. (The old second branch
    // here, for hitting the scroll-count cap, is gone along with the cap
    // itself - `totalScrolls` can no longer be why the loop ends.)
    if (!stoppedEarly && noNewRoomAttempts >= 15) {
      updateStatus?.(`Finished scrolling: no new rooms loaded after ${noNewRoomAttempts} attempts (${lastCount} found so far).`);
    }

    return getRoomCardsAndLinks().filter(room => {
        return room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd;
    });
}