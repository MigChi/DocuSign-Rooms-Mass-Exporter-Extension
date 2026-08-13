/**************************************************************
 * content/scan.js
 * Room-LIST scanning: reads every room in the account directly from
 * Docusign's own internal Rooms API and filters by a caller-supplied
 * created-date range (set via the panel's own date inputs, not
 * hardcoded here).
 *
 * Rewritten from a DOM-scrolling scraper to a direct API reader
 * (2026-08) after a real, repeated tab crash ("Aw, Snap!") kept
 * recurring even after DOM row count was independently confirmed
 * bounded (trimOldRoomRows() - see git history) - strong evidence the
 * crash's real cause was Docusign's own React app accumulating internal
 * state as it *rendered* rooms, not the DOM itself, something no amount
 * of DOM cleanup on this extension's side could ever reach. Reading data
 * directly from the same internal endpoint the page's own infinite
 * scroll calls - never triggering that rendering pipeline at all -
 * removes the risk at its root instead of mitigating it further.
 *
 * Confirmed live, 2026-08, via the user's own DevTools Network tab
 * capture (not assumed or reverse-engineered from documentation - none
 * exists, this is an internal, undocumented endpoint):
 *   GET https://rooms.docusign.com/restapi/vdev/rooms
 *     ?count=50&sort=createddate&roomStatus=Active&ownedOnly=False
 *     &restrictSides=True&dateRangeType=None&closingStatus=All
 *     &startPosition=0
 * Response shape: { rooms: [...], nextUri, previousUri, resultSetSize,
 * startPosition, endPosition, totalRowCount }. Each room object includes
 * roomId, roomName, and createdDate as a precise ISO 8601 timestamp -
 * confirmed sorted oldest-first with sort=createddate (matches the same
 * ascending-order requirement the old DOM scan depended on the page's
 * own sort dropdown for - this version controls it directly via the
 * query string instead of trusting a UI control's current state).
 * nextUri is a complete, ready-to-fetch URL for the next page - the scan
 * below just follows it until it's empty (genuinely no more data) rather
 * than computing offsets itself.
 *
 * Requires a same-origin custom header (X-DocuSign-Rooms-CSRF-Token,
 * confirmed live - a plain navigation to this URL fails with "Could not
 * validate CSRF token") matching a cookie of the same name - a standard
 * double-submit CSRF pattern, which is exactly why this has to run as a
 * content script on the actual Rooms page (same origin, real session
 * cookies) rather than from anywhere else. X-XSRF-TOKEN is sent
 * alongside it from the standard ASP.NET antiforgery cookie, in case the
 * API ever prefers that one instead - harmless to send both.
 *
 * Undocumented and internal - Docusign has made no commitment this stays
 * stable. Every response is checked for the expected shape before being
 * trusted; any HTTP failure, CSRF rejection, or unexpected shape throws
 * immediately with a clear reason rather than silently producing a wrong
 * or incomplete result (per this project's standing "no room glossed
 * over" requirement) - deliberately replacing the old DOM-scrolling scan
 * entirely rather than keeping it as an untested fallback, a choice made
 * directly rather than assumed.
 *
 * Depends on content/utils.js (cleanName, parseCookieValue, sleep) -
 * manifest.json must load utils.js first.
 **************************************************************/

/** Reads a named cookie's current value via document.cookie - the DOM
 * read this needs to be a content script for; the actual parsing is
 * pure and lives in content/utils.js's parseCookieValue() so it has real
 * test coverage. */
function getCookieValue(name) {
  return parseCookieValue(document.cookie, name);
}

/**
 * Turns one raw room object from the API response into this project's
 * standard room shape ({roomId, roomName, documentsUrl, createdDate}) -
 * the same shape every other part of this codebase (background.js,
 * content/utils.js's parseUploadedCsv, etc.) already expects. roomId is
 * coerced to a string - the API returns it as a JSON number, but every
 * comparison elsewhere in this codebase (Set/Map keys, CSV round-trips)
 * assumes a string, the same type getRoomIdFromUrl()'s regex match
 * always produced. documentsUrl is built directly from roomId rather
 * than read off any link, since there's no DOM element to read it from
 * anymore. createdDate parses directly from the API's own ISO 8601
 * timestamp - unambiguous cross-locale, unlike the old DOM scan's
 * "8/23/2019"-style text that had to be trusted to parse correctly.
 */
function normalizeApiRoom(apiRoom) {
  const roomId = String(apiRoom.roomId);
  const roomName = cleanName(apiRoom.roomName || `Docusign Room ${roomId}`);
  const documentsUrl = `${window.location.origin}/rooms/${roomId}/documents`;
  const createdDate = apiRoom.createdDate ? new Date(apiRoom.createdDate) : null;
  return { roomId, roomName, documentsUrl, createdDate };
}

/**
 * Fetches one page of the Rooms API and validates its shape before
 * trusting it - an internal, undocumented endpoint deserves more
 * suspicion than a documented one, not less. Three distinct failure
 * modes, each with its own clear, actionable message rather than one
 * generic "something went wrong": a network-level failure (fetch()
 * itself rejects), a non-2xx HTTP response, and a 2xx response that
 * doesn't actually contain a `rooms` array - confirmed live as a real
 * shape for this last case: {"message":"Could not validate CSRF
 * token.","referenceId":"..."} comes back with a 200 status, not an
 * error status code, so status alone isn't enough to catch it.
 */
async function fetchRoomsPage(url) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        "X-DocuSign-Rooms-CSRF-Token": getCookieValue("X-DocuSign-Rooms-CSRF-Token") || "",
        "X-XSRF-TOKEN": getCookieValue("XSRF-TOKEN") || ""
      }
    });
  } catch (e) {
    throw new Error(`Could not reach Docusign's room list (network error: ${e?.message || e}) - check your internet connection and try again.`);
  }

  if (!response.ok) {
    throw new Error(`Docusign's room list returned an error (HTTP ${response.status}) - make sure you're still logged into Docusign and on the Rooms list page, then try again.`);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error("Docusign's room list returned something that wasn't valid data - try again in a moment.");
  }

  if (!Array.isArray(data?.rooms)) {
    const detail = typeof data?.message === "string" ? `: "${data.message}"` : "";
    throw new Error(`Docusign's room list didn't return the expected data${detail} - try refreshing the Rooms list page and starting the scan again. If this keeps happening, the extension may need updating to match a change on Docusign's side.`);
  }

  return data;
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
 * panel has no DOM access of its own - see DESIGN.md Decision 24).
 *
 * `scanControl` (optional, `{ stopped, paused }`) lets the panel's
 * Start/Stop and Pause/Resume buttons interrupt a scan - checked once per
 * page fetch, not continuously; pausing or stopping takes effect within
 * one fetch cycle, which is now typically well under a second instead of
 * the old ~1.5-2s scroll cycle.
 *
 * Pages through the API oldest-first (sort=createddate, confirmed
 * ascending - see this file's own header comment) by following each
 * response's `nextUri` until it's empty - a genuinely, structurally
 * reliable "done" signal, unlike the old DOM scan's "no new rooms after
 * several scroll attempts," which could mean either "actually done" or
 * "still loading, just slow this once" with no way to tell them apart.
 * Stops early via `outOfRangeStreak` once several consecutive rooms are
 * confirmed past `dateRange.end` - valid only because the list is
 * confirmed ascending. `onCheckpoint`/`onActivity` (both optional) fire
 * at the same 1,000-room cadence as before, for the same reasons (see
 * DESIGN.md Decisions 37/42) - periodic checkpoint saves and Activity
 * Log entries, not a per-room diary.
 *
 * Notably absent, on purpose, compared to the old DOM-based version:
 * no sort-order check (the API call controls sort directly via its own
 * query string, not by trusting a UI dropdown's current state), and no
 * incomplete-row reconciliation (every room in a JSON API response is
 * complete and atomic by construction - there's no such thing as a
 * "mid-render" API response the way a virtualized-list DOM row could be
 * caught mid-paint, which is what that whole mechanism existed to catch
 * - see DESIGN.md Decisions 39/40 for the bug class this structurally
 * can no longer happen). Any real failure (network, HTTP, unexpected
 * shape) throws from fetchRoomsPage() and propagates straight out of
 * this function, same as before.
 *
 * Returns the final list, filtered to [dateRange.start, dateRange.end].
 */
async function autoScrollAndCollectRooms(updateStatus, dateRange, scanControl = null, onCheckpoint = null, onActivity = null) {
  const { start: dateStart, end: dateEnd } = dateRange;

  // Confirmed live, 2026-08 - the exact size the page's own infinite
  // scroll requests. Untested whether a larger count is accepted; not
  // worth risking an unconfirmed value when this one is proven working.
  const PAGE_SIZE = 50;
  // Same threshold the old DOM-scrolling scan used, kept unchanged - but
  // what it actually means in wall-clock time changed completely with
  // this rewrite. The old scan's own comment estimated "a crash loses at
  // most a few minutes of progress" for this same 1,000-room gap (at
  // ~7.3 rooms/scroll and a ~1.5-2s scroll cycle); at PAGE_SIZE rooms per
  // fetch and PAGE_FETCH_DELAY_MS between them, reaching another 1,000
  // rooms now takes on the order of a few seconds, not minutes - the
  // real gap between checkpoints shrank by roughly two orders of
  // magnitude as a direct side effect of no longer scrolling at all.
  const CHECKPOINT_EVERY = 1000;
  // A deliberate, modest pause between page fetches - not required for
  // correctness (no rate-limit response has been observed), but
  // reasonable restraint against an undocumented, internal endpoint this
  // project has no formal agreement to call at any particular rate.
  const PAGE_FETCH_DELAY_MS = 200;

  const collected = [];
  let roomsSinceCheckpoint = 0;
  let outOfRangeStreak = 0;
  let stoppedEarly = false;
  let pageCount = 0;
  // The in-range room count actually written to the checkpoint CSV as of
  // the most recent onCheckpoint() call - not collected.length, which also
  // counts rooms scanned outside the requested date range. Ascending scans
  // starting from position 0 on an account with years of history read
  // straight through every too-old room before ever reaching the requested
  // range, so "1,000 rooms collected" and "rooms actually in the saved
  // checkpoint CSV" can be very different numbers, especially early in a
  // long scan over a narrow recent range.
  let lastCheckpointInRangeCount = 0;

  let url = `${window.location.origin}/restapi/vdev/rooms?count=${PAGE_SIZE}&sort=createddate&roomStatus=Active&ownedOnly=False&restrictSides=True&dateRangeType=None&closingStatus=All&startPosition=0`;

  while (url) {
    if (!(await waitIfScanPausedOrStopped(scanControl, updateStatus))) {
      updateStatus?.("Scan stopped.");
      stoppedEarly = true;
      break;
    }

    // Enriched here, not inside fetchRoomsPage() itself, specifically so
    // the reminder is only ever added when it's actually true - a failure
    // on the very first page (before any checkpoint could possibly exist
    // yet) must not tell the user to go check for one. Uses
    // lastCheckpointInRangeCount (the exact in-range count actually handed
    // to onCheckpoint last time), not collected.length or any number
    // derived from it - those count every room scanned regardless of date
    // range, which can badly overstate what's actually sitting in the
    // checkpoint CSV on an account with years of history outside the
    // requested range (see this variable's own comment above).
    let data;
    try {
      data = await fetchRoomsPage(url);
    } catch (error) {
      if (lastCheckpointInRangeCount > 0) {
        throw new Error(`${error.message} Progress through ${lastCheckpointInRangeCount} in-range room${lastCheckpointInRangeCount === 1 ? "" : "s"} was already saved to a checkpoint CSV in Downloads / Docusign Rooms / _Scan Lists (filename ending "in progress - partial").`);
      }
      throw error;
    }
    pageCount++;

    const totalRowCount = typeof data.totalRowCount === "number" ? data.totalRowCount : null;
    updateStatus?.(`Loading rooms... found ${collected.length + data.rooms.length} total${totalRowCount ? ` of ${totalRowCount}` : ""} (page ${pageCount})`);

    for (const apiRoom of data.rooms) {
      const room = normalizeApiRoom(apiRoom);
      collected.push(room);
      roomsSinceCheckpoint++;

      if (room.createdDate && room.createdDate > dateEnd) {
        outOfRangeStreak++;
      } else {
        outOfRangeStreak = 0;
      }
    }

    if (outOfRangeStreak >= 5) {
      updateStatus?.(`Stopping: ${outOfRangeStreak} consecutive rooms past the requested date range.`);
      stoppedEarly = true;
      break;
    }

    if (roomsSinceCheckpoint >= CHECKPOINT_EVERY) {
      roomsSinceCheckpoint = 0;
      const inRange = collected.filter(room => room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd);
      onCheckpoint?.(inRange);
      lastCheckpointInRangeCount = inRange.length;
      onActivity?.({ totalFound: collected.length, inRangeFound: inRange.length, pagesLoaded: pageCount, final: false });
    }

    url = data.nextUri || null;

    if (url) await sleep(PAGE_FETCH_DELAY_MS);
  }

  if (!stoppedEarly) {
    updateStatus?.(`Finished: reached the end of the room list (${collected.length} found).`);
  }

  const finalRooms = collected.filter(room => {
    return room.createdDate && room.createdDate >= dateStart && room.createdDate <= dateEnd;
  });

  // One last activity report, even if the loop ended after fewer than
  // CHECKPOINT_EVERY new rooms since the previous one (or found none at
  // all) - without this, a scan collecting under 1,000 rooms total would
  // never produce a single activity entry, and the Activity Log would
  // look exactly like nothing happened.
  onActivity?.({ totalFound: collected.length, inRangeFound: finalRooms.length, pagesLoaded: pageCount, final: true });

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
    getCookieValue,
    normalizeApiRoom,
    fetchRoomsPage,
    waitIfScanPausedOrStopped,
    autoScrollAndCollectRooms
  };
}
