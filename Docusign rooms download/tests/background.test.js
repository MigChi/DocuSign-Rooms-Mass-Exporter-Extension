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

test("DS_SCAN_COMPLETE reports a real failure instead of silently defaulting to 'start' mode when STATE.scanMode was lost (regression: a service-worker restart mid-scan resets STATE.scanMode to null - it's deliberately never persisted, see its own STATE comment - and this used to fall straight through to 'start' mode, meaning a scan the user only asked to export as a CSV could instead show the panel's 'Found N rooms... Continue?' download-run prompt)", async () => {
  const { STATE } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = null; // simulates the fresh-worker state right after a mid-scan restart
  STATE.scanDateRangeLabel = null;

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_COMPLETE", rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }] },
    {},
    () => {}
  );
  await flushAsync();

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /restarted/);

  const result = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_RESULT");
  assert.equal(result, undefined, "must never silently fall through to a DS_SCAN_RESULT (mode: start) - that's the exact misrouting this regression guards against");

  const failedEvent = STATE.workerEvents.find(e => e.type === "scan_failed");
  assert.ok(failedEvent, "expected a scan_failed worker event logged too");
});

test("service worker startup clears the scan-stall watchdog alarm unconditionally, even with no persisted job (regression: chrome.alarms persist across a service-worker restart by default, confirmed against Chrome's own documentation - an orphaned alarm left over from a mid-scan restart would otherwise keep firing every minute forever, since nothing else replaces or clears it until a new scan happens to start)", () => {
  const { SCAN_WATCHDOG_ALARM } = freshBackground();
  assert.ok(global.chrome.alarms.clearCalls.includes(SCAN_WATCHDOG_ALARM), "expected the watchdog alarm to be cleared at startup");
});

test("DS_SCAN_CHECKPOINT cleans up its pendingReportFilenames entry when the download itself fails (regression: each checkpoint dataUrl embeds the entire CSV as a string, and unlike the one-per-run report exports, this handler can fire many times over a single long scan - a failed write that's never cleaned up would otherwise accumulate real memory)", async () => {
  const { STATE, pendingReportFilenames } = freshBackground();
  STATE.scanCheckpointFilename = "Docusign Rooms/_Scan Lists/Scan List (in progress - partial).csv";

  global.chrome.downloads.download = async () => { throw new Error("disk full"); };

  const sizeBefore = pendingReportFilenames.size;

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_SCAN_CHECKPOINT",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }]
    },
    {},
    () => {}
  );
  await flushAsync();

  assert.equal(pendingReportFilenames.size, sizeBefore, "the failed checkpoint's entry should have been cleaned up, not left to accumulate");

  const failedEvent = STATE.workerEvents.find(e => e.type === "scan_checkpoint_failed");
  assert.ok(failedEvent, "expected a scan_checkpoint_failed worker event");
  assert.match(failedEvent.error, /disk full/);
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

test("withTimeout resolves with the real value when the promise settles well within the deadline", async () => {
  const { withTimeout } = freshBackground();

  const result = await withTimeout(Promise.resolve("real result"), 1000, "timed out");
  assert.equal(result, "real result");
});

test("withTimeout resolves with the timeout value instead of hanging forever when the promise never settles (regression: processRoom()'s chrome.tabs.sendMessage() call had no bound at all - see DESIGN.md)", async () => {
  const { withTimeout } = freshBackground();

  const neverSettles = new Promise(() => {});
  const result = await withTimeout(neverSettles, 30, "timed out");
  assert.equal(result, "timed out");
});

test("withTimeout doesn't fire early for a promise that settles just before its own deadline", async () => {
  const { withTimeout } = freshBackground();

  const slowButFine = new Promise(resolve => setTimeout(() => resolve("finished in time"), 20));
  const result = await withTimeout(slowButFine, 500, "timed out");
  assert.equal(result, "finished in time");
});

// runWorker()'s loop uses real setTimeout-based sleep() calls between
// claims, so - unlike the message-dispatch tests above, which only need
// microtasks to settle - these two tests need to wait on real elapsed time.
// Polls instead of a fixed sleep so the test fails fast and loud (a thrown
// timeout) if something regresses, rather than racing a guessed duration.
async function waitUntil(conditionFn, timeoutMs = 5000) {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: condition never became true");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("an uncaught error inside runQueue() resets STATE.running and broadcasts DS_RUN_FAILED, instead of leaving the run stuck true forever (regression: runQueue() had no top-level try/catch, and both its call sites - DS_START_QUEUE and the startup-resume IIFE - invoke it fire-and-forget, so nothing else could ever catch an unexpected throw anywhere in ensureWorkerTabs()/runWorker()/processRoom() - see DESIGN.md)", async () => {
  const { STATE } = freshBackground();
  global.chrome.tabs.create = async () => { throw new Error("tab creation boom"); };

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.running === false);

  assert.equal(STATE.running, false);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_RUN_FAILED");
  assert.ok(failed, "expected a DS_RUN_FAILED broadcast");
  assert.match(failed.reason, /tab creation boom/);

  const failedEvent = STATE.workerEvents.find(e => e.type === "run_queue_failed");
  assert.ok(failedEvent, "expected a run_queue_failed worker event");
  assert.match(failedEvent.error, /tab creation boom/);

  // The persisted job must survive a crash like this - it's what lets a
  // later resume (automatic, on the next service-worker restart, or
  // manual, via re-uploading the report this path still tries to write)
  // pick the run back up instead of losing it outright.
  assert.equal(global.chrome.storage.local.removeCalls.length, 0, "a crashed run's persisted job should not be cleared");
});

test("a normal run (no error) still completes without broadcasting DS_RUN_FAILED", async () => {
  const { STATE } = freshBackground();

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.running === false && STATE.finishedAt !== null);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_RUN_FAILED");
  assert.equal(failed, undefined, "a normal completion should never broadcast DS_RUN_FAILED");

  const failedEvent = STATE.workerEvents.find(e => e.type === "run_queue_failed");
  assert.equal(failedEvent, undefined);
});

test("a download run requests chrome.power.requestKeepAwake while active and releases it when done (regression: a real scan stalled out after the computer's screen locked despite the user's own OS sleep settings being disabled - see DESIGN.md)", async () => {
  const { STATE } = freshBackground();

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => global.chrome.power.calls.includes("request:display"));
  assert.equal(STATE.running, true, "keep-awake should be requested while the run is actually active, not before");

  await waitUntil(() => STATE.running === false && STATE.finishedAt !== null);
  await waitUntil(() => global.chrome.power.calls.at(-1) === "release");
});

test("a crashed run still releases chrome.power's keep-awake lock, not just a normal completion", async () => {
  const { STATE } = freshBackground();
  global.chrome.tabs.create = async () => { throw new Error("tab creation boom"); };

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.running === false);
  assert.equal(global.chrome.power.calls.at(-1), "release");
});

test("DS_RUN_SCAN requests keep-awake, and a failed scan (no Docusign tab open) still releases it", async () => {
  const { STATE } = freshBackground();

  global.chrome.runtime.onMessage._listener(
    { type: "DS_RUN_SCAN", dateRange: { start: "2024-01-01", end: "2024-12-31" }, mode: "start" },
    {},
    () => {}
  );

  await waitUntil(() => STATE.scanning === false);
  assert.deepEqual(global.chrome.power.calls, ["request:display", "release"]);
});

test("DS_RUN_SCAN computes a stable scanCheckpointFilename, and DS_SCAN_CHECKPOINT reuses it to overwrite the same file every time (regression: 'is there a way to actively write a file while rooms are being scanned?' - a real tab crash mid-scan lost hours of progress that was never saved anywhere until the very end - see DESIGN.md)", async () => {
  const { STATE } = freshBackground();
  global.chrome.tabs.query = async () => [{ id: 42 }];

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_RUN_SCAN",
      dateRange: { start: "2024-01-01", end: "2024-12-31" },
      dateRangeLabel: "2024-01-01 to 2024-12-31",
      mode: "start"
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.scanCheckpointFilename !== null);
  const filename = STATE.scanCheckpointFilename;
  assert.match(filename, /_Scan Lists\/Scan List \(2024-01-01 to 2024-12-31\) \(in progress - partial\)\.csv$/);

  const room = n => ({
    roomId: String(n),
    roomName: `Room ${n}`,
    documentsUrl: `https://rooms.docusign.com/rooms/${n}/documents`,
    createdDate: "2024-01-01"
  });

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_CHECKPOINT", rooms: [room(1)] },
    {},
    () => {}
  );
  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_CHECKPOINT", rooms: [room(1), room(2)] },
    {},
    () => {}
  );

  await waitUntil(() => global.chrome.downloads.downloadCalls.length >= 2);

  const [first, second] = global.chrome.downloads.downloadCalls;
  assert.equal(first.filename, filename, "every checkpoint should target the same stable filename");
  assert.equal(second.filename, filename);
  assert.equal(first.conflictAction, "overwrite", "checkpoints must overwrite, not uniquify into a new file each time");
  assert.equal(second.conflictAction, "overwrite");

  // The assertions above check what was *requested* of chrome.downloads.download()
  // - not what Chrome actually does for a data: URL, which is governed by
  // onDeterminingFilename's own suggest() call instead (see
  // pendingReportFilenames' own comment - this is the exact mechanism this
  // project's own Decision 30 established as the reliable source of truth
  // here). Regression coverage for a real bug this gap in the test let
  // through undetected: that listener had always hardcoded "uniquify"
  // regardless of what the original download() call asked for, so every
  // checkpoint was silently uniquified into its own numbered file (confirmed
  // live: ten separate "... (in progress - partial) (1).csv" through "(10)"
  // files on a real 18,000+-room scan) instead of ever actually overwriting.
  global.chrome.downloads.onDeterminingFilename._listener(
    { url: first.url },
    suggestion => { global.chrome.downloads._lastSuggestion = suggestion; }
  );
  assert.equal(global.chrome.downloads._lastSuggestion.conflictAction, "overwrite", "onDeterminingFilename must honor the checkpoint's own requested conflictAction, not hardcode uniquify");
  assert.equal(global.chrome.downloads._lastSuggestion.filename, filename);
});

test("DS_SCAN_CHECKPOINT is a no-op when no scan is actually in progress", async () => {
  freshBackground();

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_SCAN_CHECKPOINT",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }]
    },
    {},
    () => {}
  );

  await flushAsync();
  assert.equal(global.chrome.downloads.downloadCalls.length, 0, "no checkpoint filename means nothing should be written");
});

test("DS_SCAN_ACTIVITY logs a scan_activity event and broadcasts it live via DS_BULK_STATUS (regression: previously only DS_SCAN_PROGRESS reached the panel during a scan, never the Activity Log - requested directly as 'nice visual like it was for downloads')", async () => {
  const { STATE } = freshBackground();

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_ACTIVITY", totalFound: 3200, inRangeFound: 1250, totalTrimmed: 2500, final: false },
    {},
    () => {}
  );

  await flushAsync();

  const evt = STATE.workerEvents.find(e => e.type === "scan_activity");
  assert.ok(evt, "expected a scan_activity event to be logged");
  assert.equal(evt.totalFound, 3200);
  assert.equal(evt.inRangeFound, 1250);
  assert.equal(evt.totalTrimmed, 2500);
  assert.equal(evt.final, false);

  const broadcast = global.chrome.runtime.sentMessages.find(m => m.type === "DS_BULK_STATUS");
  assert.ok(broadcast, "expected a DS_BULK_STATUS broadcast so the panel's Activity Log updates live during the scan, not only after it ends");
  assert.ok(broadcast.state.workerEvents.some(e => e.type === "scan_activity"));
});

test("DS_SCAN_ACTIVITY counts as sign of life for the scan-stall watchdog", async () => {
  const { STATE } = freshBackground();
  STATE.lastScanActivityAt = Date.now() - 500000; // stale, well past SCAN_STALL_THRESHOLD_MS

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_ACTIVITY", totalFound: 10, inRangeFound: 5, totalTrimmed: 0, final: false },
    {},
    () => {}
  );
  await flushAsync();

  assert.ok(Date.now() - STATE.lastScanActivityAt < 1000, "STATE.lastScanActivityAt should have just been refreshed");
});

test("DS_SCAN_CHECKPOINT updates lastScanActivityAt even when there's no checkpoint filename yet (regression: this update was missing entirely despite the watchdog's own neighboring comment claiming it already happened here - only kept working by coincidence, via DS_SCAN_PROGRESS firing on every scroll regardless)", async () => {
  const { STATE } = freshBackground();
  STATE.lastScanActivityAt = Date.now() - 500000; // stale
  // scanCheckpointFilename intentionally left null - receiving the message
  // at all is real evidence the scan is alive, independent of whether a
  // file ends up written.

  global.chrome.runtime.onMessage._listener(
    { type: "DS_SCAN_CHECKPOINT", rooms: [] },
    {},
    () => {}
  );
  await flushAsync();

  assert.ok(Date.now() - STATE.lastScanActivityAt < 1000, "STATE.lastScanActivityAt should have just been refreshed");
  assert.equal(global.chrome.downloads.downloadCalls.length, 0, "still shouldn't actually write a file without a filename");
});

test("forceResetStoppedScanIfStillActive resets state and broadcasts DS_SCAN_FAILED when the tab never confirmed Stop (regression: reported directly - clicking Stop right after a scan tab crashed left the panel stuck, since DS_SCAN_STOP only ever messaged the tab and hoped, with nothing guaranteeing an exit if that tab was already dead)", async () => {
  const { STATE, forceResetStoppedScanIfStillActive, SCAN_WATCHDOG_ALARM } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanDateRangeLabel = "2024-01-01 to 2024-12-31";
  STATE.scanCheckpointFilename = "Docusign Rooms/_Scan Lists/Scan List (in progress - partial).csv";

  forceResetStoppedScanIfStillActive(7);

  assert.equal(STATE.scanning, false);
  assert.equal(STATE.scanTabId, null);
  assert.equal(STATE.scanMode, null);
  assert.equal(STATE.scanDateRangeLabel, null);
  assert.equal(STATE.scanCheckpointFilename, null);
  assert.ok(global.chrome.alarms.clearCalls.includes(SCAN_WATCHDOG_ALARM), "expected the watchdog alarm to be disarmed too");

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /never confirmed/);

  const evt = STATE.workerEvents.find(e => e.type === "scan_stop_forced");
  assert.ok(evt, "expected a scan_stop_forced worker event");
  assert.equal(evt.tabId, 7);
});

test("forceResetStoppedScanIfStillActive is a no-op if the tab already confirmed Stop normally (STATE.scanning already false)", () => {
  const { STATE, forceResetStoppedScanIfStillActive } = freshBackground();

  STATE.scanning = false; // a real DS_SCAN_COMPLETE already reset this normally
  STATE.scanTabId = null;

  forceResetStoppedScanIfStillActive(7);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.equal(failed, undefined, "must not broadcast a failure for a scan that already finished normally");
  const evt = STATE.workerEvents.find(e => e.type === "scan_stop_forced");
  assert.equal(evt, undefined);
});

test("forceResetStoppedScanIfStillActive does not tear down a different, newer scan that started in the meantime", () => {
  const { STATE, forceResetStoppedScanIfStillActive } = freshBackground();

  // A stale call left over from an earlier Stop click (tab 7) firing after
  // a brand new scan (tab 99) has already legitimately started - the new
  // scan's own state must be left completely alone.
  STATE.scanning = true;
  STATE.scanTabId = 99;
  STATE.scanMode = "start";

  forceResetStoppedScanIfStillActive(7);

  assert.equal(STATE.scanning, true, "the new scan must still be considered active");
  assert.equal(STATE.scanTabId, 99);
  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.equal(failed, undefined, "must not broadcast a failure for the wrong scan");
});

test("DS_SCAN_STOP actually schedules forceResetStoppedScanIfStillActive, not just an unguarded message to the tab (regression: this exact wiring is what closes the stuck-forever gap - a future edit that dropped this scheduling would silently reintroduce it)", async () => {
  const { STATE, SCAN_STOP_FORCE_TIMEOUT_MS } = freshBackground();

  STATE.scanTabId = 7;

  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return 0; };
  try {
    global.chrome.runtime.onMessage._listener({ type: "DS_SCAN_STOP" }, {}, () => {});
    await flushAsync();
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(scheduled.length, 1, "expected exactly one force-reset timer scheduled");
  assert.equal(scheduled[0].ms, SCAN_STOP_FORCE_TIMEOUT_MS);

  // Confirms the scheduled call is actually the right one, not just some
  // timer - invoking what was captured should behave identically to
  // calling forceResetStoppedScanIfStillActive(7) directly.
  STATE.scanning = true;
  STATE.scanTabId = 7;
  scheduled[0].fn();
  assert.equal(STATE.scanning, false);
});

test("the scan-stall watchdog fires DS_SCAN_FAILED and resets state when a scan goes silent past the threshold (regression: a tab that crashes - \"Aw, Snap!\" - without ever being closed or navigated is invisible to chrome.tabs.onRemoved/onUpdated, the two existing signals - see DESIGN.md)", async () => {
  const { STATE, SCAN_WATCHDOG_ALARM, SCAN_STALL_THRESHOLD_MS } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanCheckpointFilename = "Docusign Rooms/_Scan Lists/Scan List (in progress - partial).csv";
  STATE.lastScanActivityAt = Date.now() - (SCAN_STALL_THRESHOLD_MS + 5000);

  global.chrome.alarms.onAlarm._listener({ name: SCAN_WATCHDOG_ALARM });
  await flushAsync();

  assert.equal(STATE.scanning, false);
  assert.equal(STATE.scanCheckpointFilename, null);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /stopped responding/);

  assert.ok(global.chrome.alarms.clearCalls.includes(SCAN_WATCHDOG_ALARM), "expected the alarm to be disarmed once the stall is reported");
});

test("the scan-stall watchdog does nothing while a scan is genuinely still active (recent activity, under the threshold)", async () => {
  const { STATE, SCAN_WATCHDOG_ALARM } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.lastScanActivityAt = Date.now();

  global.chrome.alarms.onAlarm._listener({ name: SCAN_WATCHDOG_ALARM });
  await flushAsync();

  assert.equal(STATE.scanning, true, "recent activity should not be treated as a stall");
  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.equal(failed, undefined);
});

test("the scan-stall watchdog fires DS_SCAN_FAILED on a suspiciously large gap between its own ticks, even when STATE.lastScanActivityAt looks fresh (regression: reported directly from a real scan - eight checkpoints roughly 6-12 minutes apart, then one over 2 hours after the previous one, with no DS_SCAN_FAILED ever reported in between, followed by a real tab crash shortly after - consistent with the computer sleeping through the gap, then the scan's own resumed activity refreshing lastScanActivityAt before the simple threshold check ever got a chance to notice)", async () => {
  const { STATE, SCAN_WATCHDOG_ALARM, SCAN_STALL_THRESHOLD_MS, scanWatchdogState } = freshBackground();

  STATE.scanning = true;
  STATE.scanTabId = 7;
  STATE.scanMode = "start";
  STATE.scanCheckpointFilename = "Docusign Rooms/_Scan Lists/Scan List (in progress - partial).csv";
  // Simulates the exact race: the scan's own activity just refreshed this
  // to "now" (a genuinely fresh timestamp) - the simple idleMs check alone
  // would see nothing wrong here.
  STATE.lastScanActivityAt = Date.now();
  // ...but this alarm's own last tick was a long time ago (the alarm
  // itself couldn't fire while the computer was asleep) - hard evidence
  // of a suspend/resume cycle the fresh activity timestamp alone can't see.
  scanWatchdogState.lastTickAt = Date.now() - (SCAN_STALL_THRESHOLD_MS + 60000);

  global.chrome.alarms.onAlarm._listener({ name: SCAN_WATCHDOG_ALARM });
  await flushAsync();

  assert.equal(STATE.scanning, false, "a suspicious tick gap must be treated as a stall even with fresh-looking activity");
  assert.equal(STATE.scanCheckpointFilename, null);

  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.ok(failed, "expected a DS_SCAN_FAILED broadcast");
  assert.match(failed.reason, /gone to sleep/);

  const evt = STATE.workerEvents.find(e => e.type === "scan_watchdog_stalled");
  assert.ok(evt, "expected a scan_watchdog_stalled worker event");
  assert.equal(evt.tickGapSuspicious, true);
});

test("the scan-stall watchdog does not false-positive on a scan's very first tick, even if a previous, unrelated scan's last tick was hours earlier (regression: without resetting scanWatchdogState.lastTickAt at scan start, ordinary idle time between two separate scans would look identical to a real sleep/suspend gap)", async () => {
  const { STATE, SCAN_WATCHDOG_ALARM, scanWatchdogState } = freshBackground();
  global.chrome.tabs.query = async () => [{ id: 42 }];

  // A much earlier, unrelated tick - e.g. from a previous scan that ended
  // hours ago. DS_RUN_SCAN's own reset of scanWatchdogState.lastTickAt is
  // what this test is actually verifying happens.
  scanWatchdogState.lastTickAt = Date.now() - (3 * 60 * 60 * 1000); // 3 hours ago

  global.chrome.runtime.onMessage._listener(
    { type: "DS_RUN_SCAN", dateRange: { start: "2024-01-01", end: "2024-12-31" }, mode: "start" },
    {},
    () => {}
  );
  await waitUntil(() => STATE.scanning === true);

  // First tick of this brand-new scan, activity genuinely fresh (just set
  // by DS_RUN_SCAN itself) - must not be treated as a stall just because
  // scanWatchdogState.lastTickAt hadn't been reset.
  global.chrome.alarms.onAlarm._listener({ name: SCAN_WATCHDOG_ALARM });
  await flushAsync();

  assert.equal(STATE.scanning, true, "a fresh scan's first tick must never be judged against a previous, unrelated scan's last tick");
  const failed = global.chrome.runtime.sentMessages.find(m => m.type === "DS_SCAN_FAILED");
  assert.equal(failed, undefined);
});

test("processRoom() gives a room whose documents are all confirmed 0 bytes its own 'Complete (All 0 Bytes)' status, not 'Failed', and skips the real download-start wait (regression: requested directly - a room like this must never be silently retried forever on future CSV-upload resumes the way a plain 'Failed' status would be)", async () => {
  const { STATE } = freshBackground();

  global.chrome.tabs.get = async () => ({ status: "complete" });
  global.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type !== "DS_PROCESS_ROOM") return {};
    // Exactly the shape content.js's processCurrentRoom() now returns for
    // this case - ok: true (a correctly-determined terminal state, not a
    // failure), allZeroByte: true, no download ever actually triggered.
    return {
      ok: true,
      allZeroByte: true,
      roomId: message.roomId,
      roomName: `Room ${message.roomId}`,
      reason: "Every document in this room is 0 bytes"
    };
  };

  const startedAt = Date.now();

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [{ roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" }],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.running === false && STATE.finishedAt !== null, 10000);

  // If the download-start wait wasn't actually skipped, this would take a
  // real ~15s (nothing in this stub ever populates STATE.downloads to
  // satisfy it early) - finishing well under that is itself evidence the
  // skip condition correctly covers allZeroByte, not just empty.
  assert.ok(Date.now() - startedAt < 5000, "expected the 15s download-start wait to be skipped for an all-0-byte room");

  const result = STATE.results.find(r => r.roomId === "1");
  assert.ok(result, "expected a result for the room");
  assert.equal(result.status, "Complete (All 0 Bytes)");
  assert.equal(result.reason, "Every document in this room is 0 bytes");
});

test("a worker tab's message channel failing on one room - simulating a crashed tab (\"Aw, Snap!\") - doesn't hang the run: that room is marked Failed and persisted, the run continues past it to completion, and a real Download Report CSV still gets written (regression: directly requested - confirm persistence and CSV generation survive a crashed worker tab, not just a crashed scan tab - see DESIGN.md)", async () => {
  const { STATE } = freshBackground();

  // processRoom() only reaches the DS_PROCESS_ROOM message at all once
  // waitForTabLoaded() sees the tab as "complete" - the stub's default
  // tabs.get() returns null, which waitForTabLoaded() treats as "never
  // loaded," short-circuiting the room as Failed before it ever gets this
  // far. Overridden here so the test actually exercises the messaging
  // step it's meant to be testing, not a different, earlier Failed path.
  global.chrome.tabs.get = async () => ({ status: "complete" });

  let processRoomCalls = 0;
  global.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type !== "DS_PROCESS_ROOM") return {};
    processRoomCalls++;
    if (processRoomCalls === 1) {
      // The real error Chrome gives when messaging a tab whose content
      // script is gone - a crashed renderer looks exactly like this from
      // the extension's side, since chrome.tabs.get() alone can't tell
      // "crashed" apart from "healthy" (the tab object still exists).
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    // `empty: true` deliberately, not a real triggered-download response -
    // processRoom() skips waitForDownloadStart()'s real 15s-max poll only
    // for an empty room (nothing to wait for); a non-empty "ok" response
    // would otherwise burn a genuine 15 real seconds here, since nothing
    // in this stub ever populates STATE.downloads to satisfy it early.
    // Irrelevant to what this test is actually verifying (that the run
    // survives one room's crashed tab and keeps going), so sidestepped
    // rather than modeled.
    return { ok: true, empty: true, roomId: message.roomId, roomName: `Room ${message.roomId}`, reason: "Room is empty (0 documents)" };
  };

  global.chrome.runtime.onMessage._listener(
    {
      type: "DS_START_QUEUE",
      rooms: [
        { roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" },
        { roomId: "2", roomName: "Beta", documentsUrl: "https://rooms.docusign.com/rooms/2/documents", createdDate: "2024-01-02" }
      ],
      priorResults: [],
      workerTabCount: 1
    },
    {},
    () => {}
  );

  await waitUntil(() => STATE.running === false && STATE.finishedAt !== null, 10000);

  const crashedResult = STATE.results.find(r => r.roomId === "1");
  assert.ok(crashedResult, "expected a result for the room whose tab communication failed");
  assert.equal(crashedResult.status, "Failed");
  assert.match(crashedResult.reason, /Could not establish connection/);

  const recoveredResult = STATE.results.find(r => r.roomId === "2");
  assert.ok(recoveredResult, "expected the next room to still be processed, not stuck behind the crashed one");
  assert.equal(recoveredResult.status, "Complete (Empty)");

  const persistedCrashedRoom = global.chrome.storage.local.setCalls.some(
    ([data]) => data?.dsJob?.results?.some(r => r.roomId === "1" && r.status === "Failed")
  );
  assert.ok(persistedCrashedRoom, "expected the crashed room's Failed result to actually be checkpointed to chrome.storage.local, not just held in memory");

  const reportCall = global.chrome.downloads.downloadCalls.find(c => c.filename.includes("_Download Reports"));
  assert.ok(reportCall, "expected a Download Report CSV to still be written after the run finished, even though one room's tab communication failed mid-run");
});

test("persistJob() serializes concurrent calls so chrome.storage.local.set() is never issued a second time while an earlier call is still in flight (regression: chrome.storage.local gives no ordering guarantee of its own for concurrent set() calls to the same key - confirmed against the Chromium extensions team's own description of the API, not assumed - and multiple worker tabs genuinely call persistJob() at effectively the same time during a real run)", async () => {
  const { STATE, persistJob } = freshBackground();

  // Records exactly when each call started and finished, in one shared
  // order - not just a count - so the assertions below can check real
  // interleaving, not just "how many calls happened so far."
  const order = [];
  let resolveFirstWrite;
  let callCount = 0;
  global.chrome.storage.local.set = () => {
    callCount++;
    const n = callCount;
    order.push(`start:${n}`);
    if (n === 1) {
      // Deliberately left pending - if calls weren't serialized, nothing
      // would stop a second call from starting (and even finishing)
      // while this one is still open, which is exactly the unordered,
      // "not ACID compliant" behavior chrome.storage.local is documented
      // to allow on its own.
      return new Promise(resolve => {
        resolveFirstWrite = () => { order.push(`finish:${n}`); resolve(); };
      });
    }
    order.push(`finish:${n}`);
    return Promise.resolve();
  };

  STATE.queue = [{ roomId: "1" }];
  const firstCall = persistJob();
  const secondCall = persistJob();

  await flushAsync();
  assert.deepEqual(order, ["start:1"], "the second call must not even start chrome.storage.local.set() while the first one is still pending");

  resolveFirstWrite();
  await Promise.all([firstCall, secondCall]);

  assert.deepEqual(order, ["start:1", "finish:1", "start:2", "finish:2"], "the second write must only begin after the first one has fully finished - the two must never overlap");
});

test("createReport() never silently drops a queued room, even one that never got a result at all (regression: directly requested - \"we cannot tolerate a room being glossed over\" - proves the download side's existing guarantee: the report is built by walking STATE.queue, the full original list, not STATE.results, which only gets an entry once a room is actually processed - a room claimed right as Stop was clicked, between processRoom()'s waitIfPausedOrStopped() check and ever pushing a result, is exactly this case in real operation)", async () => {
  const { STATE, createReport } = freshBackground();

  STATE.queue = [
    { roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", createdDate: "2024-01-01" },
    { roomId: "2", roomName: "Beta", documentsUrl: "https://rooms.docusign.com/rooms/2/documents", createdDate: "2024-01-02" },
    { roomId: "3", roomName: "Gamma", documentsUrl: "https://rooms.docusign.com/rooms/3/documents", createdDate: "2024-01-03" }
  ];
  // Room "2" deliberately has no entry here at all - simulating Stop
  // being clicked in the exact window processRoom() itself documents:
  // claimed, but interrupted before a result was ever pushed.
  STATE.results = [
    { roomId: "1", roomName: "Alpha", documentsUrl: "https://rooms.docusign.com/rooms/1/documents", status: "Downloaded", reason: "Download completed", downloadedFilename: "", downloadId: "1", time: "2026-01-01T00:00:00.000Z" },
    { roomId: "3", roomName: "Gamma", documentsUrl: "https://rooms.docusign.com/rooms/3/documents", status: "Failed", reason: "Bulk download button was not found", downloadedFilename: "", downloadId: "", time: "2026-01-01T00:00:00.000Z" }
  ];

  await createReport();

  const call = global.chrome.downloads.downloadCalls.find(c => c.filename.includes("_Download Reports"));
  assert.ok(call, "expected a Download Report CSV to be written");

  const csvText = decodeURIComponent(call.url.replace("data:text/csv;charset=utf-8,", ""));
  const lines = csvText.split("\n");

  // Every one of the 3 queued rooms must appear as its own row - the
  // header plus exactly 3 data rows, not 2 (which is what STATE.results
  // alone would have produced).
  assert.equal(lines.length, 4, "expected a header row plus one row per queued room, including the one with no result");

  assert.match(lines[1], /"Alpha".*"Downloaded"/, "room 1 should show its real Downloaded result");
  assert.match(lines[2], /"Beta".*"Waiting"/, "room 2 - claimed but never given a result - must still appear, marked Waiting, not silently omitted");
  assert.match(lines[3], /"Gamma".*"Failed"/, "room 3 should show its real Failed result");
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
