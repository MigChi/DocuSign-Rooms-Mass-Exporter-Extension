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

test("computeFolderNames gives every room a plain name when nothing collides", () => {
  const { computeFolderNames } = freshBackground();

  const queue = [
    { roomId: "1", roomName: "Alpha" },
    { roomId: "2", roomName: "Beta" }
  ];

  const folderNames = computeFolderNames(queue);

  assert.equal(folderNames.get("1"), "Alpha");
  assert.equal(folderNames.get("2"), "Beta");
});

test("computeFolderNames appends the room ID only for rooms whose name collides in this run (regression: two 'Ponchak - Listing' rooms sharing one folder)", () => {
  const { computeFolderNames } = freshBackground();

  const queue = [
    { roomId: "2977526", roomName: "Ponchak - Listing" },
    { roomId: "2977529", roomName: "Ponchak - Listing" },
    { roomId: "3000000", roomName: "Unrelated Room" }
  ];

  const folderNames = computeFolderNames(queue);

  assert.equal(folderNames.get("2977526"), "Ponchak - Listing (2977526)");
  assert.equal(folderNames.get("2977529"), "Ponchak - Listing (2977529)");
  assert.equal(folderNames.get("3000000"), "Unrelated Room");
  // The two disambiguated names must actually be distinct from each other -
  // the whole point of the fix.
  assert.notEqual(folderNames.get("2977526"), folderNames.get("2977529"));
});

test("computeFolderNames falls back to a generated name when roomName is missing", () => {
  const { computeFolderNames } = freshBackground();

  const folderNames = computeFolderNames([{ roomId: "99", roomName: "" }]);

  assert.equal(folderNames.get("99"), "Docusign Room 99");
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
