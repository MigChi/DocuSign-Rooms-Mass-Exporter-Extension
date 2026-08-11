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
