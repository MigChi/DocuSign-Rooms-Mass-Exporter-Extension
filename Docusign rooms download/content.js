/**************************************************************
 * Docusign Rooms Mass Exporter - content.js
 * Adds the on-page control panel, auto-scrolls/collects rooms,
 * and processes the active room Documents page.
 **************************************************************/

(function () {
  if (window.__DS_MASS_EXPORTER_LOADED__) return;
  window.__DS_MASS_EXPORTER_LOADED__ = true;

  const PANEL_ID = "ds-mass-exporter-panel";

  function clickElement(el, label) {
    if (!el) {
      console.warn(`Could not find: ${label}`);
      return false;
    }

    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {}

    try {
      el.click();
      console.log(`Clicked: ${label}`);
      return true;
    } catch (e) {
      console.warn(`Click failed for ${label}`, e);
      return false;
    }
  }

  function anyDocumentChecked() {
    return document.querySelectorAll('input[data-qa="document-checkbox"]:checked').length > 0;
  }

  // Confirmed live (twice): clicking the native <input> directly is
  // reverted by the page every time (checked stays false) - the label and
  // input are siblings in the markup (not label-wraps-input), and the
  // app's real click handler is bound to the <label>, not the input, so a
  // click dispatched straight at the input never reaches it. label.click()
  // is confirmed working and tried first; the manually dispatched
  // MouseEvent on the checkbox remains as a fallback for any room where
  // the label isn't found. Verifies against the actual document
  // checkboxes instead of assuming success.
  async function selectAllDocuments() {
    const checkbox = document.querySelector('input[data-qa="select-all-docs"]');

    if (!checkbox) {
      console.error("Select All checkbox not found.");
      return false;
    }

    checkbox.scrollIntoView({ block: "center" });

    const label = document.querySelector('label[data-qa="select-all-docs-label"]');
    label?.click();
    await sleep(400);
    if (anyDocumentChecked()) return true;

    checkbox.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1
    }));
    await sleep(400);

    return anyDocumentChecked();
  }

  async function waitForSelector(selector, timeoutMs = 45000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const found = document.querySelector(selector);
      if (found) return found;
      await sleep(1000);
    }

    return null;
  }

  function getDocumentCount() {
    const groupName = document.querySelector('[data-qa="group-name"]');
    const match = groupName?.textContent.match(/\((\d+)\)/);
    return match ? parseInt(match[1], 10) : null;
  }

  async function processCurrentRoom(message) {
    const roomId = message.roomId || getRoomIdFromUrl();
    let roomName = getRoomNameFromPage();

    chrome.runtime.sendMessage({
      type: "DS_ROOM_PAGE_INFO",
      roomId,
      roomName,
      url: window.location.href
    }).catch(() => {});

    // "group-name" is present whether the room is empty or not, unlike the
    // Select All checkbox, which never renders at all for an empty room -
    // waiting on it instead avoids a wasted 45s timeout on every empty room.
    await waitForSelector('[data-qa="group-name"]', 45000);

    roomName = getRoomNameFromPage();

    const documentCount = getDocumentCount();

    if (documentCount === 0) {
      return {
        ok: false,
        roomId,
        roomName,
        reason: "Room is empty (0 documents)"
      };
    }

    const selected = await selectAllDocuments();
    console.log("[DSBD] selectAllDocuments() succeeded:", selected);

    if (!selected) {
      return {
        ok: false,
        roomId,
        roomName,
        reason: "Select All was not found or did not click"
      };
    }

    // Confirmed via captured markup: the bulk-actions toolbar (with the
    // Download button) only renders after the selection state updates -
    // not synchronously with the Select All click - so this polls for it
    // instead of guessing a fixed delay.
    const downloadButton = await waitForSelector(
      'button[data-qa="Download"][data-dd-action-name="Bulk Action - Download"]',
      10000
    );

    if (!downloadButton) {
      return {
        ok: false,
        roomId,
        roomName,
        reason: "Bulk download button was not found"
      };
    }

    const clickedDownload = clickElement(downloadButton, "Bulk Download button");

    if (!clickedDownload) {
      return {
        ok: false,
        roomId,
        roomName,
        reason: "Bulk download button click failed"
      };
    }

    const finalDownload = await waitForSelector('#formDownloadDocuments button[type="submit"]', 10000);

    if (finalDownload) {
      clickElement(finalDownload, "Final Download button");
      await sleep(1500);
    }

    return {
      ok: true,
      roomId,
      roomName,
      reason: "Select All and Download clicked"
    };
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="dsbd-brandbar"></div>
      <div class="dsbd-header">
        <span class="dsbd-tag">DS</span>
        <div class="dsbd-title">Rooms Mass Exporter</div>
      </div>
      <div class="dsbd-status" id="dsbd-status">Ready</div>
      <div class="dsbd-progress" id="dsbd-progress">0 / 0</div>
      <div class="dsbd-field-label">Date range</div>
      <div class="dsbd-date-row">
        <div class="dsbd-date-field">
          <label for="dsbd-date-start">From</label>
          <input type="date" id="dsbd-date-start">
        </div>
        <div class="dsbd-date-field">
          <label for="dsbd-date-end">To</label>
          <input type="date" id="dsbd-date-end">
        </div>
      </div>
      <button id="dsbd-scan-export" class="dsbd-secondary">Scan &amp; Export List (CSV)</button>
      <button id="dsbd-upload" class="dsbd-secondary">Upload CSV to Run/Resume</button>
      <input type="file" id="dsbd-csv-input" accept=".csv" style="display:none">
      <div class="dsbd-buttons">
        <button id="dsbd-startstop" class="dsbd-state-start">Start</button>
        <button id="dsbd-pauseresume" class="dsbd-state-pause" disabled>Pause</button>
      </div>
      <div class="dsbd-credit">created by Miguel Chica</div>
      <div class="dsbd-note">
        Saves as: Downloads / Docusign Rooms / Room Name / Room Name.zip
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        width: 320px;
        z-index: 2147483647;
        background: #ffffff;
        color: #1a1a1a;
        border-radius: 10px;
        border: 1px solid #e2e2e2;
        box-shadow: 0 10px 32px rgba(0,0,0,.22);
        font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
        padding: 0 16px 14px;
        font-size: 13px;
        overflow: hidden;
      }
      #${PANEL_ID} .dsbd-brandbar {
        height: 4px;
        margin: 0 -16px 12px;
        background: #ffcc22;
      }
      #${PANEL_ID} .dsbd-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .dsbd-tag {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: #ffcc22;
        color: #1a1a1a;
        font-weight: 800;
        font-size: 11px;
        letter-spacing: .3px;
      }
      #${PANEL_ID} .dsbd-title {
        font-weight: 700;
        font-size: 14.5px;
        color: #1a1a1a;
      }
      #${PANEL_ID} .dsbd-status {
        background: #f7f7f5;
        border: 1px solid #ececec;
        border-left: 3px solid #ffcc22;
        padding: 8px 10px;
        border-radius: 6px;
        min-height: 18px;
        margin-bottom: 8px;
        line-height: 1.35;
        color: #333;
      }
      #${PANEL_ID} .dsbd-progress {
        color: #6b6b6b;
        margin-bottom: 12px;
        font-weight: 600;
      }
      #${PANEL_ID} .dsbd-field-label {
        font-size: 11px;
        font-weight: 700;
        color: #6b6b6b;
        text-transform: uppercase;
        letter-spacing: .4px;
        margin-bottom: 5px;
      }
      #${PANEL_ID} .dsbd-date-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 12px;
      }
      #${PANEL_ID} .dsbd-date-field label {
        display: block;
        font-size: 10.5px;
        color: #8a8a8a;
        margin-bottom: 2px;
      }
      #${PANEL_ID} .dsbd-date-field input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #d6d6d6;
        border-radius: 6px;
        padding: 6px 7px;
        font-size: 12px;
        font-family: inherit;
        color: #1a1a1a;
        background: #fff;
      }
      #${PANEL_ID} .dsbd-date-field input:focus {
        outline: none;
        border-color: #ffcc22;
        box-shadow: 0 0 0 2px rgba(255,204,34,.35);
      }
      #${PANEL_ID} .dsbd-secondary {
        display: block;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #d6d6d6;
        border-radius: 8px;
        padding: 9px;
        cursor: pointer;
        font-weight: 700;
        background: #fff;
        color: #1a1a1a;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .dsbd-secondary:hover {
        background: #f7f7f5;
      }
      #${PANEL_ID} .dsbd-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
      }
      #${PANEL_ID} button {
        border: none;
        border-radius: 8px;
        padding: 9px;
        cursor: pointer;
        font-weight: 700;
        font-family: inherit;
      }
      #dsbd-startstop.dsbd-state-start { background: #ffcc22; color: #1a1a1a; }
      #dsbd-startstop.dsbd-state-start:hover { background: #f5c000; }
      #dsbd-startstop.dsbd-state-stop { background: #fff; color: #c0392b; border: 1px solid #e6b3ac; }
      #dsbd-startstop.dsbd-state-stop:hover { background: #fdf1ef; }
      #dsbd-pauseresume.dsbd-state-pause { background: #fff; color: #1a1a1a; border: 1px solid #d6d6d6; }
      #dsbd-pauseresume.dsbd-state-pause:hover { background: #f7f7f5; }
      #dsbd-pauseresume.dsbd-state-resume { background: #1a1a1a; color: #fff; }
      #dsbd-pauseresume.dsbd-state-resume:hover { background: #333; }
      #${PANEL_ID} button:disabled {
        opacity: .45;
        cursor: not-allowed;
      }
      #${PANEL_ID} .dsbd-credit {
        color: #b0b0b0;
        margin-top: 10px;
        font-size: 9px;
        line-height: 1;
        text-align: center;
        letter-spacing: .2px;
        text-transform: lowercase;
      }
      #${PANEL_ID} .dsbd-note {
        color: #8a8a8a;
        margin-top: 6px;
        font-size: 11px;
        line-height: 1.35;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(panel);

    const statusEl = panel.querySelector("#dsbd-status");
    const progressEl = panel.querySelector("#dsbd-progress");

    const setStatus = text => {
      statusEl.textContent = text;
    };

    // Reads and validates the panel's own From/To date inputs - replaces
    // the old hardcoded SCAN_DATE_START/SCAN_DATE_END constants in
    // scan.js, so batch size (how much date range gets scanned/queued)
    // is a per-run choice instead of a code edit.
    function readDateRange() {
      const startVal = panel.querySelector("#dsbd-date-start").value;
      const endVal = panel.querySelector("#dsbd-date-end").value;

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

    // Shared by the Start button (after a live scan) and the CSV upload
    // handler below (which skips scanning entirely) - confirms with the
    // user, then hands the room list to background.js. Pulled out once
    // this became the second caller, rather than duplicating the same
    // confirm+sendMessage flow twice. priorResults (only non-empty for a
    // resumed CSV upload) is forwarded as-is so background.js can seed
    // the new run's results/report with rooms already known to be done.
    function beginRun(rooms, confirmMessage, priorResults = []) {
      if (!rooms.length) {
        setStatus("No rooms to run - the list is empty.");
        return;
      }

      const confirmed = confirm(confirmMessage);

      if (!confirmed) {
        setStatus("Cancelled.");
        return;
      }

      setStatus(`Starting ${rooms.length} rooms...`);
      progressEl.textContent = `${priorResults.length} / ${rooms.length + priorResults.length}`;

      chrome.runtime.sendMessage({
        type: "DS_START_QUEUE",
        rooms,
        priorResults
      }, response => {
        if (!response?.ok) {
          setStatus(response?.reason || "Could not start.");
        }
      });
    }

    // Converts an uploaded CSV's parsed rows into two lists, using the
    // header row to find columns rather than assuming a fixed layout -
    // works for either CSV this extension exports:
    //   - rooms: still need processing (everything on a plain scan
    //     list, or anything not marked "Downloaded" on a download report)
    //   - priorResults: rows already marked "Downloaded" on a download
    //     report, carried over in full (not just dropped) so a resumed
    //     run's own report still shows them instead of only covering
    //     whatever gets reprocessed. This is what makes uploading a
    //     report a genuine resume rather than a blind full re-run,
    //     without needing chrome.storage.local at all (which doesn't
    //     survive a cleared profile or a different computer - a CSV
    //     file on disk does).
    function parseUploadedCsv(rows) {
      if (rows.length < 2) return { rooms: [], priorResults: [] };

      const header = rows[0];
      const nameIdx = header.indexOf("Room Name");
      const idIdx = header.indexOf("Room ID");
      const urlIdx = header.indexOf("Documents URL");
      const statusIdx = header.indexOf("Status");
      const reasonIdx = header.indexOf("Reason");
      const filenameIdx = header.indexOf("Downloaded Filename");
      const downloadIdIdx = header.indexOf("Download ID");
      const timeIdx = header.indexOf("Time");

      if (urlIdx === -1) return { rooms: [], priorResults: [] };

      const rooms = [];
      const priorResults = [];

      rows.slice(1).forEach(r => {
        const documentsUrl = r[urlIdx] || "";
        if (!documentsUrl) return;

        const roomId = idIdx === -1 ? "" : (r[idIdx] || "");
        const roomName = nameIdx === -1 ? "" : (r[nameIdx] || "");
        const status = statusIdx === -1 ? "" : (r[statusIdx] || "");

        if (status === "Downloaded") {
          priorResults.push({
            roomId,
            roomName,
            documentsUrl,
            status,
            reason: reasonIdx === -1 ? "" : (r[reasonIdx] || ""),
            downloadedFilename: filenameIdx === -1 ? "" : (r[filenameIdx] || ""),
            downloadId: downloadIdIdx === -1 ? "" : (r[downloadIdIdx] || ""),
            time: timeIdx === -1 ? "" : (r[timeIdx] || "")
          });
        } else {
          rooms.push({ roomId, roomName, documentsUrl });
        }
      });

      return { rooms, priorResults };
    }

    const csvInput = panel.querySelector("#dsbd-csv-input");

    panel.querySelector("#dsbd-upload").addEventListener("click", () => {
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
          ? `Everything in ${file.name} is already marked Downloaded - nothing to run.`
          : "No usable rooms found in that CSV. Expected a Scan List or Download Report exported by this extension.");
        return;
      }

      const priorNote = priorResults.length > 0
        ? ` (${priorResults.length} already-downloaded room${priorResults.length === 1 ? "" : "s"} preserved, not re-run)`
        : "";

      beginRun(
        rooms,
        `Found ${rooms.length} rooms to process in ${file.name}${priorNote}.\n\nThis will open worker tabs, download each room's documents, save each ZIP inside its own room folder, and create a CSV report when done. No scan needed - these rooms come straight from the file.\n\nChrome may ask you to allow multiple downloads.\n\nContinue?`,
        priorResults
      );
    });

    panel.querySelector("#dsbd-scan-export").addEventListener("click", async () => {
      const dateRange = readDateRange();
      if (!dateRange) return;

      setStatus("Auto-scrolling and collecting room links...");
      const rooms = await autoScrollAndCollectRooms(setStatus, dateRange);

      if (!rooms.length) {
        setStatus("No rooms found in the configured date range.");
        return;
      }

      setStatus(`Found ${rooms.length} rooms in range. Exporting CSV...`);

      chrome.runtime.sendMessage({
        type: "DS_EXPORT_SCAN_LIST",
        rooms
      }, response => {
        if (response?.ok) {
          setStatus(`Exported ${rooms.length} rooms to: ${response.filename}`);
        } else {
          setStatus(response?.reason || "Could not export CSV.");
        }
      });
    });

    const startStopBtn = panel.querySelector("#dsbd-startstop");
    const pauseResumeBtn = panel.querySelector("#dsbd-pauseresume");

    let isRunning = false;
    let isPaused = false;

    // Drives both toggle buttons' label/color/disabled state off the
    // background's actual STATE (called from both the live status
    // broadcast and the initial status fetch below), rather than the
    // click handlers guessing what state they're leaving the UI in -
    // keeps the buttons honest if state changes from something other
    // than a click on this exact panel instance (e.g. another tab's
    // copy of the panel, or a stop that hasn't round-tripped yet).
    function updateButtonStates(s) {
      isRunning = !!s.running;
      isPaused = !!s.paused;

      startStopBtn.textContent = isRunning ? "Stop" : "Start";
      startStopBtn.classList.toggle("dsbd-state-start", !isRunning);
      startStopBtn.classList.toggle("dsbd-state-stop", isRunning);

      pauseResumeBtn.textContent = isPaused ? "Resume" : "Pause";
      pauseResumeBtn.classList.toggle("dsbd-state-pause", !isPaused);
      pauseResumeBtn.classList.toggle("dsbd-state-resume", isPaused);
      pauseResumeBtn.disabled = !isRunning;
    }

    startStopBtn.addEventListener("click", async () => {
      if (isRunning) {
        const confirmed = confirm("Stop after the current step?");
        if (!confirmed) return;
        // .catch(): if this panel is a stale copy left over from before
        // the extension was last reloaded (a real, expected scenario -
        // reloading the extension orphans any content script still
        // injected in an already-open tab), sendMessage() rejects with
        // "Extension context invalidated" - harmless, but uncaught
        // otherwise, since this call has no callback argument to receive
        // a normal error through.
        chrome.runtime.sendMessage({ type: "DS_STOP" }).catch(() => {});
        setStatus("Stopping...");
        return;
      }

      const dateRange = readDateRange();
      if (!dateRange) return;

      setStatus("Auto-scrolling and collecting room links...");
      const rooms = await autoScrollAndCollectRooms(setStatus, dateRange);

      if (!rooms.length) {
        setStatus("No rooms found. Make sure you are on the Rooms list page.");
        return;
      }

      beginRun(
        rooms,
        `Found ${rooms.length} rooms.\n\nThis will open worker tabs, download each room's documents, save each ZIP inside its own room folder, and create a CSV report when done.\n\nChrome may ask you to allow multiple downloads.\n\nContinue?`
      );
    });

    pauseResumeBtn.addEventListener("click", () => {
      if (isPaused) {
        chrome.runtime.sendMessage({ type: "DS_RESUME" }).catch(() => {});
        setStatus("Resuming...");
      } else {
        chrome.runtime.sendMessage({ type: "DS_PAUSE" }).catch(() => {});
        setStatus("Pausing after current step...");
      }
    });

    // Multiple rooms can be active at once now (one per worker tab) -
    // s.currentRooms is an array, not the single s.currentRoom object
    // from before concurrency. Shared by both status-update sites below.
    function runningStatusText(s) {
      const rooms = s.currentRooms || [];
      if (!rooms.length) return "Running...";
      const names = rooms.map(r => r.roomName || r.roomId).join(", ");
      return `Running: ${rooms.length} active (${names})`;
    }

    chrome.runtime.onMessage.addListener(message => {
      if (!message || message.type !== "DS_BULK_STATUS") return;

      const s = message.state;
      // Just results.length (ground truth: rooms actually recorded so
      // far) - no "+1 while running" fudge. That used to try to show
      // "currently on room N" instead of "N completed," but the moment a
      // room's result gets pushed, running is still true for the rest of
      // that same loop iteration (broadcastStatus fires again during the
      // download-start wait, before the loop advances) - so the +1 was
      // firing a second time on the room that just finished, jumping the
      // counter one room ahead of reality until the next one actually
      // started. A strictly monotonic "completed" count doesn't have
      // that ambiguity; "Running: <rooms>" below already shows what's
      // currently in flight.
      progressEl.textContent = `${s.results?.length || 0} / ${s.total || 0}`;

      updateButtonStates(s);

      if (s.paused) {
        setStatus("Paused.");
      } else if (s.running) {
        setStatus(runningStatusText(s));
      } else if (s.finishedAt) {
        setStatus("Done. CSV report saved in Downloads / Docusign Rooms / _Download Reports.");
      }
    });

    chrome.runtime.sendMessage({ type: "DS_GET_STATUS" }, response => {
      const s = response?.state;
      if (!s) return;
      progressEl.textContent = `${s.results?.length || 0} / ${s.total || 0}`;
      updateButtonStates(s);
      if (s.running) setStatus(runningStatusText(s));
      else if (s.paused) setStatus("Paused.");
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || !message.type) return;

      if (message.type === "DS_PROCESS_ROOM") {
        const result = await processCurrentRoom(message);
        sendResponse(result);
      }
    })();

    return true;
  });

  // Send room page info whenever on a room page.
  if (/\/rooms\/\d+\/documents/i.test(window.location.pathname)) {
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "DS_ROOM_PAGE_INFO",
        roomId: getRoomIdFromUrl(),
        roomName: getRoomNameFromPage(),
        url: window.location.href
      }).catch(() => {});
    }, 2500);
  }

  // Show panel on Docusign Rooms pages.
  setTimeout(injectPanel, 1200);
})();
