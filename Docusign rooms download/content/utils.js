/**************************************************************
 * content/utils.js
 * Generic string/URL/CSV helpers with no DOM/page context of their own.
 * Shared by content/scan.js AND content/room.js - that's why these
 * live in their own file instead of either one: a function used by
 * more than one concern shouldn't be owned by either.
 *
 * Also loaded directly by background.js via importScripts(), since the
 * service worker runs in a separate JS context from content scripts and
 * can't reach these globals through manifest content_scripts ordering.
 * Kept as plain global function declarations (no export/import) so it
 * works unmodified in both places - avoid adding DOM/window-only logic
 * here that isn't already guarded for a context where `window` doesn't
 * exist.
 *
 * Must be the FIRST content script listed in manifest.json - scan.js
 * and room.js both call functions defined here.
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
  module.exports = { sleep, cleanName, getRoomIdFromUrl, roomUrlToDocumentsUrl, parseCsv };
  Object.assign(globalThis, module.exports);
}