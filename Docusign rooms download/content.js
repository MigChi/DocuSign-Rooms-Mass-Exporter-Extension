/**************************************************************
 * Docusign Rooms Bulk Downloader - content.js
 * Adds the on-page control panel, auto-scrolls/collects rooms,
 * and processes the active room Documents page.
 **************************************************************/

(function () {
  if (window.__DS_BULK_DOWNLOADER_LOADED__) return;
  window.__DS_BULK_DOWNLOADER_LOADED__ = true;

  const PANEL_ID = "ds-bulk-downloader-panel";

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

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getRoomIdFromUrl(url = window.location.href) {
    const match = String(url || "").match(/\/rooms\/(\d+)/i);
    return match ? match[1] : "";
  }

  function roomUrlToDocumentsUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      const match = parsed.pathname.match(/\/rooms\/(\d+)/i);
      if (!match) return null;
      return `${parsed.origin}/rooms/${match[1]}/documents`;
    } catch (e) {
      return null;
    }
  }

  function getRoomNameFromPage() {
    const selectors = [
      "[data-qa*='room-name']",
      "[data-qa*='room-title']",
      "h1",
      "[class*='room'][class*='title']",
      "[class*='Room'][class*='Title']",
      "[class*='title']"
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.innerText?.trim();
      if (
        text &&
        text.length > 1 &&
        !normalizeText(text).includes("documents") &&
        !normalizeText(text).includes("rooms")
      ) {
        return cleanName(text);
      }
    }

    const title = document.title
      ?.replace(/docusign/gi, "")
      ?.replace(/rooms/gi, "")
      ?.replace(/\|/g, "")
      ?.trim();

    if (title && title.length > 1) return cleanName(title);

    const roomId = getRoomIdFromUrl();
    return cleanName(`Docusign Room ${roomId}`);
  }

  function findBestScrollContainer() {
    const candidates = [...document.querySelectorAll("div, main, section, body, html")];

    let best = document.scrollingElement || document.documentElement;
    let bestScrollableAmount = 0;

    for (const el of candidates) {
      const scrollableAmount = el.scrollHeight - el.clientHeight;
      if (scrollableAmount > bestScrollableAmount) {
        bestScrollableAmount = scrollableAmount;
        best = el;
      }
    }

    return best;
  }

  function getRoomCardsAndLinks() {
    const allLinks = [...document.querySelectorAll("a[href]")];

    const rooms = allLinks
      .map(a => {
        const documentsUrl = roomUrlToDocumentsUrl(a.href);
        if (!documentsUrl) return null;

        const row =
          a.closest("[data-qa]") ||
          a.closest("article") ||
          a.closest("section") ||
          a.closest("li") ||
          a.closest("tr") ||
          a.closest("div");

        const rawText = (row?.innerText || a.innerText || "").trim();
        const firstLine = rawText.split("\n").map(x => x.trim()).filter(Boolean)[0];
        const roomId = getRoomIdFromUrl(documentsUrl);

        return {
          roomId,
          roomName: cleanName(firstLine || `Docusign Room ${roomId}`),
          documentsUrl
        };
      })
      .filter(Boolean);

    const unique = [];
    const seen = new Set();

    for (const room of rooms) {
      if (!seen.has(room.documentsUrl)) {
        seen.add(room.documentsUrl);
        unique.push(room);
      }
    }

    return unique;
  }

  async function autoScrollAndCollectRooms(updateStatus) {
    const scrollContainer = findBestScrollContainer();

    let lastCount = 0;
    let noNewRoomAttempts = 0;
    let totalScrolls = 0;

    while (noNewRoomAttempts < 7 && totalScrolls < 400) {
      const rooms = getRoomCardsAndLinks();
      const currentCount = rooms.length;

      updateStatus?.(`Loading rooms... found ${currentCount}`);

      if (currentCount > lastCount) {
        lastCount = currentCount;
        noNewRoomAttempts = 0;
      } else {
        noNewRoomAttempts++;
      }

      try {
        scrollContainer.scrollTo({
          top: scrollContainer.scrollHeight,
          behavior: "smooth"
        });
      } catch (e) {
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: "smooth"
        });
      }

      await sleep(1500);
      totalScrolls++;
    }

    return getRoomCardsAndLinks();
  }

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

  function selectAllDocuments() {
    const label = document.querySelector('[data-qa="select-all-docs-label-text"]');

    if (!label) {
      console.error("Select All label not found.");
      return false;
    }

    const row =
      label.closest("label") ||
      label.closest("[class*='select']") ||
      label.parentElement?.parentElement?.parentElement ||
      label.parentElement?.parentElement ||
      label.parentElement;

    console.log("Likely Select All row:", row);

    const clickable =
      row?.querySelector("input[type='checkbox']") ||
      row?.querySelector("[role='checkbox']") ||
      row?.querySelector("[aria-checked]") ||
      row?.querySelector("button") ||
      row;

    console.log("Clicking likely checkbox/control:", clickable);

    if (!clickable) {
      console.error("No clickable Select All control found.");
      return false;
    }

    clickable.scrollIntoView({ block: "center" });
    clickable.click();

    return true;
  }

  function findBulkDownloadButton() {
    return (
      document.querySelector('button[data-qa="Download"][data-dd-action-name="Bulk Action - Download"]') ||
      document.querySelector('button[data-qa="Download"]')
    );
  }

  function findFinalDownloadButton() {
    const buttons = [...document.querySelectorAll("button, [role='button'], a")]
      .filter(el => el.offsetParent !== null);

    return (
      buttons.find(btn => normalizeText(btn.innerText) === "download") ||
      buttons.find(btn => normalizeText(btn.innerText).includes("download"))
    );
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

  async function processCurrentRoom(message) {
    const roomId = message.roomId || getRoomIdFromUrl();
    let roomName = getRoomNameFromPage();

    chrome.runtime.sendMessage({
      type: "DS_ROOM_PAGE_INFO",
      roomId,
      roomName,
      url: window.location.href
    }).catch(() => {});

    await waitForSelector('[data-qa="select-all-docs-label-text"]', 45000);

    roomName = getRoomNameFromPage();

    const selected = selectAllDocuments();

    if (!selected) {
      return {
        ok: false,
        roomId,
        roomName,
        reason: "Select All was not found or did not click"
      };
    }

    await sleep(2500);

    const downloadButton = findBulkDownloadButton();

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

    await sleep(3500);

    const finalDownload = findFinalDownloadButton();

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
      const currentIndex = Math.min((s.index || 0) + (s.running ? 1 : 0), s.total || 0);
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
      progressEl.textContent = `${s.index || 0} / ${s.total || 0}`;
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
