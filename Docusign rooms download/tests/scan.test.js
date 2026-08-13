/**************************************************************
 * tests/scan.test.js
 * Covers content/scan.js's scraping/scroll/date-range logic - previously
 * untested under Node (no module.exports tail existed until this file
 * was added). First real regression coverage for the exact bug fixed
 * here: a scan that stalls before ever reaching the requested date range
 * (found thousands of rooms, all *before* dateStart) used to fall
 * through as a silently "successful" 0-room export instead of the
 * failure it actually is - confirmed live on the real account/range this
 * kept happening on. See content/scan.js's own comment on the
 * autoScrollAndCollectRooms() check for the full reasoning.
 **************************************************************/

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { makeRoomRow, makeDocumentStub } = require("./helpers/dom-stub.js");

let scan;

before(() => {
  global.window = { location: { origin: "https://rooms.docusign.com", href: "https://rooms.docusign.com/" } };
  require(path.join(__dirname, "..", "content", "utils.js")); // attaches cleanName/getRoomIdFromUrl/roomUrlToDocumentsUrl/sleep to globalThis
  global.sleep = () => Promise.resolve(); // real sleep() paces scrolling at 1500ms/iteration - too slow for a 15-attempt stall test
  scan = require(path.join(__dirname, "..", "content", "scan.js"));
});

function setDom(doc) {
  global.document = doc;
}

// ---- getRoomCardsAndLinks ----

test("getRoomCardsAndLinks reads a fully-rendered row", () => {
  const row = makeRoomRow({ roomId: "111", name: "Test Room", dateText: "Jan 4, 2024" });
  setDom(makeDocumentStub([row]));

  const { ready, incompleteUrls } = scan.getRoomCardsAndLinks();

  assert.equal(ready.length, 1);
  assert.equal(incompleteUrls.length, 0);
  assert.equal(ready[0].roomId, "111");
  assert.equal(ready[0].roomName, "Test Room");
  assert.equal(ready[0].createdDate.getUTCFullYear(), 2024);
});

test("getRoomCardsAndLinks treats a missing name element as incomplete, not a placeholder room", () => {
  const row = makeRoomRow({ roomId: "222", dateText: "Jan 4, 2024" }); // name left undefined
  setDom(makeDocumentStub([row]));

  const { ready, incompleteUrls } = scan.getRoomCardsAndLinks();

  assert.equal(ready.length, 0);
  assert.equal(incompleteUrls.length, 1);
});

test("getRoomCardsAndLinks treats a present-but-empty date element as incomplete (Invalid Date guard)", () => {
  // dateEl exists but its text hasn't painted in yet - real element,
  // empty string. new Date("") is a truthy Invalid Date; this must be
  // caught before it ever reaches a room object, not after.
  const row = makeRoomRow({ roomId: "333", name: "Test Room", dateText: "" });
  setDom(makeDocumentStub([row]));

  const { ready, incompleteUrls } = scan.getRoomCardsAndLinks();

  assert.equal(ready.length, 0);
  assert.deepEqual(incompleteUrls, ["https://rooms.docusign.com/rooms/333/documents"]);
});

test("getRoomCardsAndLinks dedupes rows sharing the same documentsUrl", () => {
  const rowA = makeRoomRow({ roomId: "444", name: "Room A", dateText: "Jan 4, 2024" });
  const rowB = makeRoomRow({ roomId: "444", name: "Room A", dateText: "Jan 4, 2024" }); // same id -> same documentsUrl
  setDom(makeDocumentStub([rowA, rowB]));

  const { ready } = scan.getRoomCardsAndLinks();

  assert.equal(ready.length, 1);
});

// ---- trimOldRoomRows ----

test("trimOldRoomRows removes only the oldest rows past the keep threshold, returns count removed", () => {
  const rows = Array.from({ length: 10 }, (_, i) => makeRoomRow({ roomId: String(i) }));
  const doc = makeDocumentStub(rows);
  setDom(doc);

  const removed = scan.trimOldRoomRows(4);

  assert.equal(removed, 6);
  assert.equal(doc._rows.length, 4);
  assert.deepEqual(doc._rows.map(r => r.roomId), ["6", "7", "8", "9"]); // newest (last-loaded) 4 kept
});

test("trimOldRoomRows removes nothing and returns 0 when under the keep threshold", () => {
  const rows = Array.from({ length: 3 }, (_, i) => makeRoomRow({ roomId: String(i) }));
  const doc = makeDocumentStub(rows);
  setDom(doc);

  const removed = scan.trimOldRoomRows(4);

  assert.equal(removed, 0);
  assert.equal(doc._rows.length, 3);
});

// ---- autoScrollAndCollectRooms ----

test("autoScrollAndCollectRooms throws (does not silently export 0 rooms) when the scan stalls before ever reaching the requested range", async () => {
  // Reproduces the real bug: an account with lots of pre-range history
  // (here, 20 rooms dated 2020) where the scan stalls - no new rows ever
  // load - before it ever scrolls far enough to reach the 2023-2024
  // range actually requested. collected.length is nonzero (20), but none
  // of it is in range - this must fail loudly, not export an empty CSV.
  const preRangeRows = Array.from({ length: 20 }, (_, i) =>
    makeRoomRow({ roomId: String(1000 + i), name: `Old Room ${i}`, dateText: "Jan 1, 2020" })
  );
  setDom(makeDocumentStub(preRangeRows)); // no onScroll - nothing new ever loads

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2024-12-31") }),
    err => {
      assert.match(err.message, /stalled/i);
      assert.match(err.message, /20 room/);
      assert.doesNotMatch(err.message, /No rooms loaded after scrolling/); // must be the new, more specific message, not the old "nothing ever loaded" one
      return true;
    }
  );
});

test("autoScrollAndCollectRooms still throws its original message when literally nothing ever loads", () => {
  setDom(makeDocumentStub([])); // zero rows, ever

  return assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2024-12-31") }),
    /No rooms loaded after scrolling for a while/
  );
});

test("autoScrollAndCollectRooms returns an empty result (no throw) for a range genuinely scrolled all the way through with nothing in it", async () => {
  // Proves the fix didn't overcorrect: outOfRangeStreak firing is the one
  // signal that actually proves the range was reached and passed through
  // - a genuinely empty range must still succeed with [], not be treated
  // as a stall failure.
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => makeRoomRow({ roomId: String(2000 + i), name: `Before ${i}`, dateText: "Jan 1, 2022" })),
    ...Array.from({ length: 5 }, (_, i) => makeRoomRow({ roomId: String(3000 + i), name: `After ${i}`, dateText: "Feb 1, 2023" }))
  ];
  setDom(makeDocumentStub(rows));

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2022-06-01"), end: new Date("2022-06-30") });

  assert.deepEqual(result, []);
});

test("autoScrollAndCollectRooms returns matching rooms on a normal scan that ends via a genuine stall after finding real in-range results", async () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    makeRoomRow({ roomId: String(4000 + i), name: `Room ${i}`, dateText: "Jun 1, 2021" })
  );
  setDom(makeDocumentStub(rows));

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2021-01-01"), end: new Date("2021-12-31") });

  assert.equal(result.length, 5);
  assert.deepEqual(result.map(r => r.roomId).sort(), ["4000", "4001", "4002", "4003", "4004"]);
});

test("autoScrollAndCollectRooms throws if a room stays incomplete (name/date never render) for the rest of the scan", async () => {
  const goodRows = Array.from({ length: 3 }, (_, i) =>
    makeRoomRow({ roomId: String(5000 + i), name: `Room ${i}`, dateText: "Jun 1, 2021" })
  );
  const stuckRow = makeRoomRow({ roomId: "5999", dateText: "Jun 1, 2021" }); // name never arrives, ever
  setDom(makeDocumentStub([...goodRows, stuckRow]));

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2021-01-01"), end: new Date("2021-12-31") }),
    /could not be fully read/
  );
});

test("autoScrollAndCollectRooms picks up a room that starts incomplete but finishes rendering on a later scroll", async () => {
  const stuckRow = makeRoomRow({ roomId: "6000", dateText: "Jun 1, 2021" }); // name missing at first
  const doc = makeDocumentStub([stuckRow], {
    onScroll(d) {
      // Simulate the row finishing its render one scroll later - replace
      // the incomplete row with a complete one sharing the same roomId
      // (same documentsUrl), the way a real re-render would.
      if (d._rows.includes(stuckRow) && stuckRow._filled !== true) {
        stuckRow._filled = true;
        d._rows = d._rows.map(r => (r === stuckRow ? makeRoomRow({ roomId: "6000", name: "Late Room", dateText: "Jun 1, 2021" }) : r));
        d._rows.forEach(r => { r._doc = d; });
      }
    }
  });
  setDom(doc);

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2021-01-01"), end: new Date("2021-12-31") });

  assert.equal(result.length, 1);
  assert.equal(result[0].roomName, "Late Room");
});
