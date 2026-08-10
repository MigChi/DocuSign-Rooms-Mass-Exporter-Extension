/**************************************************************
 * Docusign Rooms Bulk Downloader - background.js
 * Handles queue, worker tab, pause/resume/stop, filename routing,
 * and the final CSV report.
 **************************************************************/

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanName(name) {
  return String(name || "Unnamed Room")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Unnamed Room";
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

function getRoomIdFromUrl(url) {
  const match = String(url || "").match(/\/rooms\/(\d+)/i);
  return match ? match[1] : "";
}

function roomUrlToDocumentsUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/rooms\/(\d+)/i);
    if (!match) return null;
    return `${parsed.origin}/rooms/${match[1]}/documents`;
  } catch (e) {
    return null;
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

  STATE.results.forEach((r, idx) => {
    rows.push([
      idx + 1,
      r.roomName || "",
      r.roomId || "",
      r.documentsUrl || "",
      r.status || "",
      r.reason || "",
      r.downloadedFilename || "",
      r.downloadId || "",
      r.time || ""
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
  STATE.startedAt = new Date().toISOString();

  await broadcastStatus();

  const worker = await ensureWorkerTab();

  for (STATE.index = 0; STATE.index < STATE.queue.length; STATE.index++) {
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

      if (!loaded) {
        result.reason = "Room Documents page did not finish loading";
        STATE.results.push(result);
        await broadcastStatus();
        continue;
      }

      await sleep(3500);

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

      await sleep(4500);
      await broadcastStatus();
    } catch (error) {
      result.reason = error.message || "Unknown error";
      result.time = new Date().toISOString();
      STATE.results.push(result);
      await broadcastStatus();
    }

    await sleep(2000);
  }

  STATE.running = false;
  STATE.currentRoom = null;

  const reportName = await createReport().catch(() => "");
  await broadcastStatus();

  try {
    if (STATE.workerTabId) {
      // Keep the tab open so the user can see where it ended.
      await chrome.tabs.update(STATE.workerTabId, { active: true }).catch(() => {});
    }
  } catch (e) {}

  chrome.notifications?.create?.({
    type: "basic",
    iconUrl: "icon.png",
    title: "Docusign Rooms Bulk Downloader",
    message: reportName ? `Done. Report saved: ${reportName}` : "Done. Check Downloads folder."
  });
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

      sendResponse({ ok: true, total: STATE.queue.length });

      runQueue();
      return;
    }

    if (message.type === "DS_PAUSE") {
      STATE.paused = true;
      await broadcastStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_RESUME") {
      STATE.paused = false;
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
