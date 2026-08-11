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
});

test("describeWorkerEvent falls back to the raw event type for an unrecognized type, instead of throwing", () => {
  assert.equal(utils.describeWorkerEvent({ type: "some_future_event" }), "some_future_event");
});
