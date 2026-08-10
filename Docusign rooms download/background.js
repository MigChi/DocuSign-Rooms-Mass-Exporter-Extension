/**************************************************************
 * Docusign Rooms Mass Exporter - background.js
 * Handles queue, worker tab, pause/resume/stop, filename routing,
 * and the final CSV report.
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

importScripts("content/utils.js");

const STATE = {
  running: false,
  paused: false,
  stopped: false,
  queue: [],
  index: 0,
  workerTabId: null,
  currentRoom: null,
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
async function persistJob(resumeIndex) {
  if (!STATE.queue.length) {
    await clearPersistedJob();
    return;
  }

  await chrome.storage.local.set({
    [PERSIST_KEY]: {
      queue: STATE.queue,
      // STATE.index still points at whichever room is currently being
      // processed - the for loop in runQueue() only advances it at the
      // next iteration boundary. Callers that just finished a room pass
      // index + 1 explicitly so a resume continues with the next room
      // instead of redundantly reprocessing the one that just succeeded.
      index: resumeIndex ?? STATE.index,
      results: STATE.results,
      paused: STATE.paused,
      startedAt: STATE.startedAt
    }
  });
}

async function clearPersistedJob() {
  await chrome.storage.local.remove(PERSIST_KEY);
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
      index: STATE.index,
      currentRoom: STATE.currentRoom,
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

async function ensureWorkerTab() {
  if (STATE.workerTabId) {
    const existing = await chrome.tabs.get(STATE.workerTabId).catch(() => null);
    if (existing) return existing;
    STATE.workerTabId = null;
  }

  const tab = await chrome.tabs.create({
    url: "about:blank",
    active: true
  });

  STATE.workerTabId = tab.id;
  return tab;
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

  // Was STATE.results.forEach(...) - but results only gets an entry once
  // a room is actually processed, so a run stopped partway through wrote
  // a report covering only the rooms it reached. Everything still queued
  // was silently absent, not "marked waiting" - so uploading that report
  // back in as a resume could only ever pick up what had already been
  // touched, never the rest of the original list. Walking STATE.queue
  // instead (the full original list, restored as-is on a resumed run
  // too) and looking up each room's result by roomId means every room
  // gets a row - a real result if it has one, "Waiting" if it doesn't -
  // so the CSV round-trips through Upload CSV as a genuine resume.
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

async function runQueue() {
  STATE.running = true;
  STATE.stopped = false;
  STATE.finishedAt = null;
  // Not unconditional - a resumed run already has a real startedAt
  // restored from storage, and overwriting it here would report the
  // wrong total elapsed time and, more importantly, imply the job had
  // no downtime when it may have sat interrupted for a while.
  STATE.startedAt = STATE.startedAt || new Date().toISOString();

  await broadcastStatus();

  const worker = await ensureWorkerTab();

  // No initializer here (unlike a plain `for (STATE.index = 0; ...)`) -
  // a fresh run's DS_START_QUEUE handler sets STATE.index = 0 itself
  // before calling this, and a resumed run needs to continue from
  // whatever index was restored from storage. Forcing it to 0 here would
  // silently turn every resume into a full restart from the beginning.
  for (; STATE.index < STATE.queue.length; STATE.index++) {
    if (!(await waitIfPausedOrStopped())) break;

    const room = STATE.queue[STATE.index];
    const documentsUrl = room.documentsUrl;
    const roomId = room.roomId || getRoomIdFromUrl(documentsUrl);
    const guessedRoomName = cleanName(room.roomName || `Docusign Room ${roomId}`);

    STATE.currentRoom = {
      roomId,
      roomName: guessedRoomName,
      documentsUrl
    };

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

    try {
      await chrome.tabs.update(worker.id, { url: documentsUrl, active: true });
      const loaded = await waitForTabLoaded(worker.id, 60000);

      // Stop/Pause were previously only checked once per room, at the top
      // of this loop - clicking Stop mid-room did nothing until that
      // room's entire pipeline finished (up to ~75s: tab load + the
      // content script's own internal waits + the download-start wait).
      // Re-checking here (the single longest wait) makes Stop/Pause take
      // effect right after the page load instead of only between rooms.
      if (!(await waitIfPausedOrStopped())) break;

      if (!loaded) {
        result.reason = "Room Documents page did not finish loading";
        STATE.results.push(result);
        await persistJob(STATE.index + 1);
        await broadcastStatus();
        continue;
      }

      // Only a short buffer, not a "wait for the page to be ready" delay -
      // processCurrentRoom() already polls for [data-qa="group-name"] itself
      // (up to 45s). This just covers the gap between document_idle firing
      // and the content script's onMessage listener actually being attached.
      await sleep(500);

      const response = await chrome.tabs.sendMessage(worker.id, {
        type: "DS_PROCESS_ROOM",
        roomId,
        documentsUrl
      }).catch(err => ({ ok: false, reason: err.message || "Could not message room tab" }));

      const finalRoomName = cleanName(response?.roomName || guessedRoomName);

      result.roomName = finalRoomName;
      result.status = response?.ok ? "Success/Attempted" : "Failed";
      result.reason = response?.reason || (response?.ok ? "Download click attempted" : "Unknown failure");
      result.time = new Date().toISOString();

      const expectedFilename = `Docusign Rooms/${finalRoomName}/${finalRoomName}.zip`;
      result.downloadedFilename = expectedFilename;

      STATE.results.push(result);
      await persistJob(STATE.index + 1);

      // Real signal instead of a flat guess: wait for
      // chrome.downloads.onDeterminingFilename to actually fire for this
      // room (up to 15s) rather than always paying a fixed 4.5s.
      if (response?.ok && !STATE.stopped) {
        await waitForDownloadStart(roomId, 15000);
      }

      await broadcastStatus();

      if (STATE.stopped) break;
    } catch (error) {
      result.reason = error.message || "Unknown error";
      result.time = new Date().toISOString();
      STATE.results.push(result);
      await persistJob(STATE.index + 1);
      await broadcastStatus();
    }

    await sleep(500);
  }

  STATE.running = false;
  STATE.currentRoom = null;

  // Covers both ways this loop can end - running out of rooms and an
  // explicit Stop both fall through to here (break only exits the for
  // loop, not this function), so one call handles both: nothing left to
  // resume either way.
  await clearPersistedJob();

  await createReport().catch(() => "");
  await broadcastStatus();

  try {
    if (STATE.workerTabId) {
      // Keep the tab open so the user can see where it ended.
      await chrome.tabs.update(STATE.workerTabId, { active: true }).catch(() => {});
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

      STATE.queue = normalized;
      STATE.index = 0;
      STATE.results = [];
      STATE.paused = false;
      STATE.stopped = false;
      STATE.currentRoom = null;
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
          index: STATE.index,
          currentRoom: STATE.currentRoom,
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
      if (tabId === STATE.workerTabId && STATE.currentRoom) {
        STATE.currentRoom.roomName = cleanName(message.roomName || STATE.currentRoom.roomName);
      }
      sendResponse({ ok: true });
      return;
    }
  })();

  return true;
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const isRelevantTab = downloadItem.tabId === STATE.workerTabId;
  const looksLikeZip = String(downloadItem.filename || "").toLowerCase().endsWith(".zip");
  const looksLikeDocusign =
    String(downloadItem.url || "").includes("docusign") ||
    String(downloadItem.finalUrl || "").includes("docusign") ||
    String(downloadItem.referrer || "").includes("docusign");

  if (!STATE.currentRoom || (!isRelevantTab && !looksLikeDocusign && !looksLikeZip)) {
    return;
  }

  const roomName = cleanName(STATE.currentRoom.roomName || `Docusign Room ${STATE.currentRoom.roomId}`);
  const filename = `Docusign Rooms/${roomName}/${roomName}.zip`;

  STATE.downloads[downloadItem.id] = {
    roomId: STATE.currentRoom.roomId,
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
// Known limitation: this only fires once something wakes the worker -
// there's no periodic self-wake (no chrome.alarms) here, so resume isn't
// instant if the browser sits fully closed or no matching tab gets
// opened. In practice the panel's own DS_GET_STATUS call on load (every
// Docusign Rooms page) is what wakes it, the next time the user checks in.
//
// Also known: if the crash lands mid-room - after the download click but
// before this room's result gets persisted - the resumed run reprocesses
// that same room from its start. `conflictAction: "uniquify"` means a
// resulting duplicate gets its own folder rather than overwriting
// anything, so the cost is a possible extra ZIP, not lost/corrupted data.
(async () => {
  const stored = await chrome.storage.local.get(PERSIST_KEY);
  const job = stored[PERSIST_KEY];

  if (!job || !job.queue?.length || job.index >= job.queue.length) return;

  STATE.queue = job.queue;
  STATE.index = job.index;
  STATE.results = job.results || [];
  STATE.paused = !!job.paused;
  STATE.startedAt = job.startedAt || null;
  STATE.stopped = false;
  STATE.currentRoom = null;
  STATE.downloads = {};
  STATE.workerTabId = null;

  runQueue();
})();
