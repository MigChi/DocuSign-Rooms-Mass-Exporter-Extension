/**************************************************************
 * Docusign Rooms Mass Exporter - panel.js
 * Behavior for the standalone panel window (panel.html) - opened by
 * background.js's chrome.action.onClicked handler, independent of any
 * Docusign tab. This used to be content.js's injectPanel(), living
 * inline inside the Docusign page; moved out so the controls and status
 * display survive a page refresh or switching away from the Docusign
 * tab, which the old in-page version couldn't (see DESIGN.md).
 *
 * The one thing this page genuinely cannot do that the old in-page panel
 * could: touch the Docusign page's DOM directly. Scanning
 * (autoScrollAndCollectRooms) still runs inside a content script, in an
 * actual Docusign tab - this file requests one via background.js
 * (DS_RUN_SCAN) and gets the result back over messages
 * (DS_SCAN_PROGRESS / DS_SCAN_RESULT), rather than calling it directly.
 *
 * Depends on content/utils.js, loaded first via panel.html's own
 * <script> tags (same load-order requirement as manifest.json's
 * content_scripts array, just expressed as HTML here instead).
 **************************************************************/

const WORKER_TAB_COUNT_DEFAULT = 3;
const WORKER_TAB_COUNT_MIN = 1;
const WORKER_TAB_COUNT_MAX = 8;

const statusEl = document.getElementById("dsbd-status");
const progressEl = document.getElementById("dsbd-progress");
const breakdownEl = document.getElementById("dsbd-breakdown");
const workersEl = document.getElementById("dsbd-workers");
const eventLogEl = document.getElementById("dsbd-eventlog");
const workerCountLabelEl = document.getElementById("dsbd-worker-count-label");
const workerCountInputEl = document.getElementById("dsbd-worker-count");

workerCountLabelEl.textContent = `Worker tabs (${WORKER_TAB_COUNT_MIN}-${WORKER_TAB_COUNT_MAX})`;
workerCountInputEl.min = String(WORKER_TAB_COUNT_MIN);
workerCountInputEl.max = String(WORKER_TAB_COUNT_MAX);
workerCountInputEl.value = String(WORKER_TAB_COUNT_DEFAULT);

const setStatus = text => {
  statusEl.textContent = text;
};

// A stand-in for window.confirm() - confirmed live: Chrome silently
// suppresses a real confirm()/alert()/prompt() dialog whenever the
// window that called it isn't the currently focused one, auto-resolving
// it as Cancel with no visible error at all. This panel is a standalone
// popup window, and a scan can run for several minutes - long enough
// that a user reasonably switches away and isn't looking at this window
// the instant a scan finishes and tries to confirm starting the run. A
// DOM overlay is just page content, not an OS-level modal - it can never
// be suppressed that way, so this replaces every confirm() call in this
// file. Returns a Promise<boolean> instead of a synchronous boolean,
// which is why every caller became `async`/`await` rather than a plain
// `if (confirm(...))` check.
const confirmOverlayEl = document.getElementById("dsbd-confirm-overlay");
const confirmMessageEl = document.getElementById("dsbd-confirm-message");
const confirmOkBtn = document.getElementById("dsbd-confirm-ok");
const confirmCancelBtn = document.getElementById("dsbd-confirm-cancel");

// A real confirm() is fully blocking at the OS level, so two calls in the
// same page could never overlap. This one can't make that guarantee on
// its own - it's just a Promise, and two showConfirmDialog() calls close
// together (a scan finishing right as someone clicks Stop, say) would
// otherwise both attach listeners to the same single overlay at once,
// letting one click resolve both pending Promises incorrectly. Chained
// onto confirmDialogChain so calls are serialized instead: each new
// dialog only actually appears once whatever's currently pending has
// been answered, never layered underneath it.
let confirmDialogChain = Promise.resolve();

function showConfirmDialog(message) {
  const run = () => new Promise(resolve => {
    confirmMessageEl.textContent = message;
    confirmOverlayEl.hidden = false;

    const cleanup = result => {
      confirmOverlayEl.hidden = true;
      confirmOkBtn.removeEventListener("click", onOk);
      confirmCancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    // Enter/Escape mirror the real confirm() dialog's own keyboard
    // behavior, so this doesn't feel like a downgrade to anyone used to
    // the native one.
    const onKeydown = event => {
      if (event.key === "Enter") onOk();
      else if (event.key === "Escape") onCancel();
    };

    confirmOkBtn.addEventListener("click", onOk);
    confirmCancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeydown);
    confirmOkBtn.focus();
  });

  const next = confirmDialogChain.then(run);
  confirmDialogChain = next;
  return next;
}

// One row per worker tab (s.workerTabIds, in creation order - stable for
// the run's lifetime, unlike raw Chrome tab IDs which mean nothing to a
// user) showing which room it currently has claimed, or "idle" if it has
// none. Built with DOM APIs and .textContent rather than innerHTML - room
// names are already run through cleanName() before reaching here (see
// background.js's DS_ROOM_PAGE_INFO handler), which happens to strip
// HTML-unsafe characters too, but that's a filename-safety guarantee, not
// an XSS one, so this doesn't lean on it.
function renderWorkers(s) {
  const workerTabIds = s.workerTabIds || [];
  workersEl.textContent = "";
  if (!workerTabIds.length) return;

  const byTabId = new Map((s.currentRooms || []).map(r => [r.tabId, r]));

  workerTabIds.forEach((tabId, i) => {
    const room = byTabId.get(tabId);
    const row = document.createElement("div");
    row.className = "dsbd-worker-row" + (room ? "" : " dsbd-worker-idle");

    if (!room) {
      row.textContent = `Worker ${i + 1}: idle`;
    } else {
      const claimedMs = room.claimedAt ? new Date(room.claimedAt).getTime() : NaN;
      const elapsedS = Number.isFinite(claimedMs) ? Math.max(0, Math.round((Date.now() - claimedMs) / 1000)) : null;
      const label = room.roomName || room.roomId || "Unknown room";
      row.textContent = `Worker ${i + 1}: ${label}` + (elapsedS === null ? "" : ` · ${elapsedS}s`);
    }

    workersEl.appendChild(row);
  });
}

// Tallies s.results by their .status string - the per-room outcome
// breakdown short of opening the final CSV report.
function renderBreakdown(s) {
  const counts = {};
  (s.results || []).forEach(r => {
    const key = r.status || "Unknown";
    counts[key] = (counts[key] || 0) + 1;
  });
  const waiting = Math.max(0, (s.total || 0) - (s.results?.length || 0));

  const parts = [];
  if (counts["Downloaded"]) parts.push(`Downloaded ${counts["Downloaded"]}`);
  if (counts["Complete (Empty)"]) parts.push(`Empty ${counts["Complete (Empty)"]}`);
  if (counts["Success/Attempted"]) parts.push(`In progress ${counts["Success/Attempted"]}`);
  if (counts["Failed"]) parts.push(`Failed ${counts["Failed"]}`);
  if (counts["Download Error"]) parts.push(`Errors ${counts["Download Error"]}`);
  if (waiting) parts.push(`Waiting ${waiting}`);

  breakdownEl.textContent = parts.join(" · ");
}

// s.workerEvents arrives oldest-first (how background.js appends them)
// but is shown newest-first here, since the most recent event is what
// you actually came to check.
function renderEventLog(s) {
  const events = s.workerEvents || [];
  eventLogEl.textContent = "";

  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "dsbd-eventlog-empty";
    empty.textContent = "No activity yet.";
    eventLogEl.appendChild(empty);
    return;
  }

  events.slice().reverse().forEach(evt => {
    const row = document.createElement("div");
    row.className = "dsbd-eventlog-row";
    const time = evt.time ? new Date(evt.time).toLocaleTimeString() : "";
    row.textContent = `${time} — ${describeWorkerEvent(evt)}`;
    eventLogEl.appendChild(row);
  });
}

function readDateRange() {
  const startVal = document.getElementById("dsbd-date-start").value;
  const endVal = document.getElementById("dsbd-date-end").value;

  if (!startVal || !endVal) {
    setStatus("Set both a From and To date before scanning.");
    return null;
  }

  const start = new Date(startVal);
  const end = new Date(endVal);

  if (start > end) {
    setStatus("The From date must be before the To date.");
    return null;
  }

  return { start, end };
}

function readWorkerTabCount() {
  const value = workerCountInputEl.value;
  return parseWorkerTabCountInput(value, WORKER_TAB_COUNT_MIN, WORKER_TAB_COUNT_MAX, WORKER_TAB_COUNT_DEFAULT);
}

// Shared by the post-scan "start" flow and the CSV-upload flow - confirms
// with the user, then hands the room list to background.js. priorResults
// (only non-empty for a resumed CSV upload) is forwarded as-is so
// background.js can seed the new run's results/report with rooms already
// known to be done. async because showConfirmDialog() is - see its own
// comment for why this can no longer be a synchronous confirm() check.
async function beginRun(rooms, confirmMessage, priorResults = [], dateRangeLabel = null) {
  if (!rooms.length) {
    setStatus("No rooms to run - the list is empty.");
    return;
  }

  const confirmed = await showConfirmDialog(confirmMessage);

  if (!confirmed) {
    setStatus("Cancelled.");
    return;
  }

  setStatus(`Starting ${rooms.length} rooms...`);
  progressEl.textContent = `${priorResults.length} / ${rooms.length + priorResults.length}`;

  chrome.runtime.sendMessage({
    type: "DS_START_QUEUE",
    rooms,
    priorResults,
    workerTabCount: readWorkerTabCount(),
    dateRangeLabel
  }).then(response => {
    if (!response?.ok) {
      setStatus(response?.reason || "Could not start.");
    }
  }).catch(() => {
    setStatus("Could not reach the extension - it may need to be reloaded.");
  });
}

const csvInput = document.getElementById("dsbd-csv-input");

document.getElementById("dsbd-upload").addEventListener("click", () => {
  csvInput.click();
});

csvInput.addEventListener("change", async () => {
  const file = csvInput.files?.[0];
  csvInput.value = "";
  if (!file) return;

  setStatus(`Reading ${file.name}...`);

  const text = await file.text();
  const rows = parseCsv(text);
  const { rooms, priorResults } = parseUploadedCsv(rows);

  if (!rooms.length) {
    setStatus(priorResults.length
      ? `Everything in ${file.name} is already marked Downloaded or Complete (Empty) - nothing to run.`
      : "No usable rooms found in that CSV. Expected a Scan List or Download Report exported by this extension.");
    return;
  }

  const priorNote = priorResults.length > 0
    ? ` (${priorResults.length} already-done room${priorResults.length === 1 ? "" : "s"} preserved, not re-run)`
    : "";

  beginRun(
    rooms,
    `Found ${rooms.length} rooms to process in ${file.name}${priorNote}.\n\nThis will open worker tabs, download each room's documents, save each ZIP inside its own room folder, and create a CSV report when done. No scan needed - these rooms come straight from the file.\n\nChrome may ask you to allow multiple downloads.\n\nContinue?`,
    priorResults
  );
});

const startStopBtn = document.getElementById("dsbd-startstop");
const pauseResumeBtn = document.getElementById("dsbd-pauseresume");

let isRunning = false;
let isPaused = false;
// Mirrors what background.js/content.js report back over the scan-relay
// messages - this page doesn't own the actual scan (content.js does), so
// unlike the old in-page panel's `scanControl` object, these are just a
// local reflection of state that lives elsewhere, updated optimistically
// on click and authoritatively by DS_GET_STATUS/DS_SCAN_PROGRESS/
// DS_SCAN_RESULT.
let scanInProgress = false;
let scanPaused = false;

// Drives both toggle buttons' label/color/disabled state. Also factors in
// scanInProgress/scanPaused (background.js has no persisted concept of
// "paused" for a scan the way it does for a run, so those two flags are
// this page's own best-known reflection of it).
function updateButtonStates(s) {
  isRunning = !!s.running;
  isPaused = !!s.paused;

  const active = isRunning || scanInProgress;
  const paused = isPaused || (scanInProgress && scanPaused);

  startStopBtn.textContent = active ? "Stop" : "Start";
  startStopBtn.classList.toggle("dsbd-state-start", !active);
  startStopBtn.classList.toggle("dsbd-state-stop", active);

  pauseResumeBtn.textContent = paused ? "Resume" : "Pause";
  pauseResumeBtn.classList.toggle("dsbd-state-pause", !paused);
  pauseResumeBtn.classList.toggle("dsbd-state-resume", paused);
  pauseResumeBtn.disabled = !active;
}

startStopBtn.addEventListener("click", async () => {
  if (scanInProgress) {
    const confirmed = await showConfirmDialog("Stop scanning? Rooms found so far will still be used.");
    if (!confirmed) return;
    chrome.runtime.sendMessage({ type: "DS_SCAN_STOP" }).catch(() => {});
    setStatus("Stopping scan...");
    return;
  }

  if (isRunning) {
    const confirmed = await showConfirmDialog("Stop after the current step?");
    if (!confirmed) return;
    chrome.runtime.sendMessage({ type: "DS_STOP" }).catch(() => {});
    setStatus("Stopping...");
    return;
  }

  const dateRange = readDateRange();
  if (!dateRange) return;

  scanInProgress = true;
  scanPaused = false;
  updateButtonStates({ running: false, paused: false });
  setStatus("Requesting a scan from the Docusign tab...");

  chrome.runtime.sendMessage({
    type: "DS_RUN_SCAN",
    dateRange,
    dateRangeLabel: formatDateRangeLabel(dateRange),
    mode: "start"
  }).then(response => {
    if (!response?.ok) {
      scanInProgress = false;
      updateButtonStates({ running: false, paused: false });
      setStatus(response?.reason || "Could not start scanning.");
    }
    // response.ok just means the scan *started* - the result arrives
    // later via the DS_SCAN_RESULT listener below.
  }).catch(() => {
    scanInProgress = false;
    updateButtonStates({ running: false, paused: false });
    setStatus("Could not reach the extension - it may need to be reloaded.");
  });
});

document.getElementById("dsbd-scan-export").addEventListener("click", () => {
  if (scanInProgress || isRunning) {
    setStatus("A scan or run is already in progress.");
    return;
  }

  const dateRange = readDateRange();
  if (!dateRange) return;

  scanInProgress = true;
  scanPaused = false;
  updateButtonStates({ running: false, paused: false });
  setStatus("Requesting a scan from the Docusign tab...");

  chrome.runtime.sendMessage({
    type: "DS_RUN_SCAN",
    dateRange,
    dateRangeLabel: formatDateRangeLabel(dateRange),
    mode: "export"
  }).then(response => {
    if (!response?.ok) {
      scanInProgress = false;
      updateButtonStates({ running: false, paused: false });
      setStatus(response?.reason || "Could not start scanning.");
    }
  }).catch(() => {
    scanInProgress = false;
    updateButtonStates({ running: false, paused: false });
    setStatus("Could not reach the extension - it may need to be reloaded.");
  });
});

pauseResumeBtn.addEventListener("click", () => {
  if (scanInProgress) {
    scanPaused = !scanPaused;
    chrome.runtime.sendMessage({ type: scanPaused ? "DS_SCAN_PAUSE" : "DS_SCAN_RESUME" }).catch(() => {});
    setStatus(scanPaused ? "Pausing scan..." : "Resuming scan...");
    updateButtonStates({ running: false, paused: false });
    return;
  }

  if (isPaused) {
    chrome.runtime.sendMessage({ type: "DS_RESUME" }).catch(() => {});
    setStatus("Resuming...");
  } else {
    chrome.runtime.sendMessage({ type: "DS_PAUSE" }).catch(() => {});
    setStatus("Pausing after current step...");
  }
});

// Multiple rooms can be active at once (one per worker tab) -
// s.currentRooms is an array. Kept as a short one-line summary for the
// main status line; renderWorkers() shows the actual per-tab breakdown.
function runningStatusText(s) {
  const count = (s.currentRooms || []).length;
  return count ? `Running: ${count} active` : "Running...";
}

chrome.runtime.onMessage.addListener(message => {
  if (!message || !message.type) return;

  if (message.type === "DS_BULK_STATUS") {
    const s = message.state;
    progressEl.textContent = `${s.results?.length || 0} / ${s.total || 0}`;
    renderBreakdown(s);
    renderWorkers(s);
    renderEventLog(s);
    updateButtonStates(s);

    if (s.paused) {
      setStatus("Paused.");
    } else if (s.running) {
      setStatus(runningStatusText(s));
    } else if (s.finishedAt) {
      // A flat "Done" was misleading when the run actually ended with
      // rooms still genuinely ambiguous (Success/Attempted, or Waiting -
      // never claimed at all) - background.js's
      // verifySuccessAttemptedResults() already catches whatever it can
      // confirm before this report was written, but whatever's genuinely
      // still unconfirmed needs a real answer here, not silence dressed
      // up as completion.
      //
      // "Failed" is deliberately NOT counted toward that - corrected
      // directly after real use showed a run reporting "185 rooms still
      // need attention" when every one of them was actually Failed, not
      // ambiguous. A Failed room's outcome is already fully known (the
      // DOM automation ran and failed) - unlike Success/Attempted or
      // Waiting, re-uploading the report to "resolve" it doesn't clear up
      // any uncertainty, it just retries a room that's already been
      // conclusively answered. Still surfaced, just not folded into the
      // same "not done yet" framing as the genuinely unconfirmed ones.
      const results = s.results || [];
      // "Waiting" is never an actual status stored in a result - a room
      // with no result at all is what "Waiting" means (see
      // renderBreakdown() above for the same computation) - so it has to
      // be derived from total minus however many rooms got a real result,
      // not filtered out of `results` directly.
      const waiting = Math.max(0, (s.total || 0) - results.length);
      const successAttempted = results.filter(r => r.status === "Success/Attempted").length;
      const unconfirmed = waiting + successAttempted;
      const failedCount = results.filter(r => r.status === "Failed").length;
      // A separate clause, not folded into "of those" - failedCount is not
      // a subset of `unconfirmed`, it's deliberately excluded from it, so
      // wording that implied otherwise would misrepresent exactly the
      // distinction this fix exists to draw.
      const failedNote = failedCount > 0 ? `, plus ${failedCount} room${failedCount === 1 ? "" : "s"} that already failed and won't change` : "";

      if (unconfirmed > 0) {
        setStatus(`Done, but ${unconfirmed} room${unconfirmed === 1 ? "" : "s"} still need${unconfirmed === 1 ? "s" : ""} attention (not confirmed downloaded)${failedNote} - re-upload the download report to finish them. Saved in Downloads / Docusign Rooms / _Download Reports and _Activity Logs.`);
      } else if (failedCount > 0) {
        setStatus(`Done - every room downloaded or confirmed empty, except ${failedCount} room${failedCount === 1 ? "" : "s"} that failed. Report and activity log saved in Downloads / Docusign Rooms / _Download Reports and _Activity Logs.`);
      } else {
        setStatus("Done - every room downloaded or confirmed empty. Report and activity log saved in Downloads / Docusign Rooms / _Download Reports and _Activity Logs.");
      }
    }
    return;
  }

  if (message.type === "DS_SCAN_PROGRESS") {
    if (scanInProgress) setStatus(message.text);
    return;
  }

  if (message.type === "DS_SCAN_FAILED") {
    // Sent by background.js's chrome.tabs.onRemoved handler when the
    // Docusign tab running a scan gets closed mid-scan - the only way
    // STATE.scanning otherwise gets reset in that case, since the content
    // script (and any chance of it sending DS_SCAN_COMPLETE itself)
    // disappears with the tab. Reset the same local flags DS_SCAN_RESULT
    // would have reset had the scan finished normally.
    scanInProgress = false;
    scanPaused = false;
    updateButtonStates({ running: isRunning, paused: isPaused });
    setStatus(message.reason || "Scan failed.");
    return;
  }

  if (message.type === "DS_RUN_FAILED") {
    // Sent by background.js's runQueue() catch block when the run stops on
    // an uncaught error instead of finishing normally - always arrives
    // right after a DS_BULK_STATUS broadcast reporting running: false, so
    // without this, the status line above would already say something
    // that reads exactly like a normal completion ("Done, but N rooms
    // still need attention..."), silently hiding that this was actually an
    // unexpected crash. This message is deliberately the last word on the
    // status line for that reason - setStatus() here overrides whatever
    // the DS_BULK_STATUS handler just set.
    updateButtonStates({ running: isRunning, paused: isPaused });
    setStatus(message.reason || "The run stopped unexpectedly.");
    return;
  }

  if (message.type === "DS_SCAN_RESULT") {
    scanInProgress = false;
    updateButtonStates({ running: isRunning, paused: isPaused });

    const rooms = Array.isArray(message.rooms) ? message.rooms : [];

    if (message.mode === "export") {
      const response = message.response;
      if (response?.ok) {
        setStatus(`Exported ${response.total ?? rooms.length} rooms to: ${response.filename}`);
      } else {
        setStatus(response?.reason || "Could not export CSV.");
      }
      return;
    }

    // mode "start" - same confirm-then-begin flow the old in-page panel
    // used right after autoScrollAndCollectRooms() returned synchronously;
    // preserved here even though the scan itself is now async, so a live
    // scan still asks before actually starting a run, the same as
    // uploading a CSV always has.
    if (!rooms.length) {
      setStatus("No rooms found. Make sure a Docusign Rooms tab is open and on the Rooms list page.");
      return;
    }

    beginRun(
      rooms,
      `Found ${rooms.length} rooms.\n\nThis will open worker tabs, download each room's documents, save each ZIP inside its own room folder, and create a CSV report when done.\n\nChrome may ask you to allow multiple downloads.\n\nContinue?`,
      [],
      message.dateRangeLabel
    );
    return;
  }
});

chrome.runtime.sendMessage({ type: "DS_GET_STATUS" }).then(response => {
  const s = response?.state;
  if (!s) return;
  progressEl.textContent = `${s.results?.length || 0} / ${s.total || 0}`;
  renderBreakdown(s);
  renderWorkers(s);
  renderEventLog(s);
  // Reflects a scan already in progress if this panel was (re)opened
  // mid-scan - scanPaused can't be recovered this way (background.js
  // doesn't persist it), so a reopened panel assumes not-paused even if
  // it actually was; a real but narrow limitation, not silently wrong -
  // clicking Pause/Resume still works correctly from whatever the actual
  // state is, since content.js is the one enforcing it either way.
  scanInProgress = !!s.scanning;
  updateButtonStates(s);
  if (s.running) setStatus(runningStatusText(s));
  else if (s.paused) setStatus("Paused.");
  else if (scanInProgress) setStatus("A scan is already in progress...");
}).catch(() => {
  setStatus("Could not reach the extension.");
});
