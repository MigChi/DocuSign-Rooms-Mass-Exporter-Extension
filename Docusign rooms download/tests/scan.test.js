/**************************************************************
 * tests/scan.test.js
 * Covers content/scan.js's API-based room scan (rewritten 2026-08 - see
 * content/scan.js's own header comment for why: a real, repeated tab
 * crash kept happening even after DOM row count was independently
 * confirmed bounded, strong evidence the real cause was Docusign's own
 * app accumulating internal state as it rendered rooms, not the DOM
 * itself - reading data directly from the same internal API the page's
 * own infinite scroll calls, never triggering that rendering pipeline at
 * all, removes the risk at its root).
 *
 * Much simpler to test than the old DOM-scrolling version: no DOM stub
 * needed at all now (see git history for tests/helpers/dom-stub.js,
 * retired along with the DOM-scrolling scan it existed to test) - just
 * global.fetch, a plain document.cookie string, and window.location.
 **************************************************************/

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let scan;

before(() => {
  global.window = { location: { origin: "https://rooms.docusign.com", href: "https://rooms.docusign.com/rooms" } };
  require(path.join(__dirname, "..", "content", "utils.js")); // attaches cleanName/parseCookieValue/sleep to globalThis
  global.sleep = () => Promise.resolve(); // real sleep() paces page-fetch delays - too slow for tests
  scan = require(path.join(__dirname, "..", "content", "scan.js"));
});

beforeEach(() => {
  global.document = { cookie: "X-DocuSign-Rooms-CSRF-Token=csrf-abc; XSRF-TOKEN=xsrf-xyz" };
});

function makeApiRoom({ roomId, roomName = `Room ${roomId}`, createdDate }) {
  return {
    roomId,
    roomName,
    address: { countryId: "US" },
    owners: [],
    officeId: 1,
    latitude: 0,
    longitude: 0,
    createdDate,
    closedStatusId: "",
    isUnderContract: false,
    status: "Active",
    isNew: false,
    viewingUserIsManagerOwner: false,
    transactionSideId: "sell"
  };
}

function makeApiPage({ rooms, nextUri = null, totalRowCount }) {
  return {
    rooms,
    previousUri: null,
    resultSetSize: rooms.length,
    startPosition: 0,
    endPosition: Math.max(0, rooms.length - 1),
    nextUri,
    priorUri: null,
    totalRowCount: totalRowCount ?? rooms.length
  };
}

// Serves canned page objects in order, one per fetch() call, repeating the
// last one if called more times than provided (tests assert on call count
// directly, so over-calling would already fail loudly elsewhere). Records
// every call (url + options) so a test can assert on headers/URLs sent.
function mockFetchSequence(pages) {
  let i = 0;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    if (page.networkError) throw new Error(page.networkError);
    return {
      ok: page.ok !== false,
      status: page.status || 200,
      json: page.jsonError
        ? async () => { throw new Error(page.jsonError); }
        : async () => page.body
    };
  };
  return calls;
}

test("normalizeApiRoom converts an API room object into this project's standard shape", () => {
  const room = scan.normalizeApiRoom({ roomId: 2438591, roomName: "Podd - Listing", createdDate: "2019-09-04T18:50:51.833Z" });

  assert.equal(room.roomId, "2438591", "roomId must be a string, matching every other room-shape producer in this codebase");
  assert.equal(room.roomName, "Podd - Listing");
  assert.equal(room.documentsUrl, "https://rooms.docusign.com/rooms/2438591/documents");
  assert.equal(room.createdDate.toISOString(), "2019-09-04T18:50:51.833Z");
});

test("normalizeApiRoom falls back to a generated name when roomName is missing, and null for a missing createdDate", () => {
  const room = scan.normalizeApiRoom({ roomId: 42, roomName: "", createdDate: null });

  assert.equal(room.roomName, "Docusign Room 42");
  assert.equal(room.createdDate, null);
});

test("fetchRoomsPage sends the CSRF cookie values as request headers (regression: a plain navigation to this same URL fails with 'Could not validate CSRF token' - confirmed live - this header is what a real fetch needs to succeed where that failed)", async () => {
  const calls = mockFetchSequence([{ body: makeApiPage({ rooms: [] }) }]);

  await scan.fetchRoomsPage("https://rooms.docusign.com/restapi/vdev/rooms?count=50");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-DocuSign-Rooms-CSRF-Token"], "csrf-abc");
  assert.equal(calls[0].options.headers["X-XSRF-TOKEN"], "xsrf-xyz");
  assert.equal(calls[0].options.credentials, "same-origin");
});

test("fetchRoomsPage throws a clear error on a network-level failure", async () => {
  mockFetchSequence([{ networkError: "getaddrinfo ENOTFOUND" }]);

  await assert.rejects(
    () => scan.fetchRoomsPage("https://rooms.docusign.com/restapi/vdev/rooms"),
    /Could not reach Docusign's room list.*network error/
  );
});

test("fetchRoomsPage throws a clear error on a non-2xx HTTP response", async () => {
  mockFetchSequence([{ ok: false, status: 403, body: {} }]);

  await assert.rejects(
    () => scan.fetchRoomsPage("https://rooms.docusign.com/restapi/vdev/rooms"),
    /HTTP 403/
  );
});

test("fetchRoomsPage throws a clear error when the response body isn't valid JSON", async () => {
  mockFetchSequence([{ jsonError: "Unexpected token" }]);

  await assert.rejects(
    () => scan.fetchRoomsPage("https://rooms.docusign.com/restapi/vdev/rooms"),
    /wasn't valid data/
  );
});

test("fetchRoomsPage throws a clear, specific error for a 200 OK response with no 'rooms' array (regression: confirmed live - a CSRF rejection comes back as {\"message\":\"Could not validate CSRF token.\",...} with HTTP 200, not an error status, so status alone can't catch this)", async () => {
  mockFetchSequence([{ ok: true, status: 200, body: { message: "Could not validate CSRF token.", referenceId: "abc-123" } }]);

  await assert.rejects(
    () => scan.fetchRoomsPage("https://rooms.docusign.com/restapi/vdev/rooms"),
    /Could not validate CSRF token/
  );
});

test("autoScrollAndCollectRooms follows nextUri across multiple pages until it's empty, returning every in-range room", async () => {
  mockFetchSequence([
    { body: makeApiPage({
        rooms: [makeApiRoom({ roomId: 1, createdDate: "2023-01-05T00:00:00.000Z" }), makeApiRoom({ roomId: 2, createdDate: "2023-02-01T00:00:00.000Z" })],
        nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=2"
      }) },
    { body: makeApiPage({
        rooms: [makeApiRoom({ roomId: 3, createdDate: "2023-03-01T00:00:00.000Z" })],
        nextUri: null
      }) }
  ]);

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") });

  assert.equal(result.length, 3);
  assert.deepEqual(result.map(r => r.roomId), ["1", "2", "3"]);
});

test("autoScrollAndCollectRooms stops paging once 5 consecutive rooms are confirmed past the date range, without fetching further pages", async () => {
  const outOfRangeRooms = Array.from({ length: 5 }, (_, i) => makeApiRoom({ roomId: 100 + i, createdDate: "2025-01-01T00:00:00.000Z" }));
  const calls = mockFetchSequence([
    { body: makeApiPage({
        rooms: [makeApiRoom({ roomId: 1, createdDate: "2023-06-01T00:00:00.000Z" }), ...outOfRangeRooms],
        nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=6" // must never actually be fetched
      }) }
  ]);

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") });

  assert.equal(result.length, 1, "only the one genuinely in-range room should be returned");
  assert.equal(calls.length, 1, "must stop after the first page once the streak is confirmed, not follow nextUri further");
});

test("autoScrollAndCollectRooms calls onCheckpoint/onActivity at the 1,000-room cadence, and once more at the end", async () => {
  const page1Rooms = Array.from({ length: 1000 }, (_, i) => makeApiRoom({ roomId: i, createdDate: "2023-01-01T00:00:00.000Z" }));
  const page2Rooms = Array.from({ length: 5 }, (_, i) => makeApiRoom({ roomId: 1000 + i, createdDate: "2023-01-02T00:00:00.000Z" }));

  mockFetchSequence([
    { body: makeApiPage({ rooms: page1Rooms, nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=1000" }) },
    { body: makeApiPage({ rooms: page2Rooms, nextUri: null }) }
  ]);

  const checkpoints = [];
  const activity = [];

  const result = await scan.autoScrollAndCollectRooms(
    null,
    { start: new Date("2022-01-01"), end: new Date("2023-12-31") },
    null,
    rooms => checkpoints.push(rooms),
    evt => activity.push(evt)
  );

  assert.equal(result.length, 1005);
  assert.equal(checkpoints.length, 1, "expected exactly one checkpoint, crossing 1,000 on the first page");
  assert.equal(checkpoints[0].length, 1000);

  assert.equal(activity.length, 2, "expected one periodic report plus one final report");
  assert.equal(activity[0].final, false);
  assert.equal(activity[0].totalFound, 1000);
  assert.equal(activity[1].final, true);
  assert.equal(activity[1].totalFound, 1005);
  assert.equal(activity[1].inRangeFound, 1005);
});

test("autoScrollAndCollectRooms stops when scanControl.stopped is true, returning whatever was already collected", async () => {
  mockFetchSequence([
    { body: makeApiPage({ rooms: [makeApiRoom({ roomId: 1, createdDate: "2023-01-01T00:00:00.000Z" })], nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=1" }) },
    { body: makeApiPage({ rooms: [makeApiRoom({ roomId: 2, createdDate: "2023-01-02T00:00:00.000Z" })], nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=2" }) }
  ]);

  const scanControl = { stopped: false, paused: false };
  const statuses = [];
  const updateStatus = text => {
    statuses.push(text);
    if (text?.startsWith("Loading rooms")) scanControl.stopped = true; // simulate Stop being clicked mid-scan
  };

  const result = await scan.autoScrollAndCollectRooms(updateStatus, { start: new Date("2023-01-01"), end: new Date("2023-12-31") }, scanControl);

  assert.equal(result.length, 1, "only the first page's room should have been collected before Stop took effect");
  assert.ok(statuses.includes("Scan stopped."));
});

test("autoScrollAndCollectRooms propagates a real fetch failure mid-pagination as a throw, not a silently incomplete result", async () => {
  mockFetchSequence([
    { body: makeApiPage({ rooms: [makeApiRoom({ roomId: 1, createdDate: "2023-01-01T00:00:00.000Z" })], nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=1" }) },
    { ok: false, status: 500, body: {} }
  ]);

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") }),
    /HTTP 500/
  );
});

test("autoScrollAndCollectRooms's thrown error reminds the user a checkpoint was already saved, once real progress has actually crossed the 1,000-room threshold (regression: requested directly - 'ensure if a failure happens things are getting recorded' - a failure after real checkpointed progress must not read like a total loss)", async () => {
  const page1Rooms = Array.from({ length: 1000 }, (_, i) => makeApiRoom({ roomId: i, createdDate: "2023-01-01T00:00:00.000Z" }));

  mockFetchSequence([
    { body: makeApiPage({ rooms: page1Rooms, nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=1000" }) },
    { ok: false, status: 500, body: {} } // fails on the page *after* crossing the checkpoint
  ]);

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") }),
    err => {
      assert.match(err.message, /HTTP 500/, "the real underlying failure reason must still be present");
      assert.match(err.message, /Progress through 1000 in-range rooms was already saved/, "must reassure the user real progress was already checkpointed");
      return true;
    }
  );
});

test("autoScrollAndCollectRooms's thrown error does NOT falsely claim a checkpoint exists when the failure happens before the first 1,000-room threshold is ever crossed", async () => {
  mockFetchSequence([
    { ok: false, status: 500, body: {} } // fails on the very first page - nothing was ever checkpointed
  ]);

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") }),
    err => {
      assert.match(err.message, /HTTP 500/);
      assert.doesNotMatch(err.message, /already saved/, "must not claim a checkpoint exists when none was ever written");
      return true;
    }
  );
});

test("autoScrollAndCollectRooms's thrown error does NOT falsely claim a checkpoint exists when 1,000 rooms were scanned but all of them were outside the requested date range (regression: the account has years of history before the requested range, so an ascending scan from position 0 can cross a 1,000-room checkpoint boundary while the checkpoint CSV itself is still empty - collected.length alone can't tell the difference, only the actual in-range count handed to onCheckpoint can)", async () => {
  const tooOldRooms = Array.from({ length: 1000 }, (_, i) => makeApiRoom({ roomId: i, createdDate: "2015-01-01T00:00:00.000Z" }));

  mockFetchSequence([
    { body: makeApiPage({ rooms: tooOldRooms, nextUri: "https://rooms.docusign.com/restapi/vdev/rooms?startPosition=1000" }) },
    { ok: false, status: 500, body: {} } // fails right after crossing the 1,000-room *scanned* mark, but 0 of them were in-range
  ]);

  await assert.rejects(
    () => scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") }),
    err => {
      assert.match(err.message, /HTTP 500/);
      assert.doesNotMatch(err.message, /already saved/, "1,000 rooms scanned but 0 in-range must not be reported as saved progress");
      return true;
    }
  );
});

test("autoScrollAndCollectRooms works correctly with onCheckpoint/onActivity omitted entirely (optional parameters, existing callers unaffected)", async () => {
  mockFetchSequence([
    { body: makeApiPage({ rooms: [makeApiRoom({ roomId: 1, createdDate: "2023-01-01T00:00:00.000Z" })], nextUri: null }) }
  ]);

  const result = await scan.autoScrollAndCollectRooms(null, { start: new Date("2023-01-01"), end: new Date("2023-12-31") });

  assert.equal(result.length, 1);
});
