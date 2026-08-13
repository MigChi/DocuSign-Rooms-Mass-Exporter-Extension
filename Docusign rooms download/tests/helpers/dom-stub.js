/**************************************************************
 * tests/helpers/dom-stub.js
 * A minimal fake of the `document` surface content/scan.js touches -
 * just enough to drive its actual scraping/scrolling logic under Node,
 * not a behavioral mock of a real browser DOM. Nothing in this repo's
 * production code reads this file.
 *
 * Modeled directly on the real Rooms list markup content/scan.js's own
 * comments describe: tr[data-qa="room-list-row"] rows, each with an
 * a[href] link and (once fully rendered) a strong[data-qa="room-name"]
 * (title attribute holds the display name) and strong[data-qa="room-date"]
 * (textContent holds the date string). A row created with `name`/`dateText`
 * left undefined reproduces the real "row exists before its own child
 * content has painted in" case getRoomCardsAndLinks() guards against.
 */

let nextRoomId = 1;

function makeRoomRow({ roomId, name, dateText, href } = {}) {
  const id = roomId ?? String(nextRoomId++);
  const rowHref = href ?? `https://rooms.docusign.com/rooms/${id}`;
  const row = {
    roomId: id,
    querySelector(sel) {
      if (sel === 'a[href]') return { href: rowHref };
      if (sel === 'strong[data-qa="room-name"]') {
        return name === undefined ? null : { getAttribute: attr => (attr === "title" ? name : null) };
      }
      if (sel === 'strong[data-qa="room-date"]') {
        return dateText === undefined ? null : { textContent: dateText };
      }
      return null;
    },
    remove() {
      const doc = row._doc;
      if (doc) doc._rows = doc._rows.filter(r => r !== row);
    }
  };
  return row;
}

/**
 * `onScroll` (optional) is called once per scroll iteration, right before
 * autoScrollAndCollectRooms()'s own sleep(1500) - lets a test simulate
 * "more rows loaded" by mutating doc._rows between reads, the same way a
 * real infinite-scroll page would between one getRoomCardsAndLinks() call
 * and the next. Left undefined for scenarios that want the row set to stay
 * exactly as initially seeded (a permanent stall).
 */
function makeDocumentStub(initialRows = [], { onScroll } = {}) {
  const doc = {
    _rows: [...initialRows],
    querySelector(sel) {
      if (sel === 'button[data-qa="list"]') return { getAttribute: () => "true" };
      if (sel === '[data-qa="filter-sort-drop-down-button"] span[title]') {
        return { getAttribute: () => "Created (Oldest)" };
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'tr[data-qa="room-list-row"]') return [...doc._rows];
      return [];
    },
    addRow(row) {
      row._doc = doc;
      doc._rows.push(row);
    },
    scrollingElement: {
      scrollHeight: 1000,
      scrollTo() {
        onScroll?.(doc);
      }
    },
    documentElement: {}
  };
  doc._rows.forEach(row => { row._doc = doc; });
  return doc;
}

module.exports = { makeRoomRow, makeDocumentStub };
