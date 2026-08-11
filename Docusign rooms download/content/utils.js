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
 * \/:*?"<>|, collapses whitespace, caps length). Called on every room
 * name before it's used to build a download path.
 */
function cleanName(name) {
    return String(name || "Unnamed Room")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Unnamed Room";
}

/** Pull the numeric room ID out of a Docusign room URL, e.g. ".../rooms/2393913" -> "2393913". */
function getRoomIdFromUrl(url = window.location.href) {
    const match = String(url || "").match(/\/rooms\/(\d+)/i);
    return match ? match[1] : "";
}

/**
 * Normalize any room-related URL into the canonical
 * ".../rooms/<id>/documents" form. Returns null if `url` isn't a room URL
 * at all (e.g. an unrelated nav link) - callers use that null to skip the
 * element. Called once per row inside content/scan.js's
 * getRoomCardsAndLinks().
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
      default:
        return evt.type;
    }
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
    parseWorkerTabCountInput,
    describeWorkerEvent
  };
  Object.assign(globalThis, module.exports);
}