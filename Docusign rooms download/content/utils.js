/**************************************************************
 * content/utils.js
 * Generic string/URL helpers with no DOM/page context of their own.
 * Shared by content/scan.js AND content/room.js - that's why these
 * live in their own file instead of either one: a function used by
 * more than one concern shouldn't be owned by either.
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