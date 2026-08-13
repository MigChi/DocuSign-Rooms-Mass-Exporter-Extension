/**************************************************************
 * Docusign Rooms Mass Exporter - background.js
 * Handles the worker-tab pool, pause/resume/stop, filename routing,
 * chrome.storage.local persistence, and the final CSV report.
 *
 * Service workers and content scripts run in separate JS contexts -
 * background.js can't reference content/utils.js's globals the way
 * scan.js/room.js/content.js do just by manifest load order, so it
 * loads the same file directly via importScripts(). utils.js is plain
 * global function declarations (no export/import), so it works
 * unmodified here - getRoomIdFromUrl's window.location.href default and
 * roomUrlToDocumentsUrl's window.location.origin fallback are both only
 * reached if called with no/a relative URL, which never happens from
 * this file (every call site here passes an already-absolute URL).
 **************************************************************/

// importScripts only exists in a real service worker - the `require`
// branch runs instead under Node (tests/), loading the same file so
// cleanName/getRoomIdFromUrl/etc. end up as real globals here exactly as
// they do in production (see content/utils.js's own export-tail comment).
if (typeof importScripts === "function") {
  importScripts("content/utils.js");
} else if (typeof require === "function") {
  require("./content/utils.js");
}

// User-configurable now (see clampWorkerTabCount() below and the panel's
// "Worker Tabs" field), no longer a hardcoded constant - but still bounded
// rather than an open number field. The upper bound exists because several
// 10k-scale risks are still under active investigation at the default of
// 3 (worker tabs dying, chrome.storage.local's quota, DocuSign rate-
// limiting) - letting someone dial this up to 20 before those are
// resolved would compound exactly the risks being chased down, not help
// diagnose them. This is a stepping stone toward Roadmap item 3's
// original plan (suggesting a value from measured per-room timing, see
// DESIGN.md Decision 8) - manual control now, automatic suggestion later.
const DEFAULT_WORKER_TAB_COUNT = 3;
const MIN_WORKER_TAB_COUNT = 1;
const MAX_WORKER_TAB_COUNT = 8;

// Coerces arbitrary input (a message field from content.js, or a value
// restored from chrome.storage.local written by a previous version that
// didn't have this field at all) into a safe integer in
// [MIN_WORKER_TAB_COUNT, MAX_WORKER_TAB_COUNT]. Anything not a finite
// number - missing, a string, NaN, Infinity - falls back to the default
// rather than being clamped, since clamping garbage input toward a bound
// would silently accept it as if it were a deliberate (if extreme) choice.
function clampWorkerTabCount(value) {
  // Checked explicitly, before the Number() coercion below - Number(null)
  // is 0, a real finite number that Number.isFinite() would accept and
  // then clamp up to MIN_WORKER_TAB_COUNT, silently treating "missing"
  // the same as "the user asked for zero." Empty string (an emptied
  // <input>) gets the same treatment for the same reason.
  if (value === null || value === undefined || value === "") return DEFAULT_WORKER_TAB_COUNT;

  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WORKER_TAB_COUNT;
  return Math.min(MAX_WORKER_TAB_COUNT, Math.max(MIN_WORKER_TAB_COUNT, Math.round(n)));
}

const STATE = {
  running: false,
  paused: false,
  stopped: false,
  // The full original room list for THIS run - immutable once set,
  // never shrunk. createReport() walks this (not `pending`) so every
  // room that was ever part of the run gets a row, whether or not it's
  // been processed yet.
  queue: [],
  // The working list workers actually claim from - only rooms without a
  // recorded result yet. Rebuilt (not just resumed from a saved index)
  // on startup after a crash - see the resume block at the bottom of
  // this file for why an index alone isn't safe once multiple tabs can
  // claim concurrently.
  pending: [],
  // Index into `pending` - the one piece of shared mutable state every
  // worker touches. claimNextRoom() is the only function allowed to
  // read or write it, and does so with zero `await` inside, which is
  // what makes concurrent claiming safe without an explicit lock (see
  // DESIGN.md Decision 3).
  index: 0,
  workerTabIds: [],
  // Set from the panel's "Worker Tabs" field via DS_START_QUEUE (clamped
  // by clampWorkerTabCount()), read by runQueue() when deciding how many
  // tabs to open. Persisted so a resumed run keeps using the same count
  // it started with, rather than silently reverting to the default.
  workerTabCount: DEFAULT_WORKER_TAB_COUNT,
  // "2026-01-01 to 2026-03-01" - set from the panel's live scan (see
  // formatDateRangeLabel() in content.js), null for a run started from
  // an uploaded CSV (no date range exists in that case). Read by
  // createReport() and createEventLogReport() at the end of a run so
  // their filenames are identifiable without opening them; persisted so
  // a resumed run's eventual report still carries the original run's
  // label instead of losing it partway through.
  runDateRangeLabel: null,
  // Scan-relay state (see the DS_RUN_SCAN family of handlers below and
  // DESIGN.md's write-up on the detached panel window) - a live scan
  // needs real DOM access to a Docusign tab (content.js/content/scan.js),
  // but the panel that requests one now lives in a separate extension
  // window with no DOM access of its own, so background.js brokers
  // between them the same way it already brokers per-room work between
  // the panel and a worker tab. Not persisted - a scan is never resumed
  // across a service-worker restart the way a download run is; if the
  // worker dies mid-scan, the scan is simply gone, same as it always was
  // when scanning lived entirely inside one content-script execution.
  scanning: false,
  scanTabId: null,
  scanMode: null,
  scanDateRangeLabel: null,
  // Stable filename reused across every DS_SCAN_CHECKPOINT write for the
  // current scan (see that handler's own comment) - computed once when the
  // scan starts, not per-checkpoint, so repeated checkpoint saves actually
  // overwrite the same file instead of each getting its own timestamp.
  scanCheckpointFilename: null,
  // Timestamp of the most recent sign of life from an active scan
  // (DS_SCAN_PROGRESS or DS_SCAN_CHECKPOINT arriving) - what the
  // chrome.alarms-driven watchdog below compares against to detect a
  // scan tab that's gone silent (crashed - "Aw, Snap!" - or hung) without
  // ever being closed or navigated away from, the one case
  // chrome.tabs.onRemoved/onUpdated structurally can't catch, since the
  // tab itself never changes state in either of those observable ways.
  lastScanActivityAt: null,
  // Keyed by tabId - was a single STATE.currentRoom object before
  // concurrency, since only one room was ever in flight at a time. Now
  // there's one entry per active worker tab.
  currentRooms: {},
  // roomId -> {year, roomFolderName}, computed once by computeFolderNames()
  // whenever STATE.queue is set. Not persisted - it's a pure function of
  // the queue, cheap to rebuild on resume, so there's no reason to treat
  // it as state that could drift out of sync with the queue it's derived
  // from.
  folderNames: new Map(),
  results: [],
  downloads: {},
  startedAt: null,
  finishedAt: null,
  // Lifecycle history for worker tabs and the service worker itself
  // (created, found dead, replaced, replace failed, service worker
  // started, resume attempted/skipped-and-why) - see logWorkerEvent()
  // below. Persisted (see persistJob()) specifically because the one
  // event most worth seeing - a service worker restart - is also the
  // one event that wipes this in-memory array if it isn't.
  workerEvents: []
};

const PERSIST_KEY = "dsJob";
const MAX_WORKER_EVENTS = 300;

// Name for the chrome.alarms-driven scan-stall watchdog (see its own
// listener, near the tab-lifecycle listeners below) and how long a scan
// can go without any sign of life (a DS_SCAN_PROGRESS or
// DS_SCAN_CHECKPOINT message) before it's treated as stalled. 2 minutes
// is comfortably longer than any single legitimate step in the scan loop
// (a scroll+wait cycle is ~1.5-2s; even the slowest normal operation -
// waiting for the sort-order popover at scan start - is bounded well
// under a minute), so a silence this long is a strong, safe signal
// something is genuinely wrong, not a false positive from an unusually
// slow page.
const SCAN_WATCHDOG_ALARM = "scanStallWatchdog";
const SCAN_STALL_THRESHOLD_MS = 2 * 60 * 1000;

// Console-logs immediately (visible in the SERVICE WORKER console) and
// appends to STATE.workerEvents, trimmed to the most recent
// MAX_WORKER_EVENTS so a very long run doesn't grow this unboundedly.
// Exists because "did the dead worker tab actually get replaced" and
// "did resume actually fire, and if not, why not" were both real
// questions during live testing with no way to answer them after the
// fact once the service worker (and its in-memory STATE) had already
// restarted.
function logWorkerEvent(type, detail = {}) {
  const event = { time: new Date().toISOString(), type, ...detail };
  STATE.workerEvents.push(event);
  if (STATE.workerEvents.length > MAX_WORKER_EVENTS) {
    STATE.workerEvents = STATE.workerEvents.slice(-MAX_WORKER_EVENTS);
  }
  console.log("[DSBD]", type, detail);
  return event;
}

// MV3 service workers are ephemeral - Chrome can and will kill this one
// mid-run, wiping everything above since it's just an in-memory object.
// Snapshotting the resumable fields to chrome.storage.local at natural
// checkpoints (run start, per-room completion, pause/resume) means the
// startup check at the bottom of this file can pick a run back up
// instead of losing it outright. Not called from broadcastStatus() (that
// fires ~once/second while paused) to avoid writing on every tick -
// only at points that actually change resumable state.
//
// Deliberately does NOT persist `pending`/`index` - only `queue` (the
// full list) and `results` (what's actually finished). Resume is
// recomputed as "queue minus anything with a result" rather than
// "continue from index N," which matters once concurrency is in play:
// with several tabs claiming at once, `index` can already be past
// several rooms that were claimed but never finished when a crash
// happens. Resuming from a saved index would silently drop those rooms
// instead of retrying them - recomputing from queue/results instead
// means anything without a result, claimed-but-interrupted or never
// reached at all, is naturally included again.
// Never throws - both storage calls are wrapped so a failed write (quota,
// or any other chrome.storage error) can't escape as a rejected promise.
// This matters more than it did pre-concurrency: persistJob() is called
// from inside processRoom()'s catch block, with no further try/catch
// around it there - an uncaught throw there would propagate out of
// processRoom(), out of runWorker(), and reject the Promise.all() in
// runQueue(), which would skip every bit of cleanup after it (including
// resetting STATE.running), leaving the run permanently stuck and any
// still-running sibling workers orphaned. A missed checkpoint write is
// a much smaller problem than that - worth degrading gracefully for.
//
// Every call - from persistJob() or clearPersistedJob() directly - is
// serialized through this one shared chain rather than issued the moment
// it's called. Confirmed directly, not assumed: chrome.storage's own
// documentation and the Chromium extensions team both describe it as "a
// relatively simple asynchronous key-value store... wasn't designed to
// be ACID compliant," with no ordering guarantee of its own for
// concurrent set() calls to the same key. Multiple worker tabs genuinely
// do call persistJob() at effectively the same time in real operation -
// each reaches its own call via an independently-timed chain of awaits
// inside processRoom() (page loads, the 90s room-processing bound,
// download-start polling), so two calls overlapping in flight is the
// normal case at real concurrency, not an edge case. Without this, a
// write that happens to *complete* later - even though it was *issued*
// earlier, reflecting an older, less-complete snapshot - could silently
// overwrite a newer one purely by timing, discarding whichever worker's
// result lost that race from the *persisted* copy (STATE itself, in
// memory, is never affected either way - only what chrome.storage.local
// would resume from after a crash). Chaining every call onto
// `persistChain` - the same pattern already proven for panel.js's
// confirmDialogChain - means writes are never actually concurrent at the
// chrome.storage API level at all, so correctness no longer depends on
// an implementation detail this project has no control over and no way
// to verify stays stable across Chrome versions.
let persistChain = Promise.resolve();

function persistJob() {
  const run = async () => {
    if (!STATE.queue.length) {
      try {
        await chrome.storage.local.remove(PERSIST_KEY);
      } catch (e) {
        console.warn("persistJob: chrome.storage.local.remove failed", e);
      }
      return;
    }

    try {
      await chrome.storage.local.set({
        [PERSIST_KEY]: {
          queue: STATE.queue,
          results: STATE.results,
          paused: STATE.paused,
          startedAt: STATE.startedAt,
          workerEvents: STATE.workerEvents,
          workerTabCount: STATE.workerTabCount,
          runDateRangeLabel: STATE.runDateRangeLabel
        }
      });
    } catch (e) {
      console.warn("persistJob: chrome.storage.local.set failed, continuing without this checkpoint", e);
    }
  };

  const next = persistChain.then(run);
  persistChain = next;
  return next;
}

function clearPersistedJob() {
  const run = async () => {
    try {
      await chrome.storage.local.remove(PERSIST_KEY);
    } catch (e) {
      console.warn("clearPersistedJob: chrome.storage.local.remove failed", e);
    }
  };

  const next = persistChain.then(run);
  persistChain = next;
  return next;
}

// Two different rooms can share the same cleaned name (confirmed live:
// two distinct rooms, different IDs, both named "Ponchak - Listing") -
// without disambiguation both would target the exact same folder path,
// and while conflictAction: "uniquify" keeps both ZIPs safely inside it
// under slightly different filenames, they'd be indistinguishable
// without opening the folder and checking each file. Appends the room
// ID only to names that actually collide within this run, so the
// common case (no collision) keeps the plain, readable name. Computed
// once whenever STATE.queue is set, not recomputed per-download.
//
// Collisions are scoped per (year, name), not just name - rooms now land
// in Docusign Rooms/<year>/<Room Name>/, so two identically-named rooms
// created in different years no longer actually share a folder and don't
// need the (roomId) suffix; only a same-name collision *within* the same
// year folder does. roomCreatedYear() (content/utils.js) is what decides
// the year - see its own comment for why it's UTC-based, and why a room
// with no usable createdDate falls into "Unassigned" rather than being
// silently misfiled or dropped.
function computeFolderNames(queue) {
  const keyCounts = new Map();

  queue.forEach(room => {
    const year = roomCreatedYear(room.createdDate);
    const name = cleanName(room.roomName || `Docusign Room ${room.roomId}`);
    keyCounts.set(`${year}/${name}`, (keyCounts.get(`${year}/${name}`) || 0) + 1);
  });

  const folderNames = new Map();

  queue.forEach(room => {
    const year = roomCreatedYear(room.createdDate);
    const name = cleanName(room.roomName || `Docusign Room ${room.roomId}`);
    const roomFolderName = keyCounts.get(`${year}/${name}`) > 1 ? `${name} (${room.roomId})` : name;
    folderNames.set(room.roomId, { year, roomFolderName });
  });

  return folderNames;
}

// Pure matching logic, factored out from findVerifiedExistingDownloads()
// below so it's testable without mocking chrome.downloads.search() - given
// a list of already-fetched DownloadItems and a list of rooms not yet
// confirmed downloaded ("Success/Attempted" from this run's own results,
// checked right before the report is written, or "Success/Attempted" or
// "Waiting" rooms coming off an uploaded CSV on a resume - see the two
// call sites), returns roomId -> the matched DownloadItem for every room
// a real, complete, still-existing download can be tied to.
//
// Matches by roomId extracted from the download's own url/finalUrl/
// referrer - the exact same /rooms/<id>/ or /transaction/<id>/ pattern
// findCurrentRoomForDownload() already trusts to identify a live download
// (Decision 2's second correction) - not by filename. An earlier version
// of this function matched by cleaned room name instead, on the theory
// that it would work regardless of which folder-path scheme (old flat vs
// new year-folder, Decision 25) the file happened to land under. That
// version had a real, confirmed bug: two genuinely different rooms that
// happen to share a cleaned display name (a plain address or a generic
// name like "Rental" reused across different years/clients is an actual,
// observed pattern in this project's real data, not a hypothetical) are
// indistinguishable by name alone - a completed download that actually
// belongs to one room would incorrectly verify a *different*, entirely
// unrelated, never-downloaded room of the same name, silently marking it
// "Downloaded" and skipping it for good. Confirmed directly before this
// fix: `matchVerifiedDownloads([{filename: ".../2021/Main St Listing/
// Main St Listing.zip"}], [{roomId: "200", roomName: "Main St Listing"}])`
// returned a match for room 200 even though the existing file belonged to
// an entirely different room. A same-leaf-name-but-different-full-path
// exclusion rule was tried next and still didn't close the gap - the
// false match above involves exactly *one* existing file, not two
// competing ones, so nothing about counting duplicate leaf names touches
// it. roomId is unique per room by construction, so matching on it
// structurally cannot produce this class of false positive the way any
// name-based approach can.
function matchVerifiedDownloads(existingItems, rooms) {
  const roomIdsWanted = new Set((rooms || []).map(room => room.roomId));
  const itemByRoomId = new Map();

  (existingItems || []).forEach(item => {
    for (const candidate of [item.url, item.finalUrl, item.referrer]) {
      const match = String(candidate || "").match(/\/(?:rooms|transaction)\/(\d+)/i);
      if (match && roomIdsWanted.has(match[1])) {
        itemByRoomId.set(match[1], item);
        break;
      }
    }
  });

  return itemByRoomId;
}

// Queries Chrome's own persistent download history (chrome.downloads.search -
// already covered by this extension's existing "downloads" permission, no
// manifest change needed) for every completed, still-on-disk download
// whose filename mentions "Docusign Rooms," then matches it against a set
// of rooms not yet confirmed downloaded. "Success/Attempted" means a
// download was genuinely triggered, just never confirmed complete,
// sometimes really did finish (the completion event was never recorded at
// all - the tab closed or crashed right after triggering it, or the
// service worker restarted before that event fired). "Waiting" (only
// possible on a CSV-upload resume, never in this run's own live results)
// means something different but just as worth checking: it only says
// *this* run's queue never reached the room - not that no earlier,
// separate run ever downloaded it. Either way, re-clicking Select All/
// Download for a room that already has a real file risks a genuine
// duplicate ZIP rather than fixing anything. Two callers:
// verifySuccessAttemptedResults() checks this run's own results (always
// "Success/Attempted" only - "Waiting" can't appear there) right before
// the report is written, and DS_START_QUEUE checks rooms coming off an
// uploaded CSV before queueing them for reprocessing (catches older
// reports predating the first
// check, or where the gap was never caught the first time). One bulk
// search, not one per room - chrome.downloads history can be large, and
// a native call per room would add up needlessly. Never throws: a
// failed/unavailable search just means nothing gets verified, degrading
// to the pre-existing behavior rather than blocking anything.
async function findVerifiedExistingDownloads(rooms) {
  if (!rooms.length) return new Map();

  const items = await chrome.downloads.search({
    state: "complete",
    exists: true,
    filenameRegex: "Docusign Rooms"
  }).catch(() => []);

  return matchVerifiedDownloads(items, rooms);
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

// encodeURIComponent() throws URIError: "URI malformed" if given a string
// containing a lone (unpaired) UTF-16 surrogate - vanishingly unlikely to
// hit in a small test run, but confirmed live at real scale: an 8000-room
// scan's CSV export got stuck forever with no error ever shown, consistent
// with exactly this throw happening somewhere inside 8000 real room names
// pulled from a live account, uncaught, leaving the message's sendResponse()
// never called. Falls back to replacing only the genuinely unpaired
// surrogates (U+FFFD) and retrying, rather than losing an entire 8000-room
// export over one bad character in one room's name - a valid surrogate
// pair (e.g. an emoji in a room name) is left untouched, since the fast
// path above only fails at all when something in the string isn't valid.
function safeEncodeURIComponent(str) {
  try {
    return encodeURIComponent(str);
  } catch (e) {
    const sanitized = str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
    return encodeURIComponent(sanitized);
  }
}

// Shared by every CSV export (scan list, download report, activity log)
// so all three follow one naming convention rather than three slightly
// different ones. `dateRangeLabel` is optional - null for anything not
// tied to a scanned date range (a CSV-upload-based run has no date range
// at all) - in which case this degrades to the plain "<name> <timestamp>"
// shape these exports always used before this existed. Run through
// cleanName() defensively even though the only real producer of this
// label (content.js's formatDateRangeLabel()) only ever emits digits,
// hyphens, spaces, and the word "to" - every other filename-building
// path in this file already treats untrusted-looking strings this way,
// and there's no reason for the one built from a date range to be the
// exception.
function labeledFilename(baseName, dateRangeLabel) {
  const label = dateRangeLabel ? ` (${cleanName(dateRangeLabel)})` : "";
  return `${baseName}${label} ${nowStamp()}`;
}

// chrome.power.requestKeepAwake("display") tells the OS not to sleep, dim,
// or lock the display for as long as it's held - a direct mitigation for a
// real, reported failure: a scan stalling out (or, worse, a run's report
// getting misrouted - see the DS_SCAN_COMPLETE mode-loss risk this same
// incident surfaced) because the computer's screen locked partway through,
// despite the user's own OS-level sleep/lock settings supposedly being
// disabled. Those settings can fail to hold - reset by a software update,
// overridden by a battery-vs-power-adapter profile switch, a policy on a
// managed device - in ways this extension has no visibility into and can't
// rely on; asking the OS directly, for as long as real work is actually
// happening, doesn't depend on any of that. requestKeepAwake()/
// releaseKeepAwake() are idempotent per Chrome's own documented behavior,
// so calling either redundantly is harmless - called after every
// STATE.running/STATE.scanning transition rather than tracked as a third
// flag of its own, so it can never drift out of sync with what's actually
// active. Wrapped defensively even though neither call is documented to
// throw - chrome.power is a newly-declared permission (manifest.json) and
// this shouldn't be the one line standing between an unrelated failure and
// STATE getting stuck the same way every fix in Decision 33/34 exists to
// prevent.
function updateKeepAwake() {
  try {
    if (STATE.running || STATE.scanning) {
      chrome.power.requestKeepAwake("display");
    } else {
      chrome.power.releaseKeepAwake();
    }
  } catch (e) {
    console.warn("updateKeepAwake failed", e);
  }
}

async function broadcastStatus() {
  const payload = {
    type: "DS_BULK_STATUS",
    state: {
      running: STATE.running,
      paused: STATE.paused,
      stopped: STATE.stopped,
      total: STATE.queue.length,
      activeCount: Object.keys(STATE.currentRooms).length,
      currentRooms: Object.values(STATE.currentRooms),
      // Ordered tab-creation order, stable for the lifetime of a run -
      // lets the panel label rows "Worker 1"/"Worker 2"/... consistently
      // instead of by raw (meaningless-to-a-user) Chrome tab ID.
      workerTabIds: STATE.workerTabIds,
      // Most-recent-last, capped - the full history lives in STATE (and,
      // persisted, across restarts); the panel only needs enough to show
      // "what just happened," not the entire run's history in one message.
      workerEvents: STATE.workerEvents.slice(-20),
      results: STATE.results,
      startedAt: STATE.startedAt,
      finishedAt: STATE.finishedAt,
      scanning: STATE.scanning
    }
  };

  // chrome.runtime.sendMessage() (no tabId - a broadcast), not
  // chrome.tabs.sendMessage() to each Docusign tab as this used to do -
  // the panel is now a standalone extension window, not something
  // injected into the page, so it can only be reached the way any other
  // extension page (options page, popup) receives messages. Content
  // scripts no longer need this broadcast at all now that the panel UI
  // has moved out of them - they only handle DS_PROCESS_ROOM and the
  // scan-relay messages, neither of which reads DS_BULK_STATUS.
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function waitForTabLoaded(tabId, timeoutMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete") return true;
    await sleep(1000);
  }

  return false;
}

// Races `promise` against a timeout, resolving with `timeoutValue` if
// `promise` hasn't settled by then. Every other wait in this pipeline
// (waitForTabLoaded, waitForDownloadStart, waitForInFlightDownloadsToSettle
// above/below) is already bounded this way - processRoom()'s
// chrome.tabs.sendMessage() call to the worker tab was the one real
// exception, and not by design. Confirmed by reasoning through Chrome's own
// extension-messaging semantics: unlike a rejected promise, a response that
// simply never arrives is not something try/catch can do anything about -
// chrome.tabs.sendMessage()'s returned promise stays pending forever unless
// sendResponse() is actually called on the content-script side or the
// tab's port disconnects (it closes or navigates). content.js's own
// DS_PROCESS_ROOM handler is now wrapped in try/catch too (so a thrown
// error reports itself immediately, the common case), but this timeout is
// the only thing that can bound a genuine hang - a page that stops
// responding without throwing, a future page-structure change this
// couldn't anticipate, or any other way sendResponse() might just never
// fire. Without it, that single stuck room would keep its worker's loop
// from ever finishing, which keeps runQueue()'s Promise.all() from ever
// resolving - the entire run hangs forever, not just one room, even with
// every other worker tab long done.
function withTimeout(promise, timeoutMs, timeoutValue) {
  // Explicitly cleared once the race settles, whichever side wins -
  // confirmed as a real resource leak, not just a theoretical one: on the
  // fast/common path (`promise` resolves well before `timeoutMs`), Node
  // still keeps this timer alive and pending for the *entire* `timeoutMs`
  // regardless, since Promise.race() never cancels its losing entries on
  // its own. Left unfixed, that's one dangling 90-second timer
  // accumulating per room processed - across an 8000-room run split over
  // several workers, potentially hundreds pending at once, real
  // memory/event-loop pressure in a service worker whose ephemeral
  // lifecycle already has enough of that to contend with.
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Verifies any previously-known worker tabs are still alive (survives a
// resume, where the old tab IDs from before a crash are almost
// certainly gone) and creates however many more are needed to reach
// `count`. Each one gets fully activated again on every room it
// processes anyway (see processRoom()), so the `active` flag here just
// controls which one is frontmost at creation time, not whether
// downloads work - only the first is set active to avoid every new tab
// popping to the front during startup.
//
// Also shrinks down to `count` if more alive tabs exist than are wanted
// this run - DS_START_QUEUE never resets STATE.workerTabIds between runs
// (worker tabs are deliberately never auto-closed, see runQueue()'s
// completion comment), so starting a second run with a *lower* worker
// count than a previous one in the same service-worker session would
// otherwise silently reuse every still-open tab from before, ignoring
// the new, smaller request entirely. The excess tabs are left open, not
// closed - consistent with this file never closing worker tabs on its
// own - they're just no longer tracked as workers for this run.
async function ensureWorkerTabs(count) {
  const alive = [];

  for (const id of STATE.workerTabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) alive.push(id);
    else logWorkerEvent("worker_tab_dead", { tabId: id, context: "ensureWorkerTabs startup check" });
  }

  STATE.workerTabIds = alive;

  while (STATE.workerTabIds.length < count) {
    const tab = await chrome.tabs.create({
      url: "about:blank",
      active: STATE.workerTabIds.length === 0
    });
    STATE.workerTabIds.push(tab.id);
    logWorkerEvent("worker_tab_created", { tabId: tab.id, context: "ensureWorkerTabs" });
  }

  if (STATE.workerTabIds.length > count) {
    STATE.workerTabIds = STATE.workerTabIds.slice(0, count);
  }

  return STATE.workerTabIds;
}

// Keyed by the exact data: URL used for a CSV export (each one is unique -
// the content differs every time) so the onDeterminingFilename listener
// below can recognize "this is one of our own report exports" and
// suggest() the real intended filename directly, rather than trusting
// chrome.downloads.download()'s own `filename` option alone. Confirmed
// live: for a data: URL, Chrome does not reliably honor that option -
// every CSV this extension exports landed as a generic "download.csv" /
// "download (1).csv" instead of the descriptive, labeled name each of
// createReport()/createEventLogReport()/handleExportScanList() actually
// requests. onDeterminingFilename's own suggest() call is the same
// mechanism already proven reliable for every room ZIP, so reusing it
// here closes the gap with a proven approach rather than guessing at a
// second fix for the same class of problem. Cleaned up by the listener
// itself once consumed - at most 3 entries ever pending at once (one
// run's Scan List, Download Report, and Activity Log), so there's no
// meaningful growth risk even without a cap.
const pendingReportFilenames = new Map();

async function createReport() {
  STATE.finishedAt = new Date().toISOString();

  const rows = [
    [
      "Room #",
      "Room Name",
      "Room ID",
      "Documents URL",
      "Created Date",
      "Status",
      "Reason",
      "Downloaded Filename",
      "Download ID",
      "Time"
    ]
  ];

  // results only gets an entry once a room is actually processed, so
  // walking STATE.queue (the full original list) instead of
  // STATE.results means every room gets a row - a real result if it has
  // one, "Waiting" if it doesn't - so the CSV round-trips through
  // Upload CSV as a genuine resume instead of silently omitting
  // whatever the run never reached.
  const resultsByRoomId = new Map();
  STATE.results.forEach(r => resultsByRoomId.set(r.roomId, r));

  STATE.queue.forEach((room, idx) => {
    const r = resultsByRoomId.get(room.roomId);
    rows.push([
      idx + 1,
      (r?.roomName || room.roomName || ""),
      (r?.roomId || room.roomId || ""),
      (r?.documentsUrl || room.documentsUrl || ""),
      // Read from `room` (STATE.queue), not `r` (STATE.results) - results
      // objects never carry createdDate at all (there was never a reason
      // to duplicate it there), while every queue entry has it already
      // (see DS_START_QUEUE's `normalized` mapping) or falls back to ""
      // via formatCreatedDateForCsv() if it doesn't.
      formatCreatedDateForCsv(room.createdDate),
      r?.status || "Waiting",
      r?.reason || "Not yet processed",
      r?.downloadedFilename || "",
      r?.downloadId || "",
      r?.time || ""
    ]);
  });

  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  const dataUrl = "data:text/csv;charset=utf-8," + safeEncodeURIComponent(csv);
  const filename = `Docusign Rooms/_Download Reports/${labeledFilename("Docusign Rooms Download Report", STATE.runDateRangeLabel)}.csv`;

  pendingReportFilenames.set(dataUrl, filename);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  return filename;
}

// Saved alongside the download report whenever a run ends (finishes or is
// Stopped - see the shared call site in runQueue()), so the diagnostic
// history behind that run doesn't only exist in the panel's Activity Log
// (which the user has to remember to check before it scrolls past its
// cap) or in chrome.storage.local (gone once the job is cleared on
// completion). Exports the full STATE.workerEvents accumulated so far,
// not just this run's slice - it's a lifecycle log of the service worker
// and its worker tabs, not a per-run artifact, and slicing it down would
// mean losing exactly the cross-restart picture Decision 15 built this
// for. Detail fields vary by event type (see logWorkerEvent() callers),
// so they're kept together as one JSON-stringified column rather than
// forcing them into a fixed set of CSV columns most rows wouldn't use.
async function createEventLogReport() {
  const rows = [["Time", "Event Type", "Details"]];

  STATE.workerEvents.forEach(evt => {
    const { time, type, ...detail } = evt;
    rows.push([time, type, JSON.stringify(detail)]);
  });

  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  const dataUrl = "data:text/csv;charset=utf-8," + safeEncodeURIComponent(csv);
  const filename = `Docusign Rooms/_Activity Logs/${labeledFilename("Activity Log", STATE.runDateRangeLabel)}.csv`;

  pendingReportFilenames.set(dataUrl, filename);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  return filename;
}

// Real signal for "this room's download has started," instead of guessing
// with a flat sleep - chrome.downloads.onDeterminingFilename (below)
// populates STATE.downloads the moment Chrome registers a new download.
// Already scoped by roomId rather than tab, so this needed no changes
// for concurrency - multiple simultaneous downloads across tabs each
// just check for their own roomId's entry.
async function waitForDownloadStart(roomId, timeoutMs = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const started = Object.values(STATE.downloads).some(d => d.roomId === roomId);
    if (started) return true;
    await sleep(300);
  }

  return false;
}

// Closes a real report-timing race, confirmed live: runQueue() used to
// call createReport() the instant every worker ran out of rooms to claim
// - but "claimed the last room" and "that room's ZIP finished downloading"
// are different moments. A room whose download was still in flight (click
// succeeded, chrome.downloads.onDeterminingFilename fired, but
// onChanged's "complete" event hadn't arrived yet) got reported as
// "Success/Attempted" instead of "Downloaded" even though the file landed
// fine seconds later - and since parseUploadedCsv() in content.js only
// treats a literal "Downloaded" status as already-done, re-uploading that
// report to resume would re-download a room that had actually already
// succeeded. STATE.downloads entries without completedAt or error are
// still in flight; this polls until none remain or `timeoutMs` elapses,
// whichever first - bounded so one genuinely stalled download (a real
// possibility, not just a race) can't hang run completion indefinitely.
// Whatever hasn't settled by the deadline is still reported as-is,
// same as before this existed - not worse, just not always fully caught up.
async function waitForInFlightDownloadsToSettle(timeoutMs = 20000) {
  const stillUnsettled = () => Object.values(STATE.downloads).filter(d => !d.completedAt && !d.error);

  const pendingCount = stillUnsettled().length;
  if (!pendingCount) return;

  logWorkerEvent("waiting_for_downloads_to_settle", { count: pendingCount });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!stillUnsettled().length) return;
    await sleep(300);
  }
}

// Reconciles this run's own "Success/Attempted" results against Chrome's
// download history before the report gets written, so the very first
// report already reflects reality instead of requiring a separate
// CSV-upload pass just to catch up. waitForInFlightDownloadsToSettle()
// above only covers downloads still tracked in this session's in-memory
// STATE.downloads - it can't catch a download that genuinely finished but
// whose "complete" event was never recorded at all (the tab closed or
// crashed right after triggering it, or the service worker restarted
// before that event fired) - this check covers exactly that gap. Only
// "Success/Attempted" results are checked, never "Failed" - see
// findVerifiedExistingDownloads()'s own comment for why. Not widened to
// "Waiting" the way DS_START_QUEUE's analogous check is - "Waiting" is a
// createReport()-time display default for a queue entry with no result
// at all, never a status processRoom() actually writes into STATE.results,
// so there's nothing here for it to match against. Mutates
// STATE.results in place (the same array createReport() reads right
// after this returns) rather than returning a new list, since every
// caller already holds a reference to the live STATE.results.
//
// Deliberately does NOT call persistJob() - its one call site in
// runQueue() runs after clearPersistedJob() has already run for this
// completed job, and persisting again here would resurrect a "job" entry
// in chrome.storage.local the instant after it was cleared, which a
// later service-worker restart could mistake for an interrupted run
// still needing resume. Nothing needs to survive a crash between this
// point and createReport() reading STATE.results right after it - both
// happen synchronously within the same already-completed runQueue() call.
async function verifySuccessAttemptedResults() {
  const candidates = STATE.results.filter(r => r.status === "Success/Attempted");
  if (!candidates.length) return;

  const verified = await findVerifiedExistingDownloads(candidates);
  if (!verified.size) return;

  let count = 0;
  STATE.results.forEach(r => {
    const match = verified.get(r.roomId);
    if (r.status === "Success/Attempted" && match) {
      r.status = "Downloaded";
      r.reason = "Verified already on disk via Chrome's download history";
      r.downloadedFilename = match.filename || r.downloadedFilename;
      r.downloadId = match.id != null ? String(match.id) : r.downloadId;
      count++;
    }
  });

  if (count) {
    logWorkerEvent("verified_existing_downloads", { count, stage: "pre_report" });
  }
}

async function waitIfPausedOrStopped() {
  while (STATE.paused && !STATE.stopped) {
    await broadcastStatus();
    await sleep(1000);
  }
  return !STATE.stopped;
}

// The only place STATE.index is read or written. Synchronous, no
// `await` anywhere in this function - that's what makes it safe for
// multiple workers to call concurrently without an explicit lock.
// Chrome serializes all incoming extension messages through this one
// single-threaded service worker, so two workers' calls can never
// truly overlap; the only way a race could reappear is an `await`
// between reading the pointer and advancing it, which this function
// never has (see DESIGN.md Decision 3).
function claimNextRoom() {
  if (STATE.index >= STATE.pending.length) return null;
  const room = STATE.pending[STATE.index];
  STATE.index++;
  return room;
}

// One room's full pipeline: navigate the given tab, wait for it to
// load, hand off to the content script, wait for the download to
// register. Returns false if the caller's loop should stop (Stop was
// triggered), true to keep claiming. Each call has its own local
// `result` - safe under concurrency since every worker calls this
// independently with its own tabId, never sharing mutable local state.
async function processRoom(tabId, room) {
  const documentsUrl = room.documentsUrl;
  const roomId = room.roomId || getRoomIdFromUrl(documentsUrl);
  const guessedRoomName = cleanName(room.roomName || `Docusign Room ${roomId}`);

  // tabId and claimedAt are here so the panel can render a real per-worker
  // breakdown (which tab has which room, and how long it's been on it)
  // instead of just a flattened "N active" count - broadcastStatus() below
  // sends this object's values as-is, and content.js correlates tabId
  // against the workerTabIds list (also sent) to label each row "Worker N".
  STATE.currentRooms[tabId] = { roomId, roomName: guessedRoomName, documentsUrl, tabId, claimedAt: new Date().toISOString() };
  await broadcastStatus();

  let result = {
    roomId,
    roomName: guessedRoomName,
    documentsUrl,
    status: "Failed",
    reason: "Not processed",
    downloadedFilename: "",
    downloadId: "",
    time: new Date().toISOString()
  };

  let keepGoing = true;

  try {
    // active: true - originally reverted from active: false on the theory
    // that Chrome's "block multiple automatic downloads from a page"
    // protection was dropping background-tab-triggered downloads (every
    // room's DOM steps succeeded but onDeterminingFilename never fired).
    // That turned out not to be the actual cause - the same symptom
    // persisted after this revert too, and the real bug was
    // findCurrentRoomForDownload()'s tab-ID matching (see the comment
    // above that function, and DESIGN.md Decision 2's corrections for
    // the full history). active: true is kept anyway since reverting it
    // never showed any downside, but it should not be read as "the fix"
    // for the folder-routing bug - it wasn't. The tab-switching
    // thrashing across several concurrent tabs is a real, known cost of
    // keeping it.
    await chrome.tabs.update(tabId, { url: documentsUrl, active: true });
    const loaded = await waitForTabLoaded(tabId, 60000);

    // Stop/Pause were previously only checked once per room, at the top
    // of the loop - clicking Stop mid-room did nothing until that
    // room's entire pipeline finished. Re-checking here (the single
    // longest wait) makes Stop/Pause take effect right after the page
    // load instead of only between rooms.
    if (!(await waitIfPausedOrStopped())) {
      keepGoing = false;
    } else if (!loaded) {
      result.reason = "Room Documents page did not finish loading";
      STATE.results.push(result);
      await persistJob();
      await broadcastStatus();
    } else {
      // Only a short buffer, not a "wait for the page to be ready"
      // delay - processCurrentRoom() already polls for
      // [data-qa="group-name"] itself (up to 45s). This just covers the
      // gap between document_idle firing and the content script's
      // onMessage listener actually being attached.
      await sleep(500);

      // Bounded to 90s - comfortably above processCurrentRoom()'s own
      // worst-case legitimate duration (up to 45s waiting for the
      // documents list, plus up to ~22s more across selecting/clicking
      // Download, see content.js) - so a genuinely slow page is never
      // mistaken for a stuck one, while a truly stuck one can't hang the
      // rest of the run. See withTimeout()'s own comment for why this,
      // specifically, was the one unbounded wait in this whole pipeline.
      const response = await withTimeout(
        chrome.tabs.sendMessage(tabId, {
          type: "DS_PROCESS_ROOM",
          roomId,
          documentsUrl
        }).catch(err => ({ ok: false, reason: err.message || "Could not message room tab" })),
        90000,
        { ok: false, reason: "Room processing timed out - no response from the room tab after 90s" }
      );

      const finalRoomName = cleanName(response?.roomName || guessedRoomName);

      result.roomName = finalRoomName;
      // "Complete (Empty)" is its own outcome, not folded into "Failed" -
      // an empty room isn't a failure, it's a correctly-determined
      // terminal state with nothing to download. Kept separate from
      // "Success/Attempted"/"Failed" so parseUploadedCsv() in content.js
      // can treat it as already-done on a CSV-upload resume (alongside
      // "Downloaded") instead of re-visiting a room already confirmed
      // empty, and so the panel's breakdown can count it distinctly
      // rather than mixing it into either bucket.
      if (response?.empty) {
        result.status = "Complete (Empty)";
        result.reason = response?.reason || "Room is empty";
      } else {
        result.status = response?.ok ? "Success/Attempted" : "Failed";
        result.reason = response?.reason || (response?.ok ? "Download click attempted" : "Unknown failure");
      }
      result.time = new Date().toISOString();
      // Uses the precomputed, collision-disambiguated folder name (keyed
      // by roomId), not finalRoomName - onDeterminingFilename below only
      // ever sees currentRoom.roomName (set from guessedRoomName at
      // claim time, not this possibly-refreshed finalRoomName), so using
      // the same source here keeps the reported filename matching what
      // Chrome actually creates instead of drifting if the live page's
      // room name differs slightly from what was in the original scan.
      const folderInfo = STATE.folderNames.get(roomId);
      const roomFolderName = folderInfo?.roomFolderName || finalRoomName;
      const yearFolder = folderInfo?.year || "Unassigned";
      result.downloadedFilename = `Docusign Rooms/${yearFolder}/${roomFolderName}/${roomFolderName}.zip`;

      STATE.results.push(result);
      await persistJob();

      // Real signal instead of a flat guess: wait for
      // chrome.downloads.onDeterminingFilename to actually fire for this
      // room (up to 15s) rather than always paying a fixed 4.5s.
      // Skipped for an empty room (!response?.empty) - there's no
      // download to wait for, and waiting anyway would burn up to 15s per
      // empty room for nothing, exactly the wasted time this whole
      // "Complete (Empty)" status was added to avoid.
      if (response?.ok && !response?.empty && !STATE.stopped) {
        await waitForDownloadStart(roomId, 15000);
      }

      await broadcastStatus();

      if (STATE.stopped) keepGoing = false;
    }
  } catch (error) {
    result.reason = error.message || "Unknown error";
    result.time = new Date().toISOString();
    STATE.results.push(result);
    await persistJob();
    await broadcastStatus();
  }

  delete STATE.currentRooms[tabId];
  return keepGoing;
}

// One worker's whole lifetime: claim, process, repeat, until the
// pending list is exhausted or Stop/a claim failure ends it. Multiple
// of these run concurrently (one per worker tab) via Promise.all in
// runQueue() - each is a fully independent loop, coordinated only
// through claimNextRoom()'s shared, synchronous pointer.
async function runWorker(tabId) {
  // Local, reassignable - this worker's tab can be replaced mid-loop (see
  // the liveness check below), so `tabId` (the parameter, this worker's
  // *original* tab) can't be used for the rest of the function once that
  // happens.
  let currentTabId = tabId;

  while (true) {
    if (!(await waitIfPausedOrStopped())) break;

    // ensureWorkerTabs() (in runQueue()) only ever checks tab health once,
    // at the very start of the run - a tab closing mid-run (the user
    // closes it, Chrome reclaims it under memory pressure, it crashes)
    // previously had no recovery at all: every subsequent
    // chrome.tabs.update() in processRoom() would reject near-instantly,
    // and since claimNextRoom() pulls from one shared queue, this worker
    // would burn through the remaining rooms far faster than the healthy
    // workers could do real work, silently marking a large chunk of the
    // queue "Failed" for a reason that had nothing to do with those rooms.
    // Confirmed live: closing a worker tab mid-run left it permanently
    // dead for the rest of that run. Checked before claimNextRoom(), not
    // after, so a room is never pulled off the queue by a worker that
    // then turns out to have nothing to process it with.
    const alive = await chrome.tabs.get(currentTabId).catch(() => null);
    if (!alive) {
      logWorkerEvent("worker_tab_dead", { tabId: currentTabId, context: "runWorker" });

      // Re-checked here, not just at the top of the loop - Stop can be
      // clicked in the narrow window between this worker passing the
      // waitIfPausedOrStopped() gate above and reaching this point (its
      // tab happened to die at the same moment). Without this, a worker
      // would open a brand-new tab for a run that's already ending,
      // which is exactly the "kept opening new tabs after Stop" symptom
      // confirmed live - pointless work, and one more orphaned tab left
      // behind for the user to notice and close by hand.
      if (STATE.stopped) break;

      const replacement = await chrome.tabs.create({ url: "about:blank", active: false }).catch(() => null);
      if (!replacement) {
        // Nothing productive this worker can do - stop cleanly. The other
        // workers keep going; this just means fewer of them for the rest
        // of the run, not a stuck or silently-failing one.
        logWorkerEvent("worker_tab_replace_failed", { tabId: currentTabId });
        break;
      }

      const idx = STATE.workerTabIds.indexOf(currentTabId);
      if (idx !== -1) STATE.workerTabIds[idx] = replacement.id;
      else STATE.workerTabIds.push(replacement.id);

      logWorkerEvent("worker_tab_replaced", { oldTabId: currentTabId, newTabId: replacement.id });
      currentTabId = replacement.id;
    }

    const room = claimNextRoom();
    if (!room) break;

    const keepGoing = await processRoom(currentTabId, room);
    if (!keepGoing) break;

    await sleep(500);
  }

  delete STATE.currentRooms[currentTabId];
}

// Always called fire-and-forget - a real run can take hours, so neither of
// its two call sites (DS_START_QUEUE below, and the startup-resume IIFE at
// the bottom of this file) ever awaits or .catch()'s it. That means this
// function's own top-level try/catch is the ONLY safety net standing
// between an uncaught throw anywhere in the pipeline below (most plausibly
// ensureWorkerTabs()'s chrome.tabs.create() call, the one spot in that
// chain not already defensively wrapped) and STATE.running staying stuck
// `true` forever - confirmed by tracing the exact same failure shape
// DS_START_QUEUE/DS_RUN_SCAN's own setup-phase try/catches already guard
// against (see their comments), just never closed at this level: nothing
// past the throw point would run, including every line that resets
// STATE.running, clears the persisted job, or writes a report - the panel
// would be left showing "running" forever with no error, no report, and no
// way out short of a service-worker restart happening to occur on its own.
async function runQueue() {
  try {
    STATE.running = true;
    updateKeepAwake();
    STATE.stopped = false;
    STATE.finishedAt = null;
    // Not unconditional - a resumed run already has a real startedAt
    // restored from storage, and overwriting it here would report the
    // wrong total elapsed time and, more importantly, imply the job had
    // no downtime when it may have sat interrupted for a while.
    STATE.startedAt = STATE.startedAt || new Date().toISOString();
    STATE.currentRooms = {};

    await broadcastStatus();

    // Never more tabs than there's work for - a 1-2 room run (or the tail
    // end of a larger one) doesn't need STATE.workerTabCount tabs sitting
    // open with nothing to claim.
    const tabCount = Math.min(STATE.workerTabCount, STATE.pending.length) || 1;
    const tabIds = await ensureWorkerTabs(tabCount);

    await Promise.all(tabIds.map(id => runWorker(id)));

    STATE.running = false;
    updateKeepAwake();
    STATE.currentRooms = {};

    // Covers both ways the workers can all stop - running out of pending
    // rooms and an explicit Stop both end here (Promise.all only resolves
    // once every worker's loop has exited), so one call handles both:
    // nothing left to resume either way.
    await clearPersistedJob();

    // See waitForInFlightDownloadsToSettle()'s own comment - closes the gap
    // between "every worker ran out of rooms to claim" and "every download
    // that was ever started has actually finished," so the reports below
    // reflect reality as closely as reasonably possible instead of a
    // snapshot taken slightly too early.
    await waitForInFlightDownloadsToSettle();

    // Catches what the wait above structurally can't - a "Success/
    // Attempted" result whose download genuinely finished but whose
    // completion was never recorded at all (not just not-yet-settled). See
    // verifySuccessAttemptedResults()'s own comment.
    await verifySuccessAttemptedResults();

    // Logged, not silently swallowed - a bare `.catch(() => "")` here would
    // mean a genuinely failed report (the same safeEncodeURIComponent()
    // scenario that made CSV export hang, or the storage-quota risk noted
    // in Decision 15) leaves no trace anywhere that the run's report never
    // got written at all. Still .catch()'d rather than awaited plainly -
    // one failed report must not prevent the run from being marked done or
    // block the other report from still being attempted.
    await createReport().catch(err => {
      console.error("[DSBD] createReport failed:", err);
      logWorkerEvent("report_failed", { stage: "download_report", error: err?.message || String(err) });
    });
    await createEventLogReport().catch(err => {
      console.error("[DSBD] createEventLogReport failed:", err);
      logWorkerEvent("report_failed", { stage: "activity_log", error: err?.message || String(err) });
    });
    await broadcastStatus();

    try {
      if (STATE.workerTabIds[0]) {
        // Keep one tab focused so the user can see where it ended.
        await chrome.tabs.update(STATE.workerTabIds[0], { active: true }).catch(() => {});
      }
    } catch (e) {}
  } catch (error) {
    STATE.running = false;
    updateKeepAwake();
    STATE.currentRooms = {};
    logWorkerEvent("run_queue_failed", { error: error?.message || String(error) });
    console.error("[DSBD] runQueue failed unexpectedly:", error);

    // Deliberately does NOT clear the persisted job here - whatever
    // persistJob() already checkpointed (up through the last completed
    // room) stays in chrome.storage.local, so the run can still be picked
    // back up: automatically, if the service worker happens to restart
    // (the startup-resume IIFE below will find it), or manually via
    // re-uploading the report this still attempts to write, same as a
    // normal completion. Both report calls are .catch()'d the same way the
    // normal-completion path above already handles a failed report - a
    // second failure in this recovery path must not make things worse.
    await createReport().catch(err => {
      console.error("[DSBD] createReport failed after a run crash:", err);
      logWorkerEvent("report_failed", { stage: "download_report", error: err?.message || String(err) });
    });
    await createEventLogReport().catch(err => {
      console.error("[DSBD] createEventLogReport failed after a run crash:", err);
      logWorkerEvent("report_failed", { stage: "activity_log", error: err?.message || String(err) });
    });

    await broadcastStatus();
    // A distinct broadcast, not just the DS_BULK_STATUS above - running:
    // false plus a finishedAt from the report just written would otherwise
    // read to the panel exactly like a normal completion (see its "Done,
    // but N rooms still need attention" logic), silently hiding that this
    // was actually an unexpected crash rather than the run genuinely
    // finishing. Sent after broadcastStatus() specifically so it has the
    // last word on the panel's status line.
    chrome.runtime.sendMessage({
      type: "DS_RUN_FAILED",
      reason: `The run stopped unexpectedly: ${error?.message || String(error)}. A partial report was saved - re-upload it via "Upload CSV to Run/Resume" to finish the rest.`
    }).catch(() => {});
  }
}

// Shared by handleExportScanList() below and the DS_SCAN_CHECKPOINT
// handler - both need the exact same "Room #, Room Name, Room ID,
// Documents URL, Created Date" CSV shape, just under different filenames
// and conflictAction policies (a real export gets a unique, final
// filename; a checkpoint overwrites the same in-progress one every time).
// Factored out rather than duplicated so the two can never quietly drift
// apart on column order or formatting.
function buildScanListCsvDataUrl(rooms) {
  const roomsArr = Array.isArray(rooms) ? rooms : [];

  const rows = [
    ["Room #", "Room Name", "Room ID", "Documents URL", "Created Date"]
  ];

  roomsArr.forEach((r, idx) => {
    rows.push([
      idx + 1,
      r.roomName || "",
      r.roomId || "",
      r.documentsUrl || "",
      // Was `String(r.createdDate || "").slice(0, 10)` - looks
      // plausible but is wrong for any non-UTC timezone: Date's default
      // toString() isn't an ISO string, so slicing its first 10
      // characters produces something like "Sun Jan 03" (no year, and
      // a calendar day off from the real date) rather than
      // "2021-01-04". formatCreatedDateForCsv() (content/utils.js)
      // uses toISOString() instead, which this format actually needs.
      formatCreatedDateForCsv(r.createdDate)
    ]);
  });

  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  return "data:text/csv;charset=utf-8," + safeEncodeURIComponent(csv);
}

// Builds and downloads the Scan List CSV. A plain function, not a message
// handler - this used to be DS_EXPORT_SCAN_LIST's entire body, but once
// scanning moved behind the DS_RUN_SCAN relay (see the panel-window
// decision in DESIGN.md), the only caller left is DS_SCAN_COMPLETE's
// "export" branch below, so there's no reason for this to still be a
// separately-addressable message type. Wraps the whole body in `try`, not
// just the chrome.downloads.download() call - confirmed live as the
// actual bug behind an 8000-room scan's CSV export hanging forever with
// no error shown (see safeEncodeURIComponent()'s own comment for the
// confirmed cause). Returns a response object rather than calling
// sendResponse() directly, since the caller decides how (or whether) to
// relay it onward.
async function handleExportScanList(rooms, dateRangeLabel) {
  try {
    const roomsArr = Array.isArray(rooms) ? rooms : [];
    const dataUrl = buildScanListCsvDataUrl(roomsArr);
    const label = typeof dateRangeLabel === "string" ? dateRangeLabel : null;
    const filename = `Docusign Rooms/_Scan Lists/${labeledFilename("Scan List", label)}.csv`;

    pendingReportFilenames.set(dataUrl, filename);
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });

    return { ok: true, filename, total: roomsArr.length };
  } catch (error) {
    return { ok: false, reason: error.message || "CSV export failed" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) return;

    if (message.type === "DS_START_QUEUE") {
      if (STATE.running) {
        sendResponse({ ok: false, reason: "A download run is already active." });
        return;
      }
      // Reserved synchronously, before the first `await` below - the
      // actual STATE.running = true inside runQueue() happens too late
      // to close the race: a second DS_START_QUEUE (or the startup
      // resume block below, which has its own await before it gets
      // here) arriving while this handler is mid-await would otherwise
      // also pass the guard above and end up running two worker pools
      // concurrently over the same STATE.pending.
      STATE.running = true;
      updateKeepAwake();

      // Everything from here through sendResponse() is wrapped in try/catch
      // as a safety net, not because any single line here is expected to
      // fail under normal conditions - persistJob() and
      // findVerifiedExistingDownloads() already swallow their own real
      // failure modes internally. Confirmed directly (not assumed) that
      // without this, an unexpected throw anywhere in this block - a
      // chrome.* API call failing in some way this code didn't anticipate -
      // would leave STATE.running stuck `true` forever, since runQueue()
      // (the only place that resets it) would never even be reached:
      // sendResponse() never fires either, so the caller hangs, and every
      // future DS_START_QUEUE gets silently rejected with "a run is
      // already active" until the next service worker restart happens to
      // occur, with no obvious cause visible anywhere. Mirrors the same
      // reset-on-failure pattern DS_RUN_SCAN below already uses for
      // STATE.scanning around its own chrome.tabs.sendMessage() call.
      try {
        const rooms = Array.isArray(message.rooms) ? message.rooms : [];
        const normalized = rooms
          .map(room => {
            const documentsUrl = room.documentsUrl || roomUrlToDocumentsUrl(room.url || room.href);
            if (!documentsUrl) return null;
            const roomId = getRoomIdFromUrl(documentsUrl);
            return {
              roomId,
              roomName: cleanName(room.roomName || room.title || `Docusign Room ${roomId}`),
              documentsUrl,
              // Carried through so computeFolderNames() below can route this
              // room into Docusign Rooms/<year>/... - present as a real Date
              // on a room fresh off a live scan (content/scan.js), or an
              // ISO string once it's round-tripped through an uploaded CSV
              // (parseUploadedCsv() in content/utils.js); roomCreatedYear()
              // accepts either. Previously dropped entirely here, which
              // would have silently sent every room to "Unassigned."
              createdDate: room.createdDate || null,
              // The room's own prior status, from parseUploadedCsv() - only
              // read below to decide which rooms are worth verifying against
              // Chrome's download history before re-processing (a "Failed"
              // room never had a download triggered at all, nothing to
              // check; undefined for a room fresh off a live scan, same
              // effect). Not otherwise used - processRoom() always computes
              // this run's own fresh status from what actually happens.
              status: room.status || null
            };
          })
          .filter(Boolean);

        // Optional: when a Download Report CSV is uploaded, content.js
        // already filters out rows marked "Downloaded" before sending
        // `rooms` (only what still needs work) - but sending nothing else
        // would mean this run's own final report only covers that subset,
        // losing the record of everything already completed before the
        // interruption. priorResults carries those already-done rows back
        // in so they're seeded straight into STATE.results and STATE.queue,
        // giving the resumed run's report (and its live progress counter)
        // the true, complete picture instead of restarting the count from
        // zero against a shrunk total.
        const priorResults = Array.isArray(message.priorResults) ? message.priorResults : [];
        const priorRoomsForQueue = priorResults.map(r => ({
          roomId: r.roomId,
          roomName: r.roomName,
          documentsUrl: r.documentsUrl,
          // Without this, createReport()'s "Created Date" column would go
          // blank for every already-`Downloaded`/`Complete (Empty)` row on
          // a resumed run's report, even though parseUploadedCsv() already
          // parsed a real date for these rows off the uploaded CSV.
          createdDate: r.createdDate || null
        }));

        // Before queueing anything for real DOM reprocessing, check whether
        // a "Success/Attempted" or "Waiting" room already has a real file
        // sitting in Chrome's download history - see
        // findVerifiedExistingDownloads()'s own comment for why this
        // happens and why re-clicking Download for it risks a real
        // duplicate. "Waiting" widened in alongside "Success/Attempted"
        // after a direct follow-up: Waiting only means *this* run's queue
        // never reached the room - it says nothing about whether an
        // earlier, separate run already downloaded it successfully.
        // Confirmed directly against this account's real data: of the
        // non-Downloaded rooms found already sitting at their correct
        // location, the large majority were at Waiting, not Success/
        // Attempted. Still excludes "Failed" - a genuinely failed attempt
        // (page didn't load, button not found) is a different signal than
        // "never touched," and Failed rooms were deliberately left out of
        // this check per an earlier, explicit decision.
        const unconfirmedRooms = normalized.filter(r => r.status === "Success/Attempted" || r.status === "Waiting");
        const verifiedMatches = await findVerifiedExistingDownloads(unconfirmedRooms);

        const stillNeedsProcessing = [];
        const verifiedRoomsForQueue = [];
        const verifiedResults = [];

        normalized.forEach(room => {
          const match = verifiedMatches.get(room.roomId);
          if (match) {
            verifiedRoomsForQueue.push(room);
            verifiedResults.push({
              roomId: room.roomId,
              roomName: room.roomName,
              documentsUrl: room.documentsUrl,
              status: "Downloaded",
              reason: "Verified already on disk via Chrome's download history - not re-downloaded",
              downloadedFilename: match.filename || "",
              downloadId: match.id != null ? String(match.id) : "",
              time: new Date().toISOString()
            });
          } else {
            stillNeedsProcessing.push(room);
          }
        });

        if (verifiedResults.length) {
          logWorkerEvent("verified_existing_downloads", { count: verifiedResults.length, stage: "csv_resume" });
        }

        STATE.queue = [...priorRoomsForQueue, ...verifiedRoomsForQueue, ...stillNeedsProcessing];
        STATE.folderNames = computeFolderNames(STATE.queue);
        STATE.pending = stillNeedsProcessing;
        STATE.index = 0;
        STATE.results = [...priorResults, ...verifiedResults];
        // clampWorkerTabCount() handles a missing field the same as an
        // invalid one (falls back to DEFAULT_WORKER_TAB_COUNT) - covers both
        // an older panel that doesn't send this field yet and a genuinely
        // bad value, without needing a separate presence check.
        STATE.workerTabCount = clampWorkerTabCount(message.workerTabCount);
        STATE.runDateRangeLabel = typeof message.dateRangeLabel === "string" ? message.dateRangeLabel : null;
        STATE.paused = false;
        STATE.stopped = false;
        STATE.currentRooms = {};
        // Without this, a stale entry from a previous run (e.g. Stop, then
        // Start again over a list that includes an already-processed room)
        // could make waitForDownloadStart() match against that old download
        // and report "started" instantly for a room whose download in this
        // run hasn't actually begun yet.
        STATE.downloads = {};
        // Explicitly cleared, not left as whatever a previous run in this
        // same service-worker lifetime set it to - runQueue() only sets a
        // fresh timestamp when this is falsy (so a resumed run keeps its
        // real start time), which would otherwise make a genuinely new run
        // silently inherit a stale startedAt from an earlier one.
        STATE.startedAt = null;

        await persistJob();
        sendResponse({ ok: true, total: STATE.queue.length });
      } catch (error) {
        STATE.running = false;
        updateKeepAwake();
        console.error("[DSBD] DS_START_QUEUE failed unexpectedly:", error);
        logWorkerEvent("start_queue_failed", { error: error?.message || String(error) });
        sendResponse({ ok: false, reason: "Could not start - see the service worker console for details." });
        return;
      }

      runQueue();
      return;
    }

    if (message.type === "DS_PAUSE") {
      STATE.paused = true;
      await persistJob();
      await broadcastStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_RESUME") {
      STATE.paused = false;
      await persistJob();
      await broadcastStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_STOP") {
      STATE.stopped = true;
      STATE.paused = false;
      await broadcastStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_GET_STATUS") {
      sendResponse({
        ok: true,
        state: {
          running: STATE.running,
          paused: STATE.paused,
          stopped: STATE.stopped,
          total: STATE.queue.length,
          activeCount: Object.keys(STATE.currentRooms).length,
          currentRooms: Object.values(STATE.currentRooms),
          workerTabIds: STATE.workerTabIds,
          workerEvents: STATE.workerEvents.slice(-20),
          results: STATE.results,
          startedAt: STATE.startedAt,
          finishedAt: STATE.finishedAt,
          // So a (re)opened panel window can show "a scan is in progress"
          // correctly even if it wasn't the panel instance that started
          // it - e.g. the panel window was closed and reopened mid-scan.
          scanning: STATE.scanning
        }
      });
      return;
    }

    // DS_RUN_SCAN / DS_SCAN_PROGRESS / DS_SCAN_COMPLETE / DS_SCAN_STOP /
    // DS_SCAN_PAUSE / DS_SCAN_RESUME - the scan-relay protocol. A live
    // scan needs real DOM access to a Docusign tab, which the standalone
    // panel window doesn't have (it's a separate extension page, not a
    // content script) - background.js brokers between the panel and
    // whichever content script actually runs the scan, the same
    // relationship it already has with worker tabs for per-room work.
    // Full reasoning in DESIGN.md.
    if (message.type === "DS_RUN_SCAN") {
      if (STATE.running) {
        sendResponse({ ok: false, reason: "A download run is already active." });
        return;
      }
      if (STATE.scanning) {
        sendResponse({ ok: false, reason: "A scan is already in progress." });
        return;
      }
      // Reserved synchronously, before the first `await` below - same
      // race, same fix as DS_START_QUEUE's STATE.running reservation
      // above. Without this, two DS_RUN_SCAN messages arriving close
      // together could both pass the `if (STATE.scanning)` check above
      // before either one actually sets it, since the only await between
      // the check and the set used to be chrome.tabs.query() - both
      // would then proceed to request a scan, and content.js would end up
      // running autoScrollAndCollectRooms() twice concurrently in the
      // same tab.
      STATE.scanning = true;
      updateKeepAwake();

      // Widened to cover chrome.tabs.query() too, not just
      // chrome.tabs.sendMessage() below - confirmed directly (the same
      // way as DS_START_QUEUE's analogous fix above) that an unguarded
      // query() throwing here would leave STATE.scanning stuck `true`
      // forever, since nothing past this point would ever run to reset
      // it and sendResponse() would never fire either.
      try {
        // Picks the first matching tab - if more than one Docusign Rooms
        // tab happens to be open, this is the same "first match wins"
        // choice ensureWorkerTabs()/broadcastStatus() implicitly make
        // elsewhere in this file, not a new ambiguity introduced here.
        const tabs = await chrome.tabs.query({ url: "https://rooms.docusign.com/*" });
        const targetTab = tabs[0];

        if (!targetTab) {
          STATE.scanning = false;
          updateKeepAwake();
          sendResponse({ ok: false, reason: "No Docusign Rooms tab is open. Open the Rooms list page first." });
          return;
        }

        STATE.scanTabId = targetTab.id;
        STATE.scanMode = message.mode;
        STATE.scanDateRangeLabel = typeof message.dateRangeLabel === "string" ? message.dateRangeLabel : null;
        // Computed once here, not per-checkpoint - see the field's own
        // comment on STATE for why a stable filename is what makes
        // repeated checkpoint saves actually overwrite each other instead
        // of piling up a new timestamped file every time.
        STATE.scanCheckpointFilename = `Docusign Rooms/_Scan Lists/Scan List${STATE.scanDateRangeLabel ? ` (${cleanName(STATE.scanDateRangeLabel)})` : ""} (in progress - partial).csv`;
        STATE.lastScanActivityAt = Date.now();
        // Periodic alarm (minimum period Chrome allows for chrome.alarms is
        // 1 minute) - the watchdog listener below fires on this, checking
        // whether STATE.lastScanActivityAt has gone stale. Recreated on
        // every scan start rather than left running from a previous one -
        // chrome.alarms.create() with the same name replaces any existing
        // alarm outright, so this can never end up with two running.
        chrome.alarms.create(SCAN_WATCHDOG_ALARM, { periodInMinutes: 1 });

        // Only acknowledging that the scan *started* - the actual result
        // arrives later via DS_SCAN_COMPLETE below, since a scan can run
        // for minutes and there's no reason to hold this message channel
        // open that whole time when a follow-up message works just as well.
        await chrome.tabs.sendMessage(targetTab.id, { type: "DS_BEGIN_SCAN", dateRange: message.dateRange });
        sendResponse({ ok: true });
      } catch (error) {
        STATE.scanning = false;
        updateKeepAwake();
        STATE.scanTabId = null;
        STATE.scanMode = null;
        STATE.scanDateRangeLabel = null;
        STATE.scanCheckpointFilename = null;
        // Only actually pending if the throw happened after
        // chrome.alarms.create() above ran - clearing an alarm that was
        // never created is a harmless no-op, not an error.
        chrome.alarms.clear(SCAN_WATCHDOG_ALARM);
        sendResponse({ ok: false, reason: "Could not reach the Docusign tab - try refreshing it and make sure you're on the Rooms list page." });
      }
      return;
    }

    if (message.type === "DS_SCAN_PROGRESS") {
      // Doubles as the scan-stall watchdog's sign-of-life signal (see
      // SCAN_STALL_THRESHOLD_MS/the chrome.alarms listener below) - this
      // fires on every scroll iteration under normal conditions (~every
      // 1.5-2s), so a real gap here is a strong signal something's wrong,
      // not just a coincidence of message timing.
      STATE.lastScanActivityAt = Date.now();

      // Relay only - content scripts can't reach the standalone panel
      // window directly (chrome.tabs.sendMessage only targets tabs; the
      // panel is an extension page, not a tab). chrome.runtime.sendMessage
      // (no tabId - a broadcast) is what reaches it, same as
      // broadcastStatus() below.
      chrome.runtime.sendMessage({ type: "DS_SCAN_PROGRESS", text: message.text }).catch(() => {});
      return;
    }

    // Sent periodically by content/scan.js's autoScrollAndCollectRooms()
    // during a long scan, not just at the very end - added directly in
    // response to a real tab crash mid-scan on a large account, and the
    // question that followed it: "is there a way to actively write a file
    // while rooms are being scanned?" Reuses handleExportScanList()'s own
    // CSV-building logic (buildScanListCsvDataUrl()) but with
    // conflictAction: "overwrite" against the one stable filename computed
    // once at scan start (STATE.scanCheckpointFilename), so repeated
    // checkpoints replace the same in-progress file instead of piling up a
    // new one every few minutes. `.catch()`'d rather than awaited plainly -
    // a failed checkpoint write must never be allowed to break the scan
    // itself, which is still running independently in the content script
    // regardless of whether this particular save succeeds.
    if (message.type === "DS_SCAN_CHECKPOINT") {
      // Corrected during an audit: the comment on SCAN_STALL_THRESHOLD_MS
      // above has always claimed both DS_SCAN_PROGRESS *and*
      // DS_SCAN_CHECKPOINT update this, but this line was actually
      // missing here - only DS_SCAN_PROGRESS (which happens to fire every
      // scroll regardless, ~1.5-2s) was keeping the watchdog's sign-of-life
      // signal accurate, purely by coincidence of timing rather than by
      // this handler actually doing what its own neighboring comment said
      // it did.
      STATE.lastScanActivityAt = Date.now();

      const rooms = Array.isArray(message.rooms) ? message.rooms : [];
      if (!rooms.length || !STATE.scanCheckpointFilename) return;

      const dataUrl = buildScanListCsvDataUrl(rooms);
      pendingReportFilenames.set(dataUrl, STATE.scanCheckpointFilename);
      chrome.downloads.download({
        url: dataUrl,
        filename: STATE.scanCheckpointFilename,
        saveAs: false,
        conflictAction: "overwrite"
      }).catch(err => {
        console.warn("[DSBD] checkpoint CSV write failed", err);
        logWorkerEvent("scan_checkpoint_failed", { error: err?.message || String(err) });
      });
      return;
    }

    // Sent periodically by content/scan.js's autoScrollAndCollectRooms()
    // at the same cadence as DS_SCAN_CHECKPOINT (every 1,000 new rooms),
    // plus once more when the scan ends - a periodic aggregate ("nice
    // visual like it was for downloads," requested directly), not a
    // per-room diary, which would be both unreadable and pointless to
    // export at this project's real scale. Routed through the same
    // logWorkerEvent()/STATE.workerEvents the download side's Activity
    // Log already reads from and exports (createEventLogReport()) - no
    // new storage or UI needed, just a new event type feeding the
    // existing pipe. broadcastStatus() is called explicitly (unlike
    // DS_SCAN_PROGRESS, which only ever reaches the status line) so this
    // shows up live in the panel's Activity Log during the scan itself,
    // not only after it ends.
    if (message.type === "DS_SCAN_ACTIVITY") {
      STATE.lastScanActivityAt = Date.now();
      logWorkerEvent("scan_activity", {
        totalFound: message.totalFound,
        inRangeFound: message.inRangeFound,
        totalTrimmed: message.totalTrimmed,
        final: !!message.final
      });
      await broadcastStatus();
      return;
    }

    if (message.type === "DS_SCAN_COMPLETE") {
      STATE.scanning = false;
      updateKeepAwake();
      STATE.scanTabId = null;
      const mode = STATE.scanMode;
      const dateRangeLabel = STATE.scanDateRangeLabel;
      STATE.scanMode = null;
      STATE.scanDateRangeLabel = null;
      STATE.scanCheckpointFilename = null;
      chrome.alarms.clear(SCAN_WATCHDOG_ALARM);

      // content.js sets this when autoScrollAndCollectRooms() itself threw
      // (see its DS_BEGIN_SCAN handler) - state is already cleaned up above
      // either way, but a thrown scan is not the same as a scan that
      // legitimately found 0 rooms, so it gets routed through the same
      // DS_SCAN_FAILED path the panel already understands (used today when
      // the scan tab gets closed mid-scan) rather than silently proceeding
      // as if nothing were wrong.
      if (message.error) {
        logWorkerEvent("scan_failed", { error: message.error });
        chrome.runtime.sendMessage({ type: "DS_SCAN_FAILED", reason: `Scan failed: ${message.error}` }).catch(() => {});
        return;
      }

      const rooms = Array.isArray(message.rooms) ? message.rooms : [];

      if (mode === "export") {
        const response = await handleExportScanList(rooms, dateRangeLabel);
        chrome.runtime.sendMessage({ type: "DS_SCAN_RESULT", mode: "export", response }).catch(() => {});
      } else {
        // Deliberately NOT auto-starting the queue here - the panel still
        // shows its own confirm() dialog ("Found N rooms... Continue?")
        // once it receives this, exactly like the pre-relay flow did
        // right after autoScrollAndCollectRooms() returned. Auto-starting
        // would have silently dropped that confirmation step.
        chrome.runtime.sendMessage({ type: "DS_SCAN_RESULT", mode: "start", rooms, dateRangeLabel }).catch(() => {});
      }
      return;
    }

    if (message.type === "DS_SCAN_STOP" || message.type === "DS_SCAN_PAUSE" || message.type === "DS_SCAN_RESUME") {
      if (!STATE.scanTabId) {
        sendResponse({ ok: false, reason: "No scan in progress." });
        return;
      }
      chrome.tabs.sendMessage(STATE.scanTabId, { type: message.type }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_ROOM_PAGE_INFO") {
      const tabId = sender.tab?.id;
      const currentRoom = STATE.currentRooms[tabId];
      if (currentRoom) {
        currentRoom.roomName = cleanName(message.roomName || currentRoom.roomName);
      }
      sendResponse({ ok: true });
      return;
    }
  })();

  return true;
});

// The download-confirmation form on a room's Documents page is
// `<form id="formDownloadDocuments" method="post" target="_blank" ...>`
// (confirmed via captured markup) - submitting it opens a *new*
// browsing context to receive the response, so the resulting
// DownloadItem's tabId belongs to that new (often instantly-closed) tab,
// never the worker tab that actually triggered it. Looking up
// STATE.currentRooms by downloadItem.tabId alone therefore never
// matches. Falls back to parsing a room ID out of the download's own
// referrer/url/finalUrl (which points back to the room's Documents page,
// .../rooms/<id>/documents) and matching that against whichever rooms
// are currently in flight - correct regardless of which tab Chrome
// attributes the download to.
function findCurrentRoomForDownload(downloadItem) {
  const byTab = STATE.currentRooms[downloadItem.tabId];
  if (byTab) return byTab;

  // Confirmed via a live-captured DownloadItem: referrer is empty for
  // these downloads (the target="_blank" navigation apparently doesn't
  // carry one over), and the actual download URL uses DocuSign's
  // internal "transaction" path, not "rooms" -
  // .../transaction/<id>/documents/download - even though the room's
  // own page and documentsUrl use .../rooms/<id>/documents. Both are the
  // same numeric ID under two different path segments, so this matches
  // either. Matching only "rooms" (the first attempt) silently missed
  // every real download, since the URL that actually carries the ID
  // never uses that word at all.
  const candidates = [downloadItem.referrer, downloadItem.url, downloadItem.finalUrl];

  for (const candidate of candidates) {
    const match = String(candidate || "").match(/\/(?:rooms|transaction)\/(\d+)/i);
    if (!match) continue;

    const roomId = match[1];
    const found = Object.values(STATE.currentRooms).find(r => r.roomId === roomId);
    if (found) return found;
  }

  return null;
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  // Checked first, before any room-matching - this extension's own CSV
  // report exports (Scan List, Download Report, Activity Log) are never
  // room downloads, and this is the one place their actual intended
  // filename is reliably known. See pendingReportFilenames' own comment
  // for why chrome.downloads.download()'s `filename` option alone isn't
  // enough for these.
  const pendingFilename = pendingReportFilenames.get(downloadItem.url);
  if (pendingFilename) {
    pendingReportFilenames.delete(downloadItem.url);
    suggest({ filename: pendingFilename, conflictAction: "uniquify" });
    return;
  }

  const currentRoom = findCurrentRoomForDownload(downloadItem);

  if (!currentRoom) {
    // Visible in the SERVICE WORKER console (chrome://extensions -> the
    // "service worker" link), not the page console - if room matching
    // is still failing after the referrer/url fallback above, this shows
    // exactly what fields a real DownloadItem actually has to match
    // against, instead of guessing again from an empty Download ID column.
    console.warn("[DSBD] Unmatched download - no current room found:", {
      tabId: downloadItem.tabId,
      url: downloadItem.url,
      finalUrl: downloadItem.finalUrl,
      referrer: downloadItem.referrer,
      filename: downloadItem.filename,
      currentRoomsInFlight: Object.values(STATE.currentRooms)
    });

    // onDeterminingFilename fires for every download in the entire
    // browser, not just this extension's - most "unmatched" downloads
    // are something totally unrelated (a PDF from Gmail in some other
    // tab) and must be left completely alone, exactly as before this
    // check existed. This extension's own CSV report exports used to
    // reach this same "unmatched" path too (a data: URL never matches
    // the /rooms|transaction/ pattern below) - they no longer do, caught
    // instead by the pendingReportFilenames check at the very top of
    // this listener, before room-matching even runs. Redirecting an
    // unrelated download into this extension's
    // folder just because a room lookup failed would be a much worse bug
    // than the one being fixed here. Only a download whose URL actually
    // matches the same /rooms/<id>/ or /transaction/<id>/ pattern
    // findCurrentRoomForDownload() itself checks is treated as "ours,
    // but unidentifiable" - a real Docusign document download that
    // genuinely couldn't be matched to a tracked room (e.g. its
    // STATE.currentRooms entry was already cleared by the time this
    // fired - a timing edge case, not the common case). That one real
    // gap used to mean the file silently escaped the Docusign Rooms
    // folder entirely, landing in Chrome's flat default location instead.
    // Tests all three candidate fields independently, not just whichever
    // is truthy first - mirrors findCurrentRoomForDownload()'s own
    // referrer/url/finalUrl loop above, so this check can't miss a match
    // in url/finalUrl just because referrer happened to be a non-empty
    // string that itself doesn't match (referrer is normally empty for a
    // real Docusign download - see that function's comment - but nothing
    // here should depend on that always holding true).
    const looksLikeOurs = [downloadItem.referrer, downloadItem.url, downloadItem.finalUrl].some(
      candidate => /\/(?:rooms|transaction)\/\d+/i.test(String(candidate || ""))
    );

    if (!looksLikeOurs) return;

    const fallbackLeafName = downloadItem.filename
      ? cleanName(String(downloadItem.filename).split("/").pop())
      : `Unassigned Download ${downloadItem.id}`;
    const filename = `Docusign Rooms/Unassigned/${fallbackLeafName}`;

    logWorkerEvent("unassigned_download", { downloadId: downloadItem.id, filename });

    suggest({ filename, conflictAction: "uniquify" });
    return;
  }

  const roomName = cleanName(currentRoom.roomName || `Docusign Room ${currentRoom.roomId}`);
  // Two different rooms can share the same display name (e.g. two
  // "Ponchak - Listing" rooms with different IDs) - cleanName() alone
  // would send both into the same folder, silently merging their
  // downloads. STATE.folderNames (built once per run by
  // computeFolderNames()) appends the room ID only where a collision
  // actually exists within the same year folder in this run's queue, so
  // most rooms still get a plain, readable folder name. The year itself
  // also comes from that same precomputed map, not recalculated here, so
  // this listener and processRoom()'s own reported downloadedFilename
  // can never disagree about where a given room's ZIP actually landed.
  const folderInfo = STATE.folderNames.get(currentRoom.roomId);
  const roomFolderName = folderInfo?.roomFolderName || roomName;
  const yearFolder = folderInfo?.year || "Unassigned";
  const filename = `Docusign Rooms/${yearFolder}/${roomFolderName}/${roomFolderName}.zip`;

  STATE.downloads[downloadItem.id] = {
    roomId: currentRoom.roomId,
    roomName,
    filename,
    startedAt: new Date().toISOString()
  };

  // This creates a folder even if the Docusign export contains only one file,
  // because every download is saved as
  // Docusign Rooms/<Year>/<Room Name>/<Room Name>.zip
  suggest({
    filename,
    conflictAction: "uniquify"
  });
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta || !delta.id || !STATE.downloads[delta.id]) return;

  const info = STATE.downloads[delta.id];

  if (delta.filename && delta.filename.current) {
    info.filename = delta.filename.current;
  }

  if (delta.state && delta.state.current === "complete") {
    info.completedAt = new Date().toISOString();

    // Attach final download ID/name to the closest result for this room.
    for (let i = STATE.results.length - 1; i >= 0; i--) {
      const r = STATE.results[i];
      if (r.roomId === info.roomId && !r.downloadId) {
        r.downloadId = String(delta.id);
        r.downloadedFilename = info.filename;
        r.status = "Downloaded";
        r.reason = "Download completed";
        break;
      }
    }

    // Not strictly load-bearing for final correctness - a crash between
    // this event and the run's own natural end would still leave this
    // room correctly upgraded to "Downloaded" by verifySuccessAttemptedResults()
    // when the run finishes (it checks Chrome's own download history
    // directly, not just whatever was last persisted). Checkpointed here
    // anyway so the on-disk resume snapshot reflects reality as closely
    // to real time as reasonably possible, not just at each room's
    // *initial* result - this is the one place a room's status can
    // change *after* processRoom() already returned and persisted its
    // first (pre-download-completion) result.
    persistJob();
    broadcastStatus();
  }

  if (delta.error) {
    info.error = delta.error.current;

    for (let i = STATE.results.length - 1; i >= 0; i--) {
      const r = STATE.results[i];
      if (r.roomId === info.roomId && !r.downloadId) {
        r.downloadId = String(delta.id);
        r.status = "Download Error";
        r.reason = delta.error.current || "Download error";
        break;
      }
    }

    persistJob();
    broadcastStatus();
  }
});

// If the Docusign tab running an active scan gets closed mid-scan (the
// user closes it, navigates away in a way that kills the content script,
// or Chrome reclaims it), that content script's whole execution context
// disappears with it - no DS_SCAN_COMPLETE will ever arrive to reset
// STATE.scanning, which would otherwise stay stuck `true` forever,
// permanently blocking every future scan with "already in progress" even
// though nothing is actually running. This is the scan-relay's version of
// the same problem runWorker()'s tab-liveness check solves for worker
// tabs - the difference is a scan has exactly one tab and no natural
// per-iteration point to poll it, so an event listener is the simpler fit
// here rather than adapting that polling pattern.
chrome.tabs.onRemoved.addListener(tabId => {
  if (STATE.scanTabId !== tabId) return;

  STATE.scanning = false;
  updateKeepAwake();
  STATE.scanTabId = null;
  STATE.scanMode = null;
  STATE.scanDateRangeLabel = null;
  STATE.scanCheckpointFilename = null;
  chrome.alarms.clear(SCAN_WATCHDOG_ALARM);

  logWorkerEvent("scan_tab_closed", { tabId });
  chrome.runtime.sendMessage({ type: "DS_SCAN_FAILED", reason: "The Docusign tab was closed while scanning." }).catch(() => {});
});

// A full navigation or reload of the scan tab is just as fatal to an
// in-flight scan as closing it outright - it destroys and replaces the
// content script's entire JS execution context, silently taking
// scanControl and the whole autoScrollAndCollectRooms() call with it, with
// no error and no chrome.tabs.onRemoved event (the tab itself never
// closes, only its page does). Without this listener, STATE.scanning would
// stay stuck `true` forever exactly like the closed-tab case above, but
// with no event to catch it - confirmed there was genuinely no other
// signal available for this case. changeInfo.status === "loading" only
// fires on a real navigation/reload (a new document being requested), not
// on Docusign's own client-side route changes within the page, so this
// can't misfire on ordinary in-app navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== STATE.scanTabId || changeInfo.status !== "loading") return;

  STATE.scanning = false;
  updateKeepAwake();
  STATE.scanTabId = null;
  STATE.scanMode = null;
  STATE.scanDateRangeLabel = null;
  STATE.scanCheckpointFilename = null;
  chrome.alarms.clear(SCAN_WATCHDOG_ALARM);

  logWorkerEvent("scan_tab_navigated", { tabId });
  chrome.runtime.sendMessage({ type: "DS_SCAN_FAILED", reason: "The Docusign tab was reloaded or navigated away while scanning." }).catch(() => {});
});

// The two listeners above catch a scan tab that's closed or navigated away
// - both real, observable tab-lifecycle events. A tab that crashes
// ("Aw, Snap!") is neither: Chrome leaves it in place, showing its own
// error page, with no dedicated chrome.tabs event for "this tab's renderer
// died" - confirmed there's genuinely no direct signal available for this
// specific case, unlike the two above. This alarm-driven watchdog is the
// only way to detect it: if a scan is active and none of DS_SCAN_PROGRESS,
// DS_SCAN_CHECKPOINT, or DS_SCAN_ACTIVITY (all three update
// STATE.lastScanActivityAt) have arrived in over SCAN_STALL_THRESHOLD_MS,
// something is almost certainly wrong - reported the same way as the two
// structurally-detectable cases
// above, through DS_SCAN_FAILED, rather than leaving the panel frozen
// indefinitely waiting for a tab that will never respond again. Uses
// chrome.alarms rather than setInterval specifically because MV3 service
// workers are ephemeral - an alarm survives the worker being killed and
// restarted (Chrome wakes it back up when the alarm fires), where a
// setInterval timer would simply be gone the moment the worker was.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== SCAN_WATCHDOG_ALARM) return;
  if (!STATE.scanning || !STATE.lastScanActivityAt) return;

  const idleMs = Date.now() - STATE.lastScanActivityAt;
  if (idleMs < SCAN_STALL_THRESHOLD_MS) return;

  STATE.scanning = false;
  updateKeepAwake();
  STATE.scanTabId = null;
  STATE.scanMode = null;
  STATE.scanDateRangeLabel = null;
  STATE.scanCheckpointFilename = null;
  chrome.alarms.clear(SCAN_WATCHDOG_ALARM);

  logWorkerEvent("scan_watchdog_stalled", { idleMs });
  chrome.runtime.sendMessage({
    type: "DS_SCAN_FAILED",
    reason: "The scan appears to have stopped responding (no progress for over 2 minutes) - the Docusign tab may have crashed. Check that tab, close or reload it, and try again. If a checkpoint was saved, you'll find it in Downloads / Docusign Rooms / _Scan Lists (filename ending \"in progress - partial\")."
  }).catch(() => {});
});

// Module-level, not STATE - a live browser resource (a window either
// exists or it doesn't), not resumable job data, so it has no business
// in chrome.storage.local or surviving a restart the way STATE's
// persisted fields do. A fresh service worker start always begins with
// this unset, which is correct: any window that was open before a
// restart is a real Chrome window that still exists independently of
// this variable - the next click on the toolbar icon will find it via
// chrome.windows.get() below regardless, this is just a fast-path cache.
let panelWindowId = null;

// Opens the standalone panel window (see DESIGN.md's write-up on why the
// panel moved out of the page: an in-page floating panel dies on every
// refresh and only exists on the tab it was injected into, which made it
// hard to use during a long-running scan or download job) - or, if one is
// already open, focuses it instead of creating a second one.
chrome.action.onClicked.addListener(async () => {
  if (panelWindowId !== null) {
    const existing = await chrome.windows.get(panelWindowId).catch(() => null);
    if (existing) {
      await chrome.windows.update(panelWindowId, { focused: true }).catch(() => {});
      return;
    }
    // The window was closed since we last tracked it (or Chrome restarted
    // without one open) - fall through and create a fresh one.
    panelWindowId = null;
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("panel.html"),
    type: "popup",
    width: 360,
    height: 720
  }).catch(() => null);

  if (created) panelWindowId = created.id;
});

// Runs every time this service worker starts up - fresh install, browser
// restart, or (far more commonly) Chrome killing this ephemeral worker
// mid-run and later respawning it. Picks up a job that was still running
// when this instance's in-memory STATE was lost, instead of leaving it
// stranded with no way to continue short of rescanning from scratch.
//
// Rebuilds `pending` as "queue minus anything with a result" rather than
// resuming from a saved index - see persistJob()'s comment for why that
// matters once several tabs can be claiming rooms concurrently: an index
// alone can't tell the difference between "finished" and "claimed by some
// tab right before the crash," and resuming from it would silently drop
// the latter instead of retrying them.
//
// Known limitation: this only fires once something wakes the worker -
// there's no periodic self-wake (no chrome.alarms) here, so resume isn't
// instant if the browser sits fully closed or no matching tab gets
// opened. In practice, whichever happens first wakes it: a content
// script's DS_ROOM_PAGE_INFO message (sent automatically ~2.5s after any
// Docusign room page loads) or the user reopening the standalone panel
// via the toolbar icon, which fires its own DS_GET_STATUS call on load -
// unlike the old in-page panel, that no longer happens automatically on
// every Docusign Rooms page, only when the user actually opens it.
(async () => {
  const stored = await chrome.storage.local.get(PERSIST_KEY);
  const job = stored[PERSIST_KEY];

  // Restored first (if there's anything to restore) so the log entries
  // below land in the same continuous history instead of starting a
  // fresh array that would just get overwritten again a few lines down -
  // this is the one place STATE.workerEvents survives a restart at all.
  if (job?.workerEvents?.length) {
    STATE.workerEvents = job.workerEvents;
  }

  // Logged unconditionally, before any of the early-return checks below -
  // this is the actual answer to "did the service worker even restart,"
  // visible in the service worker console and the panel's event log
  // regardless of what happens next. Previously there was no way to tell
  // "resume didn't fire because there was nothing to resume" apart from
  // "the service worker never restarted at all" after the fact - both
  // looked identical (nothing happened) from outside.
  logWorkerEvent("service_worker_started", { hasPersistedJob: !!job, persistedQueueLength: job?.queue?.length || 0 });

  if (!job || !job.queue?.length) {
    logWorkerEvent("resume_skipped", { reason: "no persisted job" });
    return;
  }

  const completedIds = new Set((job.results || []).map(r => r.roomId));
  const pending = job.queue.filter(r => !completedIds.has(r.roomId));

  if (!pending.length) {
    logWorkerEvent("resume_skipped", { reason: "persisted job has nothing pending - every room already has a result" });
    return;
  }

  // A DS_START_QUEUE could have arrived and already reserved STATE.running
  // while this block was awaiting chrome.storage.local.get() above - same
  // race as the one closed in the DS_START_QUEUE handler, mirrored here.
  if (STATE.running) {
    logWorkerEvent("resume_skipped", { reason: "STATE.running was already true (DS_START_QUEUE arrived first)" });
    return;
  }
  STATE.running = true;
  updateKeepAwake();

  STATE.queue = job.queue;
  STATE.folderNames = computeFolderNames(STATE.queue);
  STATE.pending = pending;
  STATE.index = 0;
  STATE.results = job.results || [];
  STATE.paused = !!job.paused;
  STATE.startedAt = job.startedAt || null;
  STATE.stopped = false;
  STATE.currentRooms = {};
  STATE.downloads = {};
  STATE.workerTabIds = [];
  // Falls back to the default for a job persisted by an older version
  // that didn't have this field, same as DS_START_QUEUE's handling above.
  STATE.workerTabCount = clampWorkerTabCount(job.workerTabCount);
  STATE.runDateRangeLabel = typeof job.runDateRangeLabel === "string" ? job.runDateRangeLabel : null;

  logWorkerEvent("run_resumed", { pendingCount: pending.length, totalQueue: job.queue.length });

  runQueue();
})();

// Test-only, mirrors content/utils.js's export tail - `module` never
// exists in a real service worker. Exposes the pure/STATE-driven logic
// worth unit testing directly (queue claiming, folder-name collision
// handling, download-to-room matching, CSV field escaping) without
// touching anything chrome.* or timing-dependent. STATE itself is
// exported too, not just the functions that close over it - claimNextRoom()
// and findCurrentRoomForDownload() both read/write STATE.pending,
// STATE.index, and STATE.currentRooms directly rather than taking them as
// parameters (correctly, for production - there's exactly one STATE), so
// tests set those up by mutating the same object the functions actually use.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STATE,
    computeFolderNames,
    csvEscape,
    nowStamp,
    claimNextRoom,
    findCurrentRoomForDownload,
    logWorkerEvent,
    MAX_WORKER_EVENTS,
    clampWorkerTabCount,
    DEFAULT_WORKER_TAB_COUNT,
    MIN_WORKER_TAB_COUNT,
    MAX_WORKER_TAB_COUNT,
    labeledFilename,
    safeEncodeURIComponent,
    waitForInFlightDownloadsToSettle,
    matchVerifiedDownloads,
    withTimeout,
    SCAN_WATCHDOG_ALARM,
    SCAN_STALL_THRESHOLD_MS,
    persistJob,
    clearPersistedJob,
    PERSIST_KEY,
    createReport
  };
}
