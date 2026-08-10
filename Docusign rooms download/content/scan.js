/**************************************************************
 * content/scan.js
 * Room-LIST scanning: finds every room row on the Rooms list page,
 * scrolls to load more, and (once Step 3 is added) filters by
 * created-date range.
 *
 * Depends on content/utils.js (cleanName, getRoomIdFromUrl,
 * roomUrlToDocumentsUrl, sleep) - manifest.json must load utils.js
 * first. Does not depend on content/room.js or content.js; nothing in
 * this file cares what page you're processing, only the list page.
 **************************************************************/

const SCAN_DATE_START = new Date("2020-02-01");
const SCAN_DATE_END = new Date("2020-04-30");

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
 * Entry point for scanning - called from content.js's injectPanel() when
 * Start is clicked. Forces List View via ensureListView() first (Grid
 * View has no readable rows for getRoomCardsAndLinks()), then attempts to
 * set the sort to "Created (Oldest)" via ensureOldestSort(). Still
 * refuses to run (returns []) if that didn't stick - checked via
 * getSortLabel() - since the whole skip/collect/stop algorithm below
 * depends on ascending order and a UI change could silently break the
 * auto-select without breaking the safety check. Otherwise repeatedly
 * scrolls
 * the container found by getScrollContainer() and re-runs
 * getRoomCardsAndLinks() until either: no new rooms appear for several
 * tries (noNewRoomAttempts), a hard scroll cap is hit (totalScrolls), or
 * several consecutive rooms are found past SCAN_DATE_END
 * (outOfRangeStreak) - valid as a stop signal only because the list is
 * confirmed ascending by this point. Returns the final list, filtered to
 * [SCAN_DATE_START, SCAN_DATE_END].
 */
async function autoScrollAndCollectRooms(updateStatus) {
    ensureListView();
    await sleep(500);

    await ensureOldestSort();

    const sortLabel = getSortLabel();

    if (sortLabel !== "Created (Oldest)") {
      updateStatus?.(`Stopped: set the sort dropdown to "Created (Oldest)" before scanning (currently: ${sortLabel || "unknown"}).`);
      return [];
    }

    const scrollContainer = getScrollContainer();

    let lastCount = 0;
    let noNewRoomAttempts = 0;
    let totalScrolls = 0;
    let outOfRangeStreak = 0

    while (noNewRoomAttempts < 7 && totalScrolls < 400) {
      const rooms = getRoomCardsAndLinks();
      const currentCount = rooms.length;

      updateStatus?.(`Loading rooms... found ${currentCount}`);

      const newRooms = rooms.slice(lastCount);
      for (const room of newRooms) {
        if (room.createdDate && room.createdDate > SCAN_DATE_END) {
          outOfRangeStreak++;
        } else {
            outOfRangeStreak = 0;
        }
      }

      if (outOfRangeStreak >= 5) {
        updateStatus?.(`Stopping scroll: ${outOfRangeStreak} consecutive rooms out of date range.`);
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

    return getRoomCardsAndLinks().filter(room => {
        return room.createdDate && room.createdDate >= SCAN_DATE_START && room.createdDate <= SCAN_DATE_END;
    });
}