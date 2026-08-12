/**************************************************************
 * tests/background.test.js
 * Covers background.js's pure/STATE-driven logic: queue claiming
 * (Decision 3's concurrency-safety guarantee), folder-name collision
 * handling, and download-to-room matching. Several of these are direct
 * regression tests for real bugs found via live testing this project -
 * see DESIGN.md Decision 2's corrections for the full incident history
 * behind findCurrentRoomForDownload() and computeFolderNames().
 *
 * Each test calls freshBackground() to get an isolated STATE - see
 * tests/helpers/load-background.js for why that's necessary (STATE is a
 * single mutable object exported by reference, not re-created per call).
 **************************************************************/

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshBackground } = require("./helpers/load-background");

test("computeFolderNames gives every room a plain name and the right year when nothing collides", () => {
  const { computeFolderNames } = freshBackground();

  const queue = [
    { roomId: "1", roomName: "Alpha", createdDate: "2024-03-15" },
    { roomId: "2", roomName: "Beta", createdDate: "2023-11-02" }
  ];

  const folderNames = computeFolderNames(queue);

  assert.deepEqual(folderNames.get("1"), { year: "2024", roomFolderName: "Alpha" });
  assert.deepEqual(folderNames.get("2"), { year: "2023", roomFolderName: "Beta" });
});

test("computeFolderNames appends the room ID only for rooms whose name collides within the same year (regression: two 'Ponchak - Listing' rooms sharing one folder)", () => {
  const { computeFolderNames } = freshBackground();

  const queue = [
    { roomId: "2977526", roomName: "Ponchak - Listing", createdDate: "2022-05-01" },
    { roomId: "2977529", roomName: "Ponchak - Listing", createdDate: "2022-09-01" },
    { roomId: "3000000", roomName: "Unrelated Room", createdDate: "2022-01-01" }
  ];

  const folderNames = computeFolderNames(queue);

  assert.equal(folderNames.get("2977526").roomFolderName, "Ponchak - Listing (2977526)");
  assert.equal(folderNames.get("2977529").roomFolderName, "Ponchak - Listing (2977529)");
  assert.equal(folderNames.get("3000000").roomFolderName, "Unrelated Room");
  // The two disambiguated names must actually be distinct from each other -
  // the whole point of the fix.
  assert.notEqual(folderNames.get("2977526").roomFolderName, folderNames.get("2977529").roomFolderName);
});

test("computeFolderNames does NOT disambiguate two same-named rooms created in different years - they land in different year folders already", () => {
  const { computeFolderNames } = freshBackground();

  const queue = [
    { roomId: "1", roomName: "Main St Listing", createdDate: "2021-06-01" },
    { roomId: "2", roomName: "Main St Listing", createdDate: "2024-06-01" }
  ];

  const folderNames = computeFolderNames(queue);

  assert.deepEqual(folderNames.get("1"), { year: "2021", roomFolderName: "Main St Listing" });
  assert.deepEqual(folderNames.get("2"), { year: "2024", roomFolderName: "Main St Listing" });
});

test("computeFolderNames falls back to \"Unassigned\" for a room with no usable createdDate, without dropping the room", () => {
  const { computeFolderNames } = freshBackground();

  const folderNames = computeFolderNames([
    { roomId: "1", roomName: "No Date Room", createdDate: null },
    { roomId: "2", roomName: "Bad Date Room", createdDate: "not a date" }
  ]);

  assert.deepEqual(folderNames.get("1"), { year: "Unassigned", roomFolderName: "No Date Room" });
  assert.deepEqual(folderNames.get("2"), { year: "Unassigned", roomFolderName: "Bad Date Room" });
});

test("computeFolderNames falls back to a generated name when roomName is missing", () => {
  const { computeFolderNames } = freshBackground();

  const folderNames = computeFolderNames([{ roomId: "99", roomName: "", createdDate: "2024-01-01" }]);

  assert.equal(folderNames.get("99").roomFolderName, "Docusign Room 99");
});

// End-to-end regression, one level up from cleanName()'s own tests in
// tests/utils.test.js - confirms the actual function background.js calls
// to build the real download path (STATE.folderNames.get(roomId), used by
// both processRoom()'s reported filename and onDeterminingFilename's real
// suggest() call) produces a safe folder name for every room name
// confirmed live to have broken this. cleanName() being correct in
// isolation doesn't guarantee computeFolderNames() passes its result
// through untouched (e.g. the "(roomId)" disambiguation suffix logic
// could theoretically reintroduce a trailing period some other way) -
// this checks the thing background.js actually uses, not just its
// building block.
test("computeFolderNames produces a folder name with no trailing period/space for every room name confirmed live to have caused a misrouted download", () => {
  const { computeFolderNames } = freshBackground();

  const confirmedBadNames = [
    "NJ-77, Bridgeton, NJ, USA.",
    "124 Rosman Rd.",
    "Greenberg - 156 Pine St.",
    "1 Landmark Sq.",
    "693 Squaw Brook Rd."
  ];

  const queue = confirmedBadNames.map((roomName, i) => ({ roomId: String(i + 1), roomName, createdDate: "2024-01-01" }));
  const folderNames = computeFolderNames(queue);

  queue.forEach(room => {
    const { roomFolderName } = folderNames.get(room.roomId);
    assert.ok(!/[.\s]$/.test(roomFolderName), `folder name for "${room.roomName}" must not end in a period/space (got "${roomFolderName}")`);
  });
});

test("matchVerifiedDownloads matches a room to a completed download via its transaction/<id> URL", () => {
  const { matchVerifiedDownloads } = freshBackground();

  const items = [
    {
      id: 1,
      filename: "/Users/x/Downloads/Docusign Rooms/2022/Room A/Room A.zip",
      url: "https://rooms.docusign.com/transaction/555/documents/download",
      referrer: "",
      finalUrl: ""
    }
  ];
  const rooms = [{ roomId: "555", roomName: "Room A" }];

  const verified = matchVerifiedDownloads(items, rooms);

  assert.equal(verified.size, 1);
  assert.equal(verified.get("555"), items[0]);
});

test("matchVerifiedDownloads matches a room to a completed download via its rooms/<id> URL", () => {
  const { matchVerifiedDownloads } = freshBackground();

  const items = [
    { id: 1, filename: "/Users/x/Downloads/Docusign Rooms/Room A.zip", url: "https://rooms.docusign.com/rooms/777/documents", referrer: "", finalUrl: "" }
  ];
  const rooms = [{ roomId: "777", roomName: "Room A" }];

  const verified = matchVerifiedDownloads(items, rooms);

  assert.equal(verified.get("777"), items[0]);
});

test("matchVerifiedDownloads does not match a room with no corresponding download at all", () => {
  const { matchVerifiedDownloads } = freshBackground();

  const items = [{ id: 1, filename: "/Users/x/Downloads/Docusign Rooms/Some Other Room.zip", url: "https://rooms.docusign.com/transaction/999/documents/download" }];
  const rooms = [{ roomId: "1", roomName: "Room A" }];

  const verified = matchVerifiedDownloads(items, rooms);

  assert.equal(verified.size, 0);
});

// Regression - confirmed live before this fix: an earlier version of
// matchVerifiedDownloads matched purely by cleaned room name (the leaf
// filename), which meant two genuinely different rooms sharing a display
// name (a plain address, or a generic name like "Rental," reused across
// different years/clients - a real, observed pattern in this project's
// actual data) were indistinguishable. A completed download belonging to
// one room would incorrectly "verify" a completely different, entirely
// unrelated, never-downloaded room of the same name - silently marking
// it Downloaded and skipping it for good, exactly the kind of false
// positive this whole feature exists to avoid causing. Matching on
// roomId (extracted from the download's own URL, same pattern
// findCurrentRoomForDownload() already trusts) instead of name makes
// this class of bug structurally impossible, not just less likely.
test("matchVerifiedDownloads does NOT match two different rooms that share a display name - only the room whose ID is actually in the URL", () => {
  const { matchVerifiedDownloads } = freshBackground();

  // Room 100 (created 2021) genuinely has a completed download. Room 200
  // is a completely different room that happens to share the exact same
  // cleaned display name, created a different year, and was never
  // actually downloaded.
  const items = [
    {
      id: 1,
      filename: "/Users/x/Downloads/Docusign Rooms/2021/Main St Listing/Main St Listing.zip",
      url: "https://rooms.docusign.com/transaction/100/documents/download",
      referrer: "",
      finalUrl: ""
    }
  ];
  const rooms = [{ roomId: "200", roomName: "Main St Listing" }];

  const verified = matchVerifiedDownloads(items, rooms);

  assert.equal(verified.size, 0, "room 200 must not be verified - the only existing file belongs to a different room (100)");
});

test("matchVerifiedDownloads checks referrer and finalUrl too, not just url, mirroring findCurrentRoomForDownload()'s own fallback order", () => {
  const { matchVerifiedDownloads } = freshBackground();

  const viaReferrer = matchVerifiedDownloads(
    [{ id: 1, filename: "a.zip", url: "", referrer: "https://rooms.docusign.com/transaction/10/documents/download", finalUrl: "" }],
    [{ roomId: "10", roomName: "A" }]
  );
  assert.equal(viaReferrer.size, 1);

  const viaFinalUrl = matchVerifiedDownloads(
    [{ id: 2, filename: "b.zip", url: "", referrer: "", finalUrl: "https://rooms.docusign.com/rooms/20/documents" }],
    [{ roomId: "20", roomName: "B" }]
  );
  assert.equal(viaFinalUrl.size, 1);
});

test("matchVerifiedDownloads handles missing url/referrer/finalUrl and empty/null inputs without throwing", () => {
  const { matchVerifiedDownloads } = freshBackground();

  assert.equal(matchVerifiedDownloads([{ id: 1, filename: "a.zip" }], [{ roomId: "1", roomName: "A" }]).size, 0);
  assert.equal(matchVerifiedDownloads([], []).size, 0);
  assert.equal(matchVerifiedDownloads(null, null).size, 0);
});

test("csvEscape wraps every value in quotes and doubles internal quotes", () => {
  const { csvEscape } = freshBackground();

  assert.equal(csvEscape("plain"), '"plain"');
  assert.equal(csvEscape('Room "A"'), '"Room ""A"""');
  assert.equal(csvEscape("a,b"), '"a,b"');
});

test("csvEscape treats null/undefined as an empty field, not the string 'null'/'undefined'", () => {
  const { csvEscape } = freshBackground();

  assert.equal(csvEscape(null), '""');
  assert.equal(csvEscape(undefined), '""');
});

test("nowStamp produces a sortable, filesystem-safe timestamp", () => {
  const { nowStamp } = freshBackground();

  assert.match(nowStamp(), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test("claimNextRoom hands out rooms in order and advances the shared pointer", () => {
  const { STATE, claimNextRoom } = freshBackground();

  STATE.pending = [{ roomId: "1" }, { roomId: "2" }];
  STATE.index = 0;

  assert.equal(claimNextRoom().roomId, "1");
  assert.equal(STATE.index, 1);
  assert.equal(claimNextRoom().roomId, "2");
  assert.equal(STATE.index, 2);
});

test("claimNextRoom returns null once the pending list is exhausted, without going past its length", () => {
  const { STATE, claimNextRoom } = freshBackground();

  STATE.pending = [{ roomId: "1" }];
  STATE.index = 0;

  claimNextRoom();
  assert.equal(claimNextRoom(), null);
  assert.equal(STATE.index, 1, "index must not keep advancing past pending.length");
});

test("findCurrentRoomForDownload matches by tabId first, before falling back to URL parsing", () => {
  const { STATE, findCurrentRoomForDownload } = freshBackground();

  STATE.currentRooms = { 7: { roomId: "111", roomName: "Room 111" } };

  const room = findCurrentRoomForDownload({ tabId: 7, referrer: "", url: "", finalUrl: "" });

  assert.equal(room.roomId, "111");
});

test("findCurrentRoomForDownload falls back to the download's url when tabId doesn't match (regression: target=_blank breaks tab-based matching)", () => {
  const { STATE, findCurrentRoomForDownload } = freshBackground();

  // Mirrors a real captured DownloadItem from this project's live testing:
  // the confirmation form's target="_blank" means tabId belongs to a new,
  // unrelated browsing context, and DocuSign's actual download URL uses
  // its internal /transaction/<id>/ path, not /rooms/<id>/.
  STATE.currentRooms = { 3: { roomId: "2977525", roomName: "Some Room" } };

  const room = findCurrentRoomForDownload({
    tabId: 999, // does not match any key in STATE.currentRooms
    referrer: "",
    url: "https://rooms.docusign.com/transaction/2977525/documents/download",
    finalUrl: ""
  });

  assert.equal(room.roomId, "2977525");
});

test("findCurrentRoomForDownload also matches the older /rooms/<id>/ URL shape", () => {
  const { STATE, findCurrentRoomForDownload } = freshBackground();

  STATE.currentRooms = { 3: { roomId: "555", roomName: "Some Room" } };

  const room = findCurrentRoomForDownload({
    tabId: 999,
    referrer: "https://rooms.docusign.com/rooms/555/documents",
    url: "",
    finalUrl: ""
  });

  assert.equal(room.roomId, "555");
});

test("findCurrentRoomForDownload returns null when nothing matches, instead of guessing", () => {
  const { STATE, findCurrentRoomForDownload } = freshBackground();

  STATE.currentRooms = { 3: { roomId: "555", roomName: "Some Room" } };

  const room = findCurrentRoomForDownload({
    tabId: 999,
    referrer: "",
    url: "https://rooms.docusign.com/transaction/777/documents/download",
    finalUrl: ""
  });

  assert.equal(room, null);
});

// Every freshBackground() call already logs a "service_worker_started"
// event via the startup resume IIFE (see below) - these tests wait one
// macrotask tick (setImmediate) after that so the IIFE's post-await code
// has actually run before asserting on STATE.workerEvents. The IIFE
// itself is unawaited (fire-and-forget, exactly as it runs in a real
// service worker), so this is the same kind of wait a real "did resume
// fire" check would need, not a testing artifact.
function flushAsync() {
  return new Promise(resolve => setImmediate(resolve));
}

test("logWorkerEvent appends a timestamped event and returns it", () => {
  const { STATE, logWorkerEvent } = freshBackground();

  const before = STATE.workerEvents.length;
  const event = logWorkerEvent("worker_tab_created", { tabId: 42 });

  assert.equal(STATE.workerEvents.length, before + 1);
  assert.equal(event.type, "worker_tab_created");
  assert.equal(event.tabId, 42);
  assert.match(event.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(STATE.workerEvents.at(-1), event);
});

test("logWorkerEvent trims to MAX_WORKER_EVENTS, keeping the most recent", () => {
  const { STATE, logWorkerEvent, MAX_WORKER_EVENTS } = freshBackground();

  for (let i = 0; i < MAX_WORKER_EVENTS + 10; i++) {
    logWorkerEvent("worker_tab_created", { tabId: i });
  }

  assert.equal(STATE.workerEvents.length, MAX_WORKER_EVENTS);
  // The oldest 10 should have been dropped - the first surviving event is
  // tabId 10, and the most recent is the last one pushed.
  assert.equal(STATE.workerEvents[0].tabId, 10);
  assert.equal(STATE.workerEvents.at(-1).tabId, MAX_WORKER_EVENTS + 9);
});

test("startup resume logs why resume didn't fire when there's no persisted job (regression: 'did resume even try' was previously unanswerable)", async () => {
  const { STATE } = freshBackground({ storageLocalGet: async () => ({}) });
  await flushAsync();

  const started = STATE.workerEvents.find(e => e.type === "service_worker_started");
  const skipped = STATE.workerEvents.find(e => e.type === "resume_skipped");

  assert.ok(started, "expected a service_worker_started event");
  assert.equal(started.hasPersistedJob, false);
  assert.ok(skipped, "expected a resume_skipped event");
  assert.equal(skipped.reason, "no persisted job");
});

test("startup resume logs why resume didn't fire when the persisted job has nothing pending", async () => {
  const job = {
    dsJob: {
      queue: [{ roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" }],
      results: [{ roomId: "1", status: "Downloaded" }],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: []
    }
  };

  const { STATE } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  const skipped = STATE.workerEvents.find(e => e.type === "resume_skipped");
  assert.ok(skipped, "expected a resume_skipped event");
  assert.match(skipped.reason, /nothing pending/);
});

test("startup resume logs run_resumed when the persisted job has pending rooms", async () => {
  const job = {
    dsJob: {
      queue: [
        { roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" },
        { roomId: "2", roomName: "B", documentsUrl: "https://rooms.docusign.com/rooms/2/documents" }
      ],
      results: [{ roomId: "1", status: "Downloaded" }],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: []
    }
  };

  const { STATE } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  const resumed = STATE.workerEvents.find(e => e.type === "run_resumed");
  assert.ok(resumed, "expected a run_resumed event");
  assert.equal(resumed.pendingCount, 1);
  assert.equal(resumed.totalQueue, 2);
  assert.equal(STATE.running, true);
});

test("DS_SCAN_COMPLETE with an error resets STATE.scanning and broadcasts DS_SCAN_FAILED instead of treating it as 0 rooms found (regression: content.js's autoScrollAndCollectRooms() throwing used to leave STATE.scanning stuck true forever with no signal to the panel at all - see DESIGN.md)", async () => {
  const { STATE } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanDateRangeLabel = "2021-01-01 to 2022-12-31";

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_COMPLETE", rooms: [], error: "boom" },
    {},
    () => {}
  );
  await flushAsync();

  assert.equal(STATE.scanning, false);
  assert.equal(STATE.scanTabId, null);
  assert.equal(STATE.scanMode, null);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /boom/);

  const result = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_RESULT");
  assert.equal(result, undefined, "a scan that actually threw should never be reported as a normal result");
});

test("a real DS_SCAN_COMPLETE (no error) still reports DS_SCAN_RESULT normally", async () => {
  const { STATE } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanDateRangeLabel = null;

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_COMPLETE", rooms: [{ roomId: "1" }] },
    {},
    () => {}
  );
  await flushAsync();

  assert.equal(STATE.scanning, false);

  const result = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_RESULT");
  assert.ok(result, "expected a DS_SCAN_RESULT broadcast");
  assert.equal(result.mode, "start");
  assert.equal(result.rooms.length, 1);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.equal(failed, undefined, "a successful scan should never be reported as failed");
});

test("chrome.tabs.onUpdated resets a stuck scan when the scan tab navigates or reloads mid-scan (regression: only tab CLOSE was previously handled via chrome.tabs.onRemoved - a reload/navigation destroys the content script's execution context the same way but never fires that event, since the tab itself never closes)", async () => {
  const { STATE } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanDateRangeLabel = "label";

  global.chrome.tabs.onUpdated._listener(7, { status: "loading" });
  await flushAsync();

  assert.equal(STATE.scanning, false);
  assert.equal(STATE.scanTabId, null);
  assert.equal(STATE.scanMode, null);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /reloaded or navigated/);
});

test("chrome.tabs.onUpdated ignores updates for a different tab, or a status that isn't a real navigation, so it can't misfire on the scan tab's ordinary in-app activity", () => {
  const { STATE } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;

  global.chrome.tabs.onUpdated._listener(99, { status: "loading" });
  global.chrome.tabs.onUpdated._listener(7, { status: "complete" });

  assert.equal(STATE.scanning, true, "an unrelated tab's navigation shouldn't touch an active scan");
  assert.equal(STATE.scanTabId, 7);
});

test("clampWorkerTabCount passes through an in-range integer unchanged", () => {
  const { clampWorkerTabCount } = freshBackground();

  assert.equal(clampWorkerTabCount(1), 1);
  assert.equal(clampWorkerTabCount(3), 3);
  assert.equal(clampWorkerTabCount(8), 8);
});

test("clampWorkerTabCount clamps values below the minimum up to it", () => {
  const { clampWorkerTabCount, MIN_WORKER_TAB_COUNT } = freshBackground();

  assert.equal(clampWorkerTabCount(0), MIN_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount(-5), MIN_WORKER_TAB_COUNT);
});

test("clampWorkerTabCount clamps values above the maximum down to it", () => {
  const { clampWorkerTabCount, MAX_WORKER_TAB_COUNT } = freshBackground();

  assert.equal(clampWorkerTabCount(20), MAX_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount(1000), MAX_WORKER_TAB_COUNT);
});

test("clampWorkerTabCount rounds a non-integer to the nearest whole number", () => {
  const { clampWorkerTabCount } = freshBackground();

  assert.equal(clampWorkerTabCount(3.4), 3);
  assert.equal(clampWorkerTabCount(3.6), 4);
});

test("clampWorkerTabCount falls back to the default for non-numeric input, rather than clamping garbage toward a bound", () => {
  const { clampWorkerTabCount, DEFAULT_WORKER_TAB_COUNT } = freshBackground();

  assert.equal(clampWorkerTabCount(undefined), DEFAULT_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount(null), DEFAULT_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount("not a number"), DEFAULT_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount(NaN), DEFAULT_WORKER_TAB_COUNT);
  assert.equal(clampWorkerTabCount(Infinity), DEFAULT_WORKER_TAB_COUNT);
});

test("clampWorkerTabCount accepts a numeric string (as arrives over chrome.runtime.sendMessage from an <input type=number>)", () => {
  const { clampWorkerTabCount } = freshBackground();

  assert.equal(clampWorkerTabCount("5"), 5);
});

test("STATE.workerTabCount defaults to DEFAULT_WORKER_TAB_COUNT before any run starts", () => {
  const { STATE, DEFAULT_WORKER_TAB_COUNT } = freshBackground();

  assert.equal(STATE.workerTabCount, DEFAULT_WORKER_TAB_COUNT);
});

test("startup resume restores workerTabCount from the persisted job, clamped", async () => {
  const job = {
    dsJob: {
      queue: [{ roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" }],
      results: [],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: [],
      workerTabCount: 6
    }
  };

  const { STATE } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  assert.equal(STATE.workerTabCount, 6);
});

test("startup resume falls back to the default workerTabCount for a job persisted before this field existed", async () => {
  const job = {
    dsJob: {
      queue: [{ roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" }],
      results: [],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: []
      // no workerTabCount field at all - simulates a job saved by a
      // version of this extension before this feature existed.
    }
  };

  const { STATE, DEFAULT_WORKER_TAB_COUNT } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  assert.equal(STATE.workerTabCount, DEFAULT_WORKER_TAB_COUNT);
});

test("labeledFilename includes a parenthesized date range label when given one", () => {
  const { labeledFilename } = freshBackground();

  const name = labeledFilename("Scan List", "2026-01-01 to 2026-03-01");
  assert.match(name, /^Scan List \(2026-01-01 to 2026-03-01\) \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test("labeledFilename falls back to a plain name when there's no date range label (e.g. a CSV-upload-based run)", () => {
  const { labeledFilename } = freshBackground();

  const name = labeledFilename("Docusign Rooms Download Report", null);
  assert.match(name, /^Docusign Rooms Download Report \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  assert.ok(!name.includes("("), "should not add empty parentheses when there's no label");
});

test("labeledFilename sanitizes the date range label the same way every other filename-building path does", () => {
  const { labeledFilename } = freshBackground();

  // Not a realistic input from formatDateRangeLabel() (which only ever
  // emits digits/hyphens/spaces/"to"), but defends the same way every
  // other filename in this file does against something forbidden ending
  // up in a path segment.
  const name = labeledFilename("Scan List", 'weird/label:with*forbidden"chars');
  assert.ok(!/[\\/:*?"<>|]/.test(name), "forbidden filesystem characters must not survive into the filename");
});

test("STATE.runDateRangeLabel starts null before any run begins", () => {
  const { STATE } = freshBackground();
  assert.equal(STATE.runDateRangeLabel, null);
});

test("startup resume restores runDateRangeLabel from the persisted job", async () => {
  const job = {
    dsJob: {
      queue: [{ roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" }],
      results: [],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: [],
      runDateRangeLabel: "2026-01-01 to 2026-03-01"
    }
  };

  const { STATE } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  assert.equal(STATE.runDateRangeLabel, "2026-01-01 to 2026-03-01");
});

test("startup resume falls back to null runDateRangeLabel for a job persisted before this field existed", async () => {
  const job = {
    dsJob: {
      queue: [{ roomId: "1", roomName: "A", documentsUrl: "https://rooms.docusign.com/rooms/1/documents" }],
      results: [],
      paused: false,
      startedAt: new Date().toISOString(),
      workerEvents: []
      // no runDateRangeLabel field - simulates a job saved before this
      // feature existed, and also covers a run started from an uploaded
      // CSV, which never has a date range in the first place.
    }
  };

  const { STATE } = freshBackground({ storageLocalGet: async () => job });
  await flushAsync();

  assert.equal(STATE.runDateRangeLabel, null);
});

test("safeEncodeURIComponent behaves identically to encodeURIComponent for normal strings", () => {
  const { safeEncodeURIComponent } = freshBackground();

  assert.equal(safeEncodeURIComponent("hello world"), encodeURIComponent("hello world"));
  assert.equal(safeEncodeURIComponent("Room, with a comma"), encodeURIComponent("Room, with a comma"));
});

test("safeEncodeURIComponent preserves a valid surrogate pair (e.g. an emoji in a room name)", () => {
  const { safeEncodeURIComponent } = freshBackground();

  assert.equal(safeEncodeURIComponent("Room 😀 Name"), encodeURIComponent("Room 😀 Name"));
});

test("safeEncodeURIComponent doesn't throw on a lone surrogate, where encodeURIComponent would (regression: this hung an 8000-room CSV export live, with no error ever shown)", () => {
  const { safeEncodeURIComponent } = freshBackground();

  // A bare high surrogate with no matching low surrogate - real
  // encodeURIComponent throws URIError: "URI malformed" on this.
  assert.throws(() => encodeURIComponent("bad\uD800name"), URIError);
  assert.doesNotThrow(() => safeEncodeURIComponent("bad\uD800name"));
});

test("safeEncodeURIComponent replaces only the lone surrogate, leaving the rest of the string and any valid pairs intact", () => {
  const { safeEncodeURIComponent } = freshBackground();

  const input = "good😀text\uD800end";
  const result = safeEncodeURIComponent(input);

  assert.ok(result.includes(encodeURIComponent("good")));
  assert.ok(result.includes(encodeURIComponent("😀")), "the valid surrogate pair must survive untouched");
  assert.ok(result.includes(encodeURIComponent("text")));
  assert.ok(result.includes(encodeURIComponent("end")));
  assert.ok(!result.includes("D800"), "the lone surrogate itself must not appear unescaped/unreplaced");
});

test("waitForInFlightDownloadsToSettle resolves immediately when nothing is in flight, without logging anything", async () => {
  const { STATE, waitForInFlightDownloadsToSettle } = freshBackground();
  // Let the startup resume IIFE's own logWorkerEvent calls (see
  // "flushAsync" above) land first - otherwise they can arrive during
  // this test's own `await` below and be mistaken for something this
  // function logged.
  await flushAsync();

  STATE.downloads = {
    1: { roomId: "1", completedAt: new Date().toISOString() },
    2: { roomId: "2", error: "some error" }
  };
  const eventsBefore = STATE.workerEvents.length;

  const start = Date.now();
  await waitForInFlightDownloadsToSettle(5000);
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 100, `expected an immediate return, took ${elapsedMs}ms`);
  assert.equal(STATE.workerEvents.length, eventsBefore, "should not log a wait event when there was nothing to wait for");
});

test("waitForInFlightDownloadsToSettle resolves as soon as the remaining download settles, not waiting out the full timeout (regression: this closes the CSV-status race - a room could show 'Success/Attempted' instead of 'Downloaded' even though its ZIP had actually finished)", async () => {
  const { STATE, waitForInFlightDownloadsToSettle } = freshBackground();

  STATE.downloads = {
    1: { roomId: "1" } // in flight - no completedAt or error yet
  };

  setTimeout(() => {
    STATE.downloads[1].completedAt = new Date().toISOString();
  }, 150);

  const start = Date.now();
  await waitForInFlightDownloadsToSettle(5000);
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 1000, `expected to return shortly after settling (~150-450ms), took ${elapsedMs}ms - the timeout is 5000ms, so a much longer wait would mean it ignored the settle and waited out the timeout instead`);

  const logged = STATE.workerEvents.find(e => e.type === "waiting_for_downloads_to_settle");
  assert.ok(logged, "expected a waiting_for_downloads_to_settle event");
  assert.equal(logged.count, 1);
});

test("waitForInFlightDownloadsToSettle gives up after the timeout if nothing ever settles, instead of hanging run completion indefinitely", async () => {
  const { STATE, waitForInFlightDownloadsToSettle } = freshBackground();

  STATE.downloads = {
    1: { roomId: "1" } // never settles in this test
  };

  const start = Date.now();
  await waitForInFlightDownloadsToSettle(400);
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs >= 350 && elapsedMs < 2000, `expected to return around the 400ms timeout, took ${elapsedMs}ms`);
});
