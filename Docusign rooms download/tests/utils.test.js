/**************************************************************
 * tests/utils.test.js
 * Covers content/utils.js's pure string/URL/CSV helpers - the functions
 * every scan, download-routing, and CSV-resume code path in this
 * extension is built on. See content/utils.js's own header comment for
 * why this file requires cleanly under Node (its export tail).
 **************************************************************/

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let utils;

before(() => {
  // roomUrlToDocumentsUrl() reads window.location.origin directly (not
  // as a lazily-evaluated default parameter, unlike getRoomIdFromUrl) -
  // it needs a `window` global to exist at all under Node, real or not.
  global.window = { location: { origin: "https://rooms.docusign.com", href: "https://rooms.docusign.com/" } };
  utils = require(path.join(__dirname, "..", "content", "utils.js"));
});

test("cleanName strips filesystem-unsafe characters", () => {
  assert.equal(utils.cleanName('Room "A" <B>:C*D?E|F\\G/H'), "Room -A- -B--C-D-E-F-G-H");
});

test("cleanName collapses internal whitespace and trims", () => {
  assert.equal(utils.cleanName("  Room    Name  \n\t here  "), "Room Name here");
});

test("cleanName falls back to a placeholder for empty/undefined input", () => {
  assert.equal(utils.cleanName(""), "Unnamed Room");
  assert.equal(utils.cleanName(undefined), "Unnamed Room");
  assert.equal(utils.cleanName(null), "Unnamed Room");
});

test("cleanName caps length at 120 characters", () => {
  const long = "A".repeat(200);
  const result = utils.cleanName(long);
  assert.equal(result.length, 120);
});

test("cleanName strips a trailing period (regression: confirmed live - Chrome's downloads API rejects a path segment ending in '.', silently falling back to the flat Downloads root for that room instead of its own folder)", () => {
  assert.equal(utils.cleanName("Smith Properties LLC."), "Smith Properties LLC");
  assert.equal(utils.cleanName("Jones Realty Inc."), "Jones Realty Inc");
});

test("cleanName strips a trailing space", () => {
  assert.equal(utils.cleanName("Room Name "), "Room Name");
});

test("cleanName strips a run of trailing periods and spaces, however they're interleaved", () => {
  assert.equal(utils.cleanName("Some Room. . ."), "Some Room");
});

test("cleanName does not strip a period that isn't trailing - only the end of the name matters", () => {
  assert.equal(utils.cleanName("St. James Properties"), "St. James Properties");
});

test("cleanName re-checks for a trailing period/space after the 120-char length cap, in case truncation exposed a new one", () => {
  const input = "A".repeat(119) + ". more text that gets cut off";
  const result = utils.cleanName(input);
  assert.equal(result.length, 119, "the trailing period exposed by slicing to 120 chars must also be stripped");
  assert.ok(!result.endsWith("."), "must not end in a period");
});

test("cleanName falls back to 'Unnamed Room' if stripping trailing periods/spaces leaves nothing", () => {
  assert.equal(utils.cleanName("..."), "Unnamed Room");
  assert.equal(utils.cleanName("   "), "Unnamed Room");
});

test("cleanName appends an underscore to a Windows reserved device name", () => {
  assert.equal(utils.cleanName("CON"), "CON_");
  assert.equal(utils.cleanName("con"), "con_");
  assert.equal(utils.cleanName("NUL"), "NUL_");
  assert.equal(utils.cleanName("COM1"), "COM1_");
});

test("cleanName does not treat a name merely containing a reserved word as reserved - only an exact match counts", () => {
  assert.equal(utils.cleanName("CONstruction Room"), "CONstruction Room");
  assert.equal(utils.cleanName("NULL Properties"), "NULL Properties");
});

// Regression test using the exact room names pulled from a real 8000-room
// production run's Download Report CSV - every one of these landed in the
// flat Downloads root instead of its own Docusign Rooms/<name>/ folder,
// each logging "Unchecked runtime.lastError: Invalid filename" in the
// service worker console, confirmed by cross-referencing the CSV's Room
// Name column (not the Downloaded Filename column, which Chrome
// overwrites with its own fallback name once it rejects ours - easy to
// mix up, as happened once already while diagnosing this live). Kept as
// one grouped test, not five, since it's a single incident with a single
// confirmed shape (trailing period), not five independent behaviors.
test("cleanName fixes every real room name confirmed live to have caused a misrouted download (regression, not a hypothetical)", () => {
  const confirmedBadNames = [
    "NJ-77, Bridgeton, NJ, USA.",
    "124 Rosman Rd.",
    "Greenberg - 156 Pine St.",
    "1 Landmark Sq.",
    "693 Squaw Brook Rd."
  ];

  for (const name of confirmedBadNames) {
    const result = utils.cleanName(name);
    assert.ok(!/[.\s]$/.test(result), `"${name}" must not clean to something ending in a period/space (got "${result}")`);
    assert.equal(result, name.replace(/\.$/, ""), `"${name}" should clean to itself minus the trailing period`);
  }
});

test("getRoomIdFromUrl extracts the numeric room ID", () => {
  assert.equal(utils.getRoomIdFromUrl("https://rooms.docusign.com/rooms/2977525/documents"), "2977525");
  assert.equal(utils.getRoomIdFromUrl("https://rooms.docusign.com/rooms/42"), "42");
});

test("getRoomIdFromUrl returns an empty string when there's no room ID in the URL", () => {
  assert.equal(utils.getRoomIdFromUrl("https://rooms.docusign.com/dashboard"), "");
  assert.equal(utils.getRoomIdFromUrl(""), "");
});

test("roomUrlToDocumentsUrl normalizes a room URL to the canonical /documents form", () => {
  assert.equal(
    utils.roomUrlToDocumentsUrl("https://rooms.docusign.com/rooms/2977525"),
    "https://rooms.docusign.com/rooms/2977525/documents"
  );
  assert.equal(
    utils.roomUrlToDocumentsUrl("https://rooms.docusign.com/rooms/2977525/documents?tab=all"),
    "https://rooms.docusign.com/rooms/2977525/documents"
  );
});

test("roomUrlToDocumentsUrl returns null for a URL that isn't a room URL", () => {
  assert.equal(utils.roomUrlToDocumentsUrl("https://rooms.docusign.com/dashboard"), null);
  assert.equal(utils.roomUrlToDocumentsUrl("not a url at all"), null);
});

test("parseCsv handles plain unquoted fields", () => {
  const rows = utils.parseCsv("a,b,c\n1,2,3");
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "2", "3"]]);
});

test("parseCsv handles quoted fields with embedded commas and doubled quotes", () => {
  const rows = utils.parseCsv('"Ponchak, LLC","She said ""hi""",42');
  assert.deepEqual(rows, [["Ponchak, LLC", 'She said "hi"', "42"]]);
});

test("parseCsv handles both \\n and \\r\\n line endings", () => {
  const rows = utils.parseCsv("a,b\r\n1,2\nc,d");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["c", "d"]]);
});

test("parseCsv round-trips a value background.js's csvEscape() would produce", () => {
  // csvEscape() always wraps every field in quotes and doubles internal
  // quotes - mirrors that shape here without importing background.js,
  // since utils.js and background.js are tested independently.
  const escaped = '"Room, with a comma","Room with ""quotes"" inside"';
  const rows = utils.parseCsv(escaped);
  assert.deepEqual(rows, [["Room, with a comma", 'Room with "quotes" inside']]);
});

test("formatDateRangeLabel formats a date range as 'YYYY-MM-DD to YYYY-MM-DD'", () => {
  const label = utils.formatDateRangeLabel({
    start: new Date("2026-01-01"),
    end: new Date("2026-03-01")
  });
  assert.equal(label, "2026-01-01 to 2026-03-01");
});

test("formatDateRangeLabel handles a single-day range (From and To the same date)", () => {
  const label = utils.formatDateRangeLabel({
    start: new Date("2026-06-15"),
    end: new Date("2026-06-15")
  });
  assert.equal(label, "2026-06-15 to 2026-06-15");
});

test("parseWorkerTabCountInput passes through an in-range integer string unchanged", () => {
  assert.equal(utils.parseWorkerTabCountInput("3", 1, 8, 3), 3);
  assert.equal(utils.parseWorkerTabCountInput("1", 1, 8, 3), 1);
  assert.equal(utils.parseWorkerTabCountInput("8", 1, 8, 3), 8);
});

test("parseWorkerTabCountInput clamps values outside [min, max]", () => {
  assert.equal(utils.parseWorkerTabCountInput("0", 1, 8, 3), 1);
  assert.equal(utils.parseWorkerTabCountInput("-5", 1, 8, 3), 1);
  assert.equal(utils.parseWorkerTabCountInput("20", 1, 8, 3), 8);
});

test("parseWorkerTabCountInput rounds a non-integer to the nearest whole number", () => {
  assert.equal(utils.parseWorkerTabCountInput("3.4", 1, 8, 3), 3);
  assert.equal(utils.parseWorkerTabCountInput("3.6", 1, 8, 3), 4);
});

test("parseWorkerTabCountInput falls back to the given default for an emptied field, not the string 'the number zero'", () => {
  // A cleared <input type="number"> has .value === "" - Number("") is 0,
  // a real finite number that would otherwise clamp up to `min` instead
  // of falling back, silently treating "cleared" as "asked for zero."
  assert.equal(utils.parseWorkerTabCountInput("", 1, 8, 3), 3);
});

test("parseWorkerTabCountInput falls back to the given default for non-numeric input", () => {
  assert.equal(utils.parseWorkerTabCountInput("not a number", 1, 8, 3), 3);
  assert.equal(utils.parseWorkerTabCountInput("NaN", 1, 8, 3), 3);
});

test("describeWorkerEvent describes every logWorkerEvent() type background.js actually emits", () => {
  assert.equal(
    utils.describeWorkerEvent({ type: "service_worker_started", hasPersistedJob: true, persistedQueueLength: 6 }),
    "Service worker started (found a job, 6 rooms)"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "service_worker_started", hasPersistedJob: false, persistedQueueLength: 0 }),
    "Service worker started (no persisted job)"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "resume_skipped", reason: "no persisted job" }),
    "Resume skipped: no persisted job"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "run_resumed", pendingCount: 2, totalQueue: 6 }),
    "Resumed: 2 of 6 rooms still pending"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "worker_tab_created", tabId: 42 }),
    "Worker tab created (tab 42)"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "worker_tab_dead", tabId: 42 }),
    "Worker tab 42 found dead"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "worker_tab_replaced", oldTabId: 42, newTabId: 43 }),
    "Worker tab 42 replaced with tab 43"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "worker_tab_replace_failed", tabId: 42 }),
    "Could not replace dead worker tab 42 - one worker is now down for the rest of this run"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "waiting_for_downloads_to_settle", count: 1 }),
    "Waiting for 1 download to finish before writing the report"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "waiting_for_downloads_to_settle", count: 3 }),
    "Waiting for 3 downloads to finish before writing the report"
  );
});

test("describeWorkerEvent falls back to the raw event type for an unrecognized type, instead of throwing", () => {
  assert.equal(utils.describeWorkerEvent({ type: "some_future_event" }), "some_future_event");
});

test("describeWorkerEvent describes a report_failed event for both the download report and the activity log", () => {
  assert.equal(
    utils.describeWorkerEvent({ type: "report_failed", stage: "download_report", error: "URI malformed" }),
    "Failed to write the download report CSV: URI malformed"
  );
  assert.equal(
    utils.describeWorkerEvent({ type: "report_failed", stage: "activity_log", error: "URI malformed" }),
    "Failed to write the activity log CSV: URI malformed"
  );
});

const DOWNLOAD_REPORT_HEADER = [
  "Room #", "Room Name", "Room ID", "Documents URL", "Status", "Reason", "Downloaded Filename", "Download ID", "Time"
];

test("parseUploadedCsv returns empty lists for a CSV with only a header row (or nothing)", () => {
  assert.deepEqual(utils.parseUploadedCsv([]), { rooms: [], priorResults: [] });
  assert.deepEqual(utils.parseUploadedCsv([DOWNLOAD_REPORT_HEADER]), { rooms: [], priorResults: [] });
});

test("parseUploadedCsv returns empty lists when there's no 'Documents URL' column at all - not a CSV this extension could have exported", () => {
  const rows = [["Name", "Notes"], ["A Room", "some note"]];
  assert.deepEqual(utils.parseUploadedCsv(rows), { rooms: [], priorResults: [] });
});

test("parseUploadedCsv skips rows with no Documents URL", () => {
  const rows = [
    DOWNLOAD_REPORT_HEADER,
    ["1", "Room A", "1", "", "Waiting", "Not yet processed", "", "", ""]
  ];
  const result = utils.parseUploadedCsv(rows);
  assert.deepEqual(result.rooms, []);
  assert.deepEqual(result.priorResults, []);
});

test("parseUploadedCsv routes a 'Downloaded' row to priorResults, not rooms", () => {
  const rows = [
    DOWNLOAD_REPORT_HEADER,
    ["1", "Room A", "1", "https://rooms.docusign.com/rooms/1/documents", "Downloaded", "Download completed", "Docusign Rooms/Room A/Room A.zip", "42", "2026-01-01T00:00:00.000Z"]
  ];
  const result = utils.parseUploadedCsv(rows);

  assert.equal(result.rooms.length, 0);
  assert.equal(result.priorResults.length, 1);
  assert.equal(result.priorResults[0].status, "Downloaded");
  assert.equal(result.priorResults[0].roomId, "1");
  assert.equal(result.priorResults[0].downloadId, "42");
});

test("parseUploadedCsv routes a 'Complete (Empty)' row to priorResults too (regression: previously only 'Downloaded' skipped re-processing, wasting time re-checking rooms already confirmed empty)", () => {
  const rows = [
    DOWNLOAD_REPORT_HEADER,
    ["1", "Empty Room", "1", "https://rooms.docusign.com/rooms/1/documents", "Complete (Empty)", "Room is empty (0 documents)", "", "", "2026-01-01T00:00:00.000Z"]
  ];
  const result = utils.parseUploadedCsv(rows);

  assert.equal(result.rooms.length, 0, "an already-confirmed-empty room must not be re-queued for processing");
  assert.equal(result.priorResults.length, 1);
  assert.equal(result.priorResults[0].status, "Complete (Empty)");
  assert.equal(result.priorResults[0].reason, "Room is empty (0 documents)");
});

test("parseUploadedCsv still queues 'Failed', 'Success/Attempted', and 'Waiting' rows for (re-)processing", () => {
  const rows = [
    DOWNLOAD_REPORT_HEADER,
    ["1", "Room A", "1", "https://rooms.docusign.com/rooms/1/documents", "Failed", "Bulk download button was not found", "", "", ""],
    ["2", "Room B", "2", "https://rooms.docusign.com/rooms/2/documents", "Success/Attempted", "Download click attempted", "", "", ""],
    ["3", "Room C", "3", "https://rooms.docusign.com/rooms/3/documents", "Waiting", "Not yet processed", "", "", ""]
  ];
  const result = utils.parseUploadedCsv(rows);

  assert.equal(result.rooms.length, 3);
  assert.equal(result.priorResults.length, 0);
  assert.deepEqual(result.rooms.map(r => r.roomId), ["1", "2", "3"]);
});

test("parseUploadedCsv treats a plain Scan List CSV (no Status column) as everything needing processing", () => {
  const rows = [
    ["Room #", "Room Name", "Room ID", "Documents URL", "Created Date"],
    ["1", "Room A", "1", "https://rooms.docusign.com/rooms/1/documents", "2026-01-01"]
  ];
  const result = utils.parseUploadedCsv(rows);

  assert.equal(result.rooms.length, 1);
  assert.equal(result.priorResults.length, 0);
});
