/**************************************************************
 * Docusign Rooms Bulk Downloader - content.js
 * Adds the on-page control panel, auto-scrolls/collects rooms,
 * and processes the active room Documents page.
 **************************************************************/

(function () {
  if (window.__DS_BULK_DOWNLOADER_LOADED__) return;
  window.__DS_BULK_DOWNLOADER_LOADED__ = true;

  const PANEL_ID = "ds-bulk-downloader-panel";

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
      <div class="dsbd-title">Docusign Bulk Downloader</div>
      <div class="dsbd-status" id="dsbd-status">Ready</div>
      <div class="dsbd-progress" id="dsbd-progress">0 / 0</div>
      <button id="dsbd-scan-export" class="dsbd-secondary">Scan &amp; Export List (CSV)</button>
      <div class="dsbd-buttons">
        <button id="dsbd-start">Start</button>
        <button id="dsbd-pause">Pause</button>
        <button id="dsbd-resume">Resume</button>
        <button id="dsbd-stop">Stop</button>
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
        width: 310px;
        z-index: 2147483647;
        background: #111;
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.35);
        font-family: Arial, sans-serif;
        padding: 14px;
        font-size: 13px;
      }
      #${PANEL_ID} .dsbd-title {
        font-weight: 800;
        font-size: 15px;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .dsbd-status {
        background: #222;
        padding: 8px;
        border-radius: 8px;
        min-height: 18px;
        margin-bottom: 8px;
        line-height: 1.3;
      }
      #${PANEL_ID} .dsbd-progress {
        color: #ddd;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .dsbd-secondary {
        display: block;
        width: 100%;
        border: none;
        border-radius: 8px;
        padding: 9px;
        cursor: pointer;
        font-weight: 700;
        background: #333;
        color: #fff;
        margin-bottom: 7px;
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
      }
      #dsbd-start { background: #b00020; color: #fff; }
      #dsbd-pause { background: #f5a623; color: #111; }
      #dsbd-resume { background: #0a7; color: #fff; }
      #dsbd-stop { background: #555; color: #fff; }
      #${PANEL_ID} .dsbd-credit {
        color: #888;
        margin-top: 6px;
        font-size: 9px;
        line-height: 1;
        text-align: center;
        letter-spacing: .2px;
        text-transform: lowercase;
      }
      #${PANEL_ID} .dsbd-note {
        color: #bbb;
        margin-top: 9px;
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

    panel.querySelector("#dsbd-scan-export").addEventListener("click", async () => {
      setStatus("Auto-scrolling and collecting room links...");
      const rooms = await autoScrollAndCollectRooms(setStatus);

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

    panel.querySelector("#dsbd-start").addEventListener("click", async () => {
      setStatus("Auto-scrolling and collecting room links...");
      const rooms = await autoScrollAndCollectRooms(setStatus);

      if (!rooms.length) {
        setStatus("No rooms found. Make sure you are on the Rooms list page.");
        return;
      }

      const confirmed = confirm(
        `Found ${rooms.length} rooms.\n\nThis will open a worker tab, download each room's documents, save each ZIP inside its own room folder, and create a CSV report when done.\n\nChrome may ask you to allow multiple downloads.\n\nContinue?`
      );

      if (!confirmed) {
        setStatus("Cancelled.");
        return;
      }

      setStatus(`Starting ${rooms.length} rooms...`);
      progressEl.textContent = `0 / ${rooms.length}`;

      chrome.runtime.sendMessage({
        type: "DS_START_QUEUE",
        rooms
      }, response => {
        if (!response?.ok) {
          setStatus(response?.reason || "Could not start.");
        }
      });
    });

    panel.querySelector("#dsbd-pause").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DS_PAUSE" });
      setStatus("Pausing after current step...");
    });

    panel.querySelector("#dsbd-resume").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DS_RESUME" });
      setStatus("Resuming...");
    });

    panel.querySelector("#dsbd-stop").addEventListener("click", () => {
      const confirmed = confirm("Stop after the current step?");
      if (!confirmed) return;
      chrome.runtime.sendMessage({ type: "DS_STOP" });
      setStatus("Stopping...");
    });

    chrome.runtime.onMessage.addListener(message => {
      if (!message || message.type !== "DS_BULK_STATUS") return;

      const s = message.state;
      // Uses results.length (ground truth: rooms actually recorded so
      // far), not the raw loop index - a Stop mid-room exits via `break`,
      // which skips the for-loop's own increment, so the index alone
      // undercounts by one in that case even though the room's result
      // was already pushed.
      const completed = s.results?.length || 0;
      const currentIndex = Math.min(completed + (s.running ? 1 : 0), s.total || 0);
      progressEl.textContent = `${currentIndex} / ${s.total || 0}`;

      if (s.paused) {
        setStatus("Paused.");
      } else if (s.running && s.currentRoom) {
        setStatus(`Running: ${s.currentRoom.roomName || s.currentRoom.roomId}`);
      } else if (s.finishedAt) {
        setStatus("Done. CSV report saved in Downloads / Docusign Rooms / _Download Reports.");
      } else if (s.running) {
        setStatus("Running...");
      }
    });

    chrome.runtime.sendMessage({ type: "DS_GET_STATUS" }, response => {
      const s = response?.state;
      if (!s) return;
      progressEl.textContent = `${s.results?.length || 0} / ${s.total || 0}`;
      if (s.running && s.currentRoom) setStatus(`Running: ${s.currentRoom.roomName || s.currentRoom.roomId}`);
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
