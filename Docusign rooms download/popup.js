/**************************************************************
 * popup.js - UNUSED, kept for reference only.
 * Leftover from the original 1.0.2 toolbar popup. manifest.json no
 * longer declares action.default_popup, so this file is never loaded
 * by the extension - the floating in-page panel in content.js is the
 * only control surface. Also stale relative to the current message
 * protocol: DS_COLLECT_AND_START below has no listener anywhere in the
 * current codebase (content.js only handles DS_PROCESS_ROOM), and
 * DS_GET_STATUS's response shape here (s.index, s.currentRoom) predates
 * the multi-tab rework - background.js now reports s.results.length and
 * s.currentRooms (plural). See README.md's Version 2.0 history and
 * Project Structure table for why this was kept instead of deleted.
 **************************************************************/

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function setProgress(current, total) {
  document.getElementById("progress").textContent = `${current || 0} / ${total || 0}`;
}

async function getActiveDocusignTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("rooms.docusign.com")) {
    return null;
  }
  return tab;
}

async function refreshStatus() {
  chrome.runtime.sendMessage({ type: "DS_GET_STATUS" }, response => {
    const s = response?.state;
    if (!s) return;

    const current = Math.min((s.index || 0) + (s.running ? 1 : 0), s.total || 0);
    setProgress(current, s.total || 0);

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
}

document.getElementById("start").addEventListener("click", async () => {
  const tab = await getActiveDocusignTab();

  if (!tab) {
    setStatus("Go to the main Docusign Rooms list page first.");
    return;
  }

  setStatus("Collecting rooms from the page...");

  chrome.tabs.sendMessage(tab.id, { type: "DS_COLLECT_AND_START" }, response => {
    if (!response?.ok) {
      setStatus(response?.reason || "Could not start. Refresh the Docusign page and try again.");
      return;
    }

    setStatus(`Started ${response.total} rooms. Keep Chrome open.`);
    setProgress(0, response.total);
  });
});

document.getElementById("pause").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DS_PAUSE" });
  setStatus("Pausing after current step...");
});

document.getElementById("resume").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DS_RESUME" });
  setStatus("Resuming...");
});

document.getElementById("stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DS_STOP" });
  setStatus("Stopping after current step...");
});

refreshStatus();
setInterval(refreshStatus, 1000);
