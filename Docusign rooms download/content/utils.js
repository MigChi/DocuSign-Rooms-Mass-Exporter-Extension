/**************************************************************
 * content/utils.js
 * Generic string/URL/CSV helpers with no DOM/page context of their own.
 * Most of these are shared by content/scan.js AND content/room.js -
 * that's why they live in their own file instead of either one: a
 * function used by more than one concern shouldn't be owned by either.
 * A few (formatDateRangeLabel, parseWorkerTabCountInput,
 * describeWorkerEvent) are only ever called from content.js - they live
 * here anyway, not because they're shared, but because they're pure
 * (no DOM) and this is the one file in the content-script set with a
 * safe test export tail; content.js's own top-level IIFE touches
 * `window`/`document` unconditionally from its first line, so it can't
 * get one without a full DOM stub under Node (see DESIGN.md Decision 13
 * for why this project has stuck to narrow chrome and window.location
 * stubs instead of that).
 *
 * Also loaded directly by background.js via importScripts(), since the
 * service worker runs in a separate JS context from content scripts and
 * can't reach these globals through manifest content_scripts ordering.
 * Kept as plain global function declarations (no export/import) so it
 * works unmodified in both places - avoid adding DOM/window-only logic
 * here that isn't already guarded for a context where `window` doesn't
 * exist.
 *
 * Must be the FIRST content script listed in manifest.json - scan.js,
 * room.js, and content.js all call functions defined here.
 **************************************************************/

/** Pause for `ms` milliseconds. Used to pace scrolling/polling so the page has time to lazy-load. */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize a string for safe use as a filename/folder name (strips
 * \/:*?"<>|, collapses whitespace, strips a trailing period/space, guards
 * against a Windows reserved device name, caps length). Called on every
 * room name before it's used to build a download path.
 *
 * The trailing period/space strip is the fix for a real bug confirmed
 * live at scale: Windows (and Chrome's cross-platform downloads-path
 * validation, which enforces this regardless of the user's actual OS)
 * rejects a path segment ending in "." or " " - business names ending in
 * an abbreviation like "LLC." or "Inc." are common enough that this
 * showed up as a handful of real rooms (out of thousands) landing in the
 * flat Downloads root instead of their own folder, each logging
 * "Unchecked runtime.lastError: Invalid filename" - `suggest()` in
 * background.js's onDeterminingFilename listener doesn't check for that
 * error, so the failure was both real and completely silent until this
 * was diagnosed from the console output directly. Applied after the
 * length cap too (not just before), in case truncating to 120 characters
 * exposed a new trailing period/space that wasn't there originally.
 */
function cleanName(name) {
    let cleaned = String(name || "Unnamed Room")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
      .replace(/[.\s]+$/, "");

    if (!cleaned) return "Unnamed Room";

    // Windows reserved device names are invalid as a file/folder name even
    // with an extension attached (e.g. "CON.zip" is still invalid) -
    // exceedingly unlikely to collide with a real room name, but cheap to
    // guard against now that the trailing-period/space issue above showed
    // Chrome's validation really does enforce Windows path rules
    // regardless of platform.
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)) {
      cleaned = `${cleaned}_`;
    }

    return cleaned;
}

/** Pull the numeric room ID out of a Docusign room URL, e.g. ".../rooms/2393913" -> "2393913". */
function getRoomIdFromUrl(url = window.location.href) {
    const match = String(url || "").match(/\/rooms\/(\d+)/i);
    return match ? match[1] : "";
}

/**
 * Normalize any room-related URL into the canonical
 * ".../rooms/<id>/documents" form. Returns null if `url` isn't a room URL
 * at all (e.g. an unrelated nav link) - callers use that null to skip it.
 * Used by background.js's DS_START_QUEUE handler as a fallback for a room
 * object that arrives with a bare `url`/`href` instead of an already
 * -normalized `documentsUrl` (defensive - today's two real producers,
 * a live scan and parseUploadedCsv() below, both already set
 * documentsUrl directly, but this covers a differently-shaped room object
 * without silently dropping it). No longer used by content/scan.js itself
 * - the API-based scan (2026-08) builds documentsUrl directly from the
 * API's own roomId instead of reading it off a DOM link (see scan.js's
 * normalizeApiRoom()).
 */
function roomUrlToDocumentsUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      const match = parsed.pathname.match(/\/rooms\/(\d+)/i);
      if (!match) return null;
      return `${parsed.origin}/rooms/${match[1]}/documents`;
    } catch (e) {
      return null;
    }
}

/**
 * Parses CSV text into an array of row arrays (each a plain string[]).
 * Handles quoted fields, embedded commas/newlines inside quotes, doubled
 * quotes as an escaped quote, and both \n and \r\n line endings - mirrors
 * background.js's csvEscape() (every field quoted, internal quotes
 * doubled), so it correctly reads back both CSVs this extension exports
 * (the scan list and the download report) as well as one that was
 * opened, hand-edited, and re-saved in a normal spreadsheet app.
 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }

    return rows.filter(r => r.length > 1 || r[0] !== "");
}

/**
 * "2026-01-01 to 2026-03-01" - used to make exported CSVs identifiable by
 * filename alone (see background.js's labeledFilename()). Safe via
 * .toISOString() specifically because these Date objects come from a bare
 * "YYYY-MM-DD" <input type="date"> value (parsed as UTC midnight by
 * `new Date()`), so slicing the first 10 characters back off reproduces
 * the exact original date, with no timezone-shift risk the way there
 * would be for a Date carrying a real time-of-day component. Lives here
 * (not content.js, where it's used) because it's pure - no DOM access -
 * and content.js's top-level IIFE can't safely get a test export tail the
 * way this file and background.js do (it touches `window`/`document`
 * unconditionally from its very first line, so requiring it under Node
 * would need a full DOM stub, not just the narrow chrome and window.location
 * stubs this project's test scope has stuck to - see DESIGN.md Decision 13).
 */
function formatDateRangeLabel(dateRange) {
    return `${dateRange.start.toISOString().slice(0, 10)} to ${dateRange.end.toISOString().slice(0, 10)}`;
}

/**
 * Normalizes a room's createdDate - a real Date object fresh off a live
 * scan (content/scan.js), or a plain "YYYY-MM-DD" string once it's round
 * -tripped through an uploaded CSV (parseUploadedCsv() below) - into a
 * Date, or null if there's nothing usable. Centralizes the Date-or-string
 * handling so formatCreatedDateForCsv()/roomCreatedYear() don't each have
 * to guess at the input shape, and so both agree on what counts as
 * "invalid" (an unparseable string produces an Invalid Date, not a thrown
 * error - Number.isNaN(date.getTime()) is the actual way to detect that).
 */
function coerceCreatedDate(createdDate) {
    if (!createdDate) return null;
    const date = createdDate instanceof Date ? createdDate : new Date(createdDate);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats a room's createdDate as an ISO "YYYY-MM-DD" string for a CSV
 * column, or "" if there's nothing valid to format - shared by the Scan
 * List and Download Report exports (background.js) so "Created Date"
 * reads the same way regardless of which export produced it. Replaces an
 * earlier version of this column that used `String(date).slice(0, 10)` -
 * that only happens to look like an ISO date in UTC; everywhere else it
 * silently produces something like "Sun Jan 03" (a weekday-and-day
 * fragment with no year at all, from Date's default toString() format,
 * and shifted a calendar day off the real date to boot) - confirmed
 * directly on this machine (America/New_York) before writing this fix.
 */
function formatCreatedDateForCsv(createdDate) {
    const date = coerceCreatedDate(createdDate);
    return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * The year folder a room's documents get organized under
 * (Docusign Rooms/<year>/<Room Name>/...). UTC-based (getUTCFullYear, not
 * getFullYear) to match how room dates are parsed in the first place -
 * content/scan.js reads a date-only string off the page ("Jan 4, 2024")
 * straight into `new Date(...)`, which the language spec treats as UTC
 * midnight, not local midnight. Using local time here instead could roll
 * a room created right at a year boundary into the wrong year depending
 * on which side of UTC the browser's timezone falls - the same class of
 * mismatch formatCreatedDateForCsv() above avoids by using toISOString()
 * rather than toString(). Falls back to "Unassigned" (not, say, silently
 * grouping with some other year, or throwing) for a room with no usable
 * createdDate at all - only possible today for a room queued from a
 * Download Report CSV that predates this column, or one a user
 * hand-edited to drop it. Shares its name with the separate "Unassigned"
 * bucket background.js's onDeterminingFilename listener routes a
 * download into when it can't even identify which room a download
 * belongs to at all (see its own comment) - two different kinds of "not
 * enough information," deliberately landing in the same top-level
 * Docusign Rooms/Unassigned/ folder rather than two differently-named
 * ones, since both mean the same thing to whoever's looking at the
 * folder afterward: this one needs a human to sort out.
 */
function roomCreatedYear(createdDate) {
    const date = coerceCreatedDate(createdDate);
    return date ? String(date.getUTCFullYear()) : "Unassigned";
}

/**
 * Recognizes a document row's own file-size cell text (read directly off
 * the room Documents page, e.g. "0 B" or "224 KB") as meaning the document
 * is genuinely 0 bytes. Confirmed live, requested directly and reported
 * back working: a room's Bulk Download button never renders if every
 * currently-*selected* document is 0 bytes, even when the room also has
 * real, non-empty documents sitting right alongside them - content.js's
 * selectAllDocuments() uses this to select only the non-zero ones instead
 * of blindly including everything the way the plain Select All toggle
 * does. Matches exactly "0 B" (case-insensitive, a little tolerance for
 * "0.0 B" - no other variant has been observed) - deliberately does NOT
 * match "0 KB"/"0 MB": Docusign shows raw bytes for anything under 1KB in
 * the samples seen so far, so a unit other than bytes attached to a "0"
 * would mean genuine (if small) content, not an empty file, and matching
 * it as zero would risk excluding a real document from the fix meant to
 * rescue it. Same DOM-free reasoning as formatDateRangeLabel() above for
 * why this lives here, not content.js - it's pure text matching, not a
 * DOM read itself (the DOM read is content.js's job, this only judges the
 * text once already extracted).
 */
function isZeroByteSizeText(text) {
    return /^0(\.0+)?\s*b$/i.test(String(text || "").trim());
}

/**
 * Extracts a named cookie's value from a raw document.cookie-style string
 * ("a=1; b=2; c=3"), or null if not present. Pure string parsing - kept
 * here rather than content/scan.js so it has real test coverage; the
 * actual document.cookie read (which needs a real DOM) stays in
 * content/scan.js's getCookieValue(), the same split already used for
 * isZeroByteSizeText() above. Added for the API-based scan (2026-08),
 * which needs to read Docusign's own CSRF cookie
 * (X-DocuSign-Rooms-CSRF-Token) and echo it back as a request header -
 * a standard double-submit CSRF pattern, confirmed live as required: a
 * plain navigation to the same URL (no custom header, cookies only)
 * fails with "Could not validate CSRF token."
 */
function parseCookieValue(cookieString, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(cookieString || "").match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Coerces a raw "Worker tabs" panel input value (a string from an
 * <input type="number">, possibly "") into a safe integer in [min, max],
 * falling back to `fallback` for anything not a real number. Mirrors
 * background.js's clampWorkerTabCount() null/undefined handling -
 * Number("") is 0, a real finite number that would otherwise clamp up to
 * `min` instead of falling back, silently treating "the user cleared the
 * field" the same as "asked for zero." Same DOM-free reasoning as
 * formatDateRangeLabel() above for why this lives here, not content.js.
 */
function parseWorkerTabCountInput(value, min, max, fallback) {
    if (value === "") return fallback;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * Turns one background.js workerEvent (see logWorkerEvent() there) into a
 * short human-readable line for the panel's Activity Log. Same DOM-free
 * reasoning as formatDateRangeLabel() above for why this lives here.
 */
function describeWorkerEvent(evt) {
    switch (evt.type) {
      case "service_worker_started":
        return evt.hasPersistedJob
          ? `Service worker started (found a job, ${evt.persistedQueueLength} rooms)`
          : "Service worker started (no persisted job)";
      case "resume_skipped":
        return `Resume skipped: ${evt.reason}`;
      case "run_resumed":
        return `Resumed: ${evt.pendingCount} of ${evt.totalQueue} rooms still pending`;
      case "worker_tab_created":
        return `Worker tab created (tab ${evt.tabId})`;
      case "worker_tab_dead":
        return `Worker tab ${evt.tabId} found dead`;
      case "worker_tab_replaced":
        return `Worker tab ${evt.oldTabId} replaced with tab ${evt.newTabId}`;
      case "worker_tab_replace_failed":
        return `Could not replace dead worker tab ${evt.tabId} - one worker is now down for the rest of this run`;
      case "report_failed":
        return `Failed to write the ${evt.stage === "activity_log" ? "activity log" : "download report"} CSV: ${evt.error}`;
      case "waiting_for_downloads_to_settle":
        return `Waiting for ${evt.count} download${evt.count === 1 ? "" : "s"} to finish before writing the report`;
      case "scan_tab_closed":
        return `Scan cancelled: tab ${evt.tabId} was closed`;
      case "scan_activity": {
        // pagesLoaded (API pages fetched) replaced totalTrimmed (DOM rows
        // trimmed) once scanning moved from DOM scrolling to reading
        // Docusign's own Rooms API directly (2026-08) - there's no more
        // DOM to trim at all, so that number stopped being meaningful.
        const label = evt.final ? "Scan finished" : "Scan progress";
        return `${label}: ${evt.totalFound} room${evt.totalFound === 1 ? "" : "s"} found so far (${evt.inRangeFound} in range), ${evt.pagesLoaded} page${evt.pagesLoaded === 1 ? "" : "s"} fetched`;
      }
      case "scan_checkpoint_failed":
        return `Checkpoint CSV save failed: ${evt.error}`;
      case "scan_watchdog_stalled":
        return `Scan appears stalled (no activity for ${Math.round((evt.idleMs || 0) / 1000)}s) - treated as a crashed tab`;
      case "scan_tab_navigated":
        return `Scan cancelled: tab ${evt.tabId} navigated or reloaded mid-scan`;
      case "scan_stop_forced":
        return `Scan stop forced: tab ${evt.tabId} never confirmed it stopped (likely crashed)`;
      case "scan_failed":
        return `Scan failed: ${evt.error}`;
      case "run_queue_failed":
        return `Run crashed: ${evt.error}`;
      case "verified_existing_downloads":
        return `Verified ${evt.count} room${evt.count === 1 ? "" : "s"} already downloaded (found in Chrome's download history) - not re-downloaded${evt.stage === "csv_resume" ? "" : " before writing the report"}`;
      case "unassigned_download":
        return `Download ${evt.downloadId} looked like a Docusign document but couldn't be matched to a room - saved to Docusign Rooms/Unassigned/ instead`;
      case "start_queue_failed":
        return `Could not start the run: ${evt.error}`;
      default:
        return evt.type;
    }
}

/**
 * Converts an uploaded CSV's parsed rows into two lists, using the header
 * row to find columns rather than assuming a fixed layout - works for
 * either CSV this extension exports:
 *   - rooms: still need processing (everything on a plain scan list, or
 *     anything not marked "Downloaded"/"Complete (Empty)"/"Complete (All 0
 *     Bytes)" on a download report)
 *   - priorResults: rows already marked "Downloaded", "Complete (Empty)",
 *     or "Complete (All 0 Bytes)" on a download report, carried over in
 *     full (not just dropped) so a resumed run's own report still shows
 *     them instead of only covering whatever gets reprocessed. Both
 *     "Complete" variants (see background.js's processRoom()) are treated
 *     the same as "Downloaded" here - each is a correctly-determined
 *     terminal state with nothing left to do, and without this they'd get
 *     re-visited on every single CSV-upload resume, wasting real time at
 *     scale on rooms that were never going to produce anything different.
 *     This is what makes uploading a report a genuine resume rather than
 *     a blind full re-run, without needing chrome.storage.local at all
 *     (which doesn't survive a cleared profile or a different computer -
 *     a CSV file on disk does).
 *
 * Also reads a "Created Date" column when present (both exports have one
 * now - see handleExportScanList()/createReport() in background.js) so a
 * room re-queued from either kind of CSV still carries the date its
 * Docusign-Rooms/<year>/... folder is computed from (computeFolderNames()
 * in background.js) - without it, every room resumed from a CSV upload
 * would fall back to the "Unassigned" bucket regardless of when it was
 * actually created. Attached to priorResults rows too for consistency,
 * though it isn't actually load-bearing there - an already-`Downloaded`/
 * `Complete (Empty)` room never gets re-downloaded, so nothing ever
 * recomputes a folder for it again.
 */
function parseUploadedCsv(rows) {
    if (rows.length < 2) return { rooms: [], priorResults: [] };

    const header = rows[0];
    const nameIdx = header.indexOf("Room Name");
    const idIdx = header.indexOf("Room ID");
    const urlIdx = header.indexOf("Documents URL");
    const dateIdx = header.indexOf("Created Date");
    const statusIdx = header.indexOf("Status");
    const reasonIdx = header.indexOf("Reason");
    const filenameIdx = header.indexOf("Downloaded Filename");
    const downloadIdIdx = header.indexOf("Download ID");
    const timeIdx = header.indexOf("Time");

    if (urlIdx === -1) return { rooms: [], priorResults: [] };

    const rooms = [];
    const priorResults = [];

    rows.slice(1).forEach(r => {
      const documentsUrl = r[urlIdx] || "";
      if (!documentsUrl) return;

      const roomId = idIdx === -1 ? "" : (r[idIdx] || "");
      const roomName = nameIdx === -1 ? "" : (r[nameIdx] || "");
      const createdDate = dateIdx === -1 ? null : (r[dateIdx] || null);
      const status = statusIdx === -1 ? "" : (r[statusIdx] || "");

      // "Complete (All 0 Bytes)" treated identically to "Complete (Empty)"
      // here - both are permanently-resolved terminal states with nothing
      // left to retry. Reported directly as a real concern: without this,
      // a room whose documents are all confirmed 0 bytes (so Docusign's
      // own Bulk Download button can never render, no matter what) would
      // get silently re-queued and re-attempted on every single future
      // CSV-upload resume forever, since its status would otherwise be
      // indistinguishable from a genuinely retryable "Failed."
      if (status === "Downloaded" || status === "Complete (Empty)" || status === "Complete (All 0 Bytes)") {
        priorResults.push({
          roomId,
          roomName,
          documentsUrl,
          createdDate,
          status,
          reason: reasonIdx === -1 ? "" : (r[reasonIdx] || ""),
          downloadedFilename: filenameIdx === -1 ? "" : (r[filenameIdx] || ""),
          downloadId: downloadIdIdx === -1 ? "" : (r[downloadIdIdx] || ""),
          time: timeIdx === -1 ? "" : (r[timeIdx] || "")
        });
      } else {
        // status carried through (not just for Downloaded/Complete (Empty)
        // rows above) so background.js's DS_START_QUEUE handler can tell a
        // "Success/Attempted" room - one that genuinely had a download
        // triggered, just never confirmed - from a "Failed" one, where
        // nothing was ever downloaded in the first place. Only the former
        // is worth checking against Chrome's download history before
        // re-processing it (see findVerifiedExistingDownloads() there) -
        // a Failed room has nothing to verify.
        rooms.push({ roomId, roomName, documentsUrl, createdDate, status });
      }
    });

    return { rooms, priorResults };
}

// Test-only: `module` never exists in a content script or the service
// worker, so this is a no-op in the real extension. Under Node (tests/),
// it both exports these functions for `require()` and attaches them to
// globalThis - reproducing this file's real runtime behavior, where
// manifest.json's content_scripts load order (and background.js's
// importScripts()) put these plain function declarations directly into
// the shared scope everything else runs in. Testing against a
// module-scoped shape instead would test something other than what
// actually ships.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sleep,
    cleanName,
    getRoomIdFromUrl,
    roomUrlToDocumentsUrl,
    parseCsv,
    formatDateRangeLabel,
    formatCreatedDateForCsv,
    roomCreatedYear,
    isZeroByteSizeText,
    parseCookieValue,
    parseWorkerTabCountInput,
    describeWorkerEvent,
    parseUploadedCsv
  };
  Object.assign(globalThis, module.exports);
}