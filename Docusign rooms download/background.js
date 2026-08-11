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

// Hardcoded for this first concurrency pass - Roadmap item 3 (adaptive
// worker-tab count based on measured speed) will make this a suggested,
// tunable value instead of a constant. Kept small deliberately: prove
// the concurrency-safe claiming logic works before scaling it up.
const WORKER_TAB_COUNT = 3;

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
  // Keyed by tabId - was a single STATE.currentRoom object before
  // concurrency, since only one room was ever in flight at a time. Now
  // there's one entry per active worker tab.
  currentRooms: {},
  // roomId -> folder name, computed once by computeFolderNames() whenever
  // STATE.queue is set. Not persisted - it's a pure function of the
  // queue, cheap to rebuild on resume, so there's no reason to treat it
  // as state that could drift out of sync with the queue it's derived
  // from.
  folderNames: new Map(),
  results: [],
  downloads: {},
  startedAt: null,
  finishedAt: null
};

const PERSIST_KEY = "dsJob";

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
async function persistJob() {
  if (!STATE.queue.length) {
    await clearPersistedJob();
    return;
  }

  try {
    await chrome.storage.local.set({
      [PERSIST_KEY]: {
        queue: STATE.queue,
        results: STATE.results,
        paused: STATE.paused,
        startedAt: STATE.startedAt
      }
    });
  } catch (e) {
    console.warn("persistJob: chrome.storage.local.set failed, continuing without this checkpoint", e);
  }
}

async function clearPersistedJob() {
  try {
    await chrome.storage.local.remove(PERSIST_KEY);
  } catch (e) {
    console.warn("clearPersistedJob: chrome.storage.local.remove failed", e);
  }
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
function computeFolderNames(queue) {
  const nameCounts = new Map();

  queue.forEach(room => {
    const name = cleanName(room.roomName || `Docusign Room ${room.roomId}`);
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  });

  const folderNames = new Map();

  queue.forEach(room => {
    const name = cleanName(room.roomName || `Docusign Room ${room.roomId}`);
    const folderName = nameCounts.get(name) > 1 ? `${name} (${room.roomId})` : name;
    folderNames.set(room.roomId, folderName);
  });

  return folderNames;
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
      results: STATE.results,
      startedAt: STATE.startedAt,
      finishedAt: STATE.finishedAt
    }
  };

  try {
    const tabs = await chrome.tabs.query({ url: "https://rooms.docusign.com/*" });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  } catch (e) {}
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

// Verifies any previously-known worker tabs are still alive (survives a
// resume, where the old tab IDs from before a crash are almost
// certainly gone) and creates however many more are needed to reach
// `count`. Each one gets fully activated again on every room it
// processes anyway (see processRoom()), so the `active` flag here just
// controls which one is frontmost at creation time, not whether
// downloads work - only the first is set active to avoid every new tab
// popping to the front during startup.
async function ensureWorkerTabs(count) {
  const alive = [];

  for (const id of STATE.workerTabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) alive.push(id);
  }

  STATE.workerTabIds = alive;

  while (STATE.workerTabIds.length < count) {
    const tab = await chrome.tabs.create({
      url: "about:blank",
      active: STATE.workerTabIds.length === 0
    });
    STATE.workerTabIds.push(tab.id);
  }

  return STATE.workerTabIds;
}

async function createReport() {
  STATE.finishedAt = new Date().toISOString();

  const rows = [
    [
      "Room #",
      "Room Name",
      "Room ID",
      "Documents URL",
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
      r?.status || "Waiting",
      r?.reason || "Not yet processed",
      r?.downloadedFilename || "",
      r?.downloadId || "",
      r?.time || ""
    ]);
  });

  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  const filename = `Docusign Rooms/_Download Reports/Docusign Rooms Download Report ${nowStamp()}.csv`;

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

      const response = await chrome.tabs.sendMessage(tabId, {
        type: "DS_PROCESS_ROOM",
        roomId,
        documentsUrl
      }).catch(err => ({ ok: false, reason: err.message || "Could not message room tab" }));

      const finalRoomName = cleanName(response?.roomName || guessedRoomName);

      result.roomName = finalRoomName;
      result.status = response?.ok ? "Success/Attempted" : "Failed";
      result.reason = response?.reason || (response?.ok ? "Download click attempted" : "Unknown failure");
      result.time = new Date().toISOString();
      // Uses the precomputed, collision-disambiguated folder name (keyed
      // by roomId), not finalRoomName - onDeterminingFilename below only
      // ever sees currentRoom.roomName (set from guessedRoomName at
      // claim time, not this possibly-refreshed finalRoomName), so using
      // the same source here keeps the reported filename matching what
      // Chrome actually creates instead of drifting if the live page's
      // room name differs slightly from what was in the original scan.
      const folderName = STATE.folderNames.get(roomId) || finalRoomName;
      result.downloadedFilename = `Docusign Rooms/${folderName}/${folderName}.zip`;

      STATE.results.push(result);
      await persistJob();

      // Real signal instead of a flat guess: wait for
      // chrome.downloads.onDeterminingFilename to actually fire for this
      // room (up to 15s) rather than always paying a fixed 4.5s.
      if (response?.ok && !STATE.stopped) {
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
  while (true) {
    if (!(await waitIfPausedOrStopped())) break;

    const room = claimNextRoom();
    if (!room) break;

    const keepGoing = await processRoom(tabId, room);
    if (!keepGoing) break;

    await sleep(500);
  }

  delete STATE.currentRooms[tabId];
}

async function runQueue() {
  STATE.running = true;
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
  // end of a larger one) doesn't need WORKER_TAB_COUNT tabs sitting open
  // with nothing to claim.
  const tabCount = Math.min(WORKER_TAB_COUNT, STATE.pending.length) || 1;
  const tabIds = await ensureWorkerTabs(tabCount);

  await Promise.all(tabIds.map(id => runWorker(id)));

  STATE.running = false;
  STATE.currentRooms = {};

  // Covers both ways the workers can all stop - running out of pending
  // rooms and an explicit Stop both end here (Promise.all only resolves
  // once every worker's loop has exited), so one call handles both:
  // nothing left to resume either way.
  await clearPersistedJob();

  await createReport().catch(() => "");
  await broadcastStatus();

  try {
    if (STATE.workerTabIds[0]) {
      // Keep one tab focused so the user can see where it ended.
      await chrome.tabs.update(STATE.workerTabIds[0], { active: true }).catch(() => {});
    }
  } catch (e) {}
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

      const rooms = Array.isArray(message.rooms) ? message.rooms : [];
      const normalized = rooms
        .map(room => {
          const documentsUrl = room.documentsUrl || roomUrlToDocumentsUrl(room.url || room.href);
          if (!documentsUrl) return null;
          const roomId = getRoomIdFromUrl(documentsUrl);
          return {
            roomId,
            roomName: cleanName(room.roomName || room.title || `Docusign Room ${roomId}`),
            documentsUrl
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
        documentsUrl: r.documentsUrl
      }));

      STATE.queue = [...priorRoomsForQueue, ...normalized];
      STATE.folderNames = computeFolderNames(STATE.queue);
      STATE.pending = normalized;
      STATE.index = 0;
      STATE.results = priorResults.slice();
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
          results: STATE.results,
          startedAt: STATE.startedAt,
          finishedAt: STATE.finishedAt
        }
      });
      return;
    }

    if (message.type === "DS_EXPORT_SCAN_LIST") {
      const rooms = Array.isArray(message.rooms) ? message.rooms : [];

      const rows = [
        ["Room #", "Room Name", "Room ID", "Documents URL", "Created Date"]
      ];

      rooms.forEach((r, idx) => {
        rows.push([
          idx + 1,
          r.roomName || "",
          r.roomId || "",
          r.documentsUrl || "",
          String(r.createdDate || "").slice(0, 10)
        ]);
      });

      const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
      const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
      const filename = `Docusign Rooms/_Scan Lists/Scan List ${nowStamp()}.csv`;

      try {
        await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        });
        sendResponse({ ok: true, filename, total: rooms.length });
      } catch (error) {
        sendResponse({ ok: false, reason: error.message || "CSV export failed" });
      }
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
    return;
  }

  const roomName = cleanName(currentRoom.roomName || `Docusign Room ${currentRoom.roomId}`);
  // Two different rooms can share the same display name (e.g. two
  // "Ponchak - Listing" rooms with different IDs) - cleanName() alone
  // would send both into the same folder, silently merging their
  // downloads. STATE.folderNames (built once per run by
  // computeFolderNames()) appends the room ID only where a collision
  // actually exists in this run's queue, so most rooms still get a
  // plain, readable folder name.
  const folderName = STATE.folderNames.get(currentRoom.roomId) || roomName;
  const filename = `Docusign Rooms/${folderName}/${folderName}.zip`;

  STATE.downloads[downloadItem.id] = {
    roomId: currentRoom.roomId,
    roomName,
    filename,
    startedAt: new Date().toISOString()
  };

  // This creates a folder even if the Docusign export contains only one file,
  // because every download is saved as Docusign Rooms/<Room Name>/<Room Name>.zip
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

    broadcastStatus();
  }
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
// opened. In practice the panel's own DS_GET_STATUS call on load (every
// Docusign Rooms page) is what wakes it, the next time the user checks in.
(async () => {
  const stored = await chrome.storage.local.get(PERSIST_KEY);
  const job = stored[PERSIST_KEY];

  if (!job || !job.queue?.length) return;

  const completedIds = new Set((job.results || []).map(r => r.roomId));
  const pending = job.queue.filter(r => !completedIds.has(r.roomId));

  if (!pending.length) return;

  // A DS_START_QUEUE could have arrived and already reserved STATE.running
  // while this block was awaiting chrome.storage.local.get() above - same
  // race as the one closed in the DS_START_QUEUE handler, mirrored here.
  if (STATE.running) return;
  STATE.running = true;

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
    findCurrentRoomForDownload
  };
}
