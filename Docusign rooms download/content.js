/**************************************************************
 * Docusign Rooms Mass Exporter - content.js
 * Runs the actual DOM automation on a Docusign Rooms page: scanning the
 * room list (relayed from the standalone panel window - see panel.js and
 * DESIGN.md) and processing one room's Documents page (relayed from
 * background.js, per-worker, during a download run).
 *
 * Used to also inject and run the floating control panel directly into
 * this page. Moved out into panel.html/panel.js, a standalone extension
 * window opened via the toolbar icon - an in-page panel died on every
 * refresh and only ever existed on the one tab it was injected into,
 * which made it hard to use during a long scan or run. This file no
 * longer has any UI of its own; it exists purely to do DOM work a
 * detached window structurally cannot do itself.
 **************************************************************/

(function () {
  if (window.__DS_MASS_EXPORTER_LOADED__) return;
  window.__DS_MASS_EXPORTER_LOADED__ = true;

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
      // ok: true (nothing went wrong - correctly determined there's
      // nothing to download) plus a distinct `empty: true` flag, not just
      // ok: true alone - background.js's processRoom() uses `empty` to
      // both give this a distinct "Complete (Empty)" status (instead of
      // "Failed", so re-uploading a report to resume doesn't re-visit
      // rooms already confirmed empty) and to skip its post-click
      // waitForDownloadStart() wait, which would otherwise burn up to 15s
      // waiting for a download that can never start.
      return {
        ok: true,
        empty: true,
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

  // Non-null exactly while a scan (autoScrollAndCollectRooms) is
  // in-flight in this tab. Client-side only, never sent to background.js
  // as-is - only its .stopped/.paused flags matter, toggled by the
  // DS_SCAN_STOP/PAUSE/RESUME messages below, which are themselves
  // relayed from the standalone panel window via background.js (see
  // DESIGN.md - the panel has no DOM access of its own to run a scan or
  // control one directly).
  let scanControl = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "DS_BEGIN_SCAN") {
      // Acknowledge that the scan *started* immediately, synchronously -
      // the actual result arrives later via DS_SCAN_COMPLETE below, since
      // a scan across thousands of rooms can run for several minutes and
      // there's no reason to hold this message channel open that whole
      // time when a follow-up message works just as well (the same
      // reasoning background.js's DS_RUN_SCAN handler documents).
      sendResponse({ ok: true });

      (async () => {
        scanControl = { stopped: false, paused: false };

        const reportProgress = text => {
          chrome.runtime.sendMessage({ type: "DS_SCAN_PROGRESS", text }).catch(() => {});
        };

        // Lets background.js save real progress to a checkpoint CSV during
        // a long scan - added alongside content/scan.js's DOM-trimming fix
        // for a real tab crash on a large account, raised at the same time
        // as this exact question: "is there a way to actively write a file
        // while rooms are being scanned?" A crash or interruption now loses
        // at most one checkpoint interval's worth of progress, not
        // everything back to the start of the scan.
        const reportCheckpoint = rooms => {
          chrome.runtime.sendMessage({ type: "DS_SCAN_CHECKPOINT", rooms }).catch(() => {});
        };

        // Re-wrapped in `new Date(...)` defensively rather than trusted
        // as-is - structured clone (what chrome.runtime/tabs.sendMessage
        // use) preserves real Date objects across a message hop, and this
        // message has already survived two (panel.js -> background.js ->
        // here), but `new Date(aRealDate)` and `new Date(anIsoString)`
        // both produce the same correct result either way, so there's no
        // reason to bet the scan on that assumption holding precisely.
        const dateRange = {
          start: new Date(message.dateRange.start),
          end: new Date(message.dateRange.end)
        };

        // Confirmed directly (same class of bug as background.js's
        // STATE.running/STATE.scanning stuck-forever fixes) that an
        // uncaught throw anywhere inside autoScrollAndCollectRooms() - an
        // unexpected page-structure change, a DOM call failing in a way
        // this code didn't anticipate - would otherwise skip straight past
        // the DS_SCAN_COMPLETE send below with no error and no signal at
        // all. background.js's STATE.scanning would stay stuck `true`
        // forever (nothing else resets it once a scan has actually
        // started), and the panel would just sit frozen on its last
        // progress line, looking exactly like a scan that silently died.
        // Reported as a real failure instead of pretending nothing
        // happened - background.js's DS_SCAN_COMPLETE handler checks
        // `message.error` and forwards it as DS_SCAN_FAILED, the same path
        // already used when the scan tab gets closed mid-scan.
        try {
          const rooms = await autoScrollAndCollectRooms(reportProgress, dateRange, scanControl, reportCheckpoint);
          chrome.runtime.sendMessage({ type: "DS_SCAN_COMPLETE", rooms }).catch(() => {});
        } catch (error) {
          chrome.runtime.sendMessage({
            type: "DS_SCAN_COMPLETE",
            rooms: [],
            error: String(error?.message || error)
          }).catch(() => {});
        } finally {
          scanControl = null;
        }
      })();

      return;
    }

    if (message.type === "DS_SCAN_STOP") {
      if (scanControl) scanControl.stopped = true;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "DS_SCAN_PAUSE" || message.type === "DS_SCAN_RESUME") {
      if (scanControl) scanControl.paused = message.type === "DS_SCAN_PAUSE";
      sendResponse({ ok: true });
      return;
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || !message.type) return;

      if (message.type === "DS_PROCESS_ROOM") {
        // Same class of gap as DS_BEGIN_SCAN above, and higher-stakes here:
        // an uncaught throw inside processCurrentRoom() would skip
        // sendResponse() entirely, and background.js's own
        // chrome.tabs.sendMessage() call has no way to tell "never going to
        // respond" apart from "still legitimately working" except a
        // timeout (see withTimeout() there) - without this try/catch, one
        // room hitting an unexpected DOM issue would silently stall that
        // room for a full 90s instead of failing immediately with a real
        // reason, and do so on every single room where it happens across a
        // whole run.
        try {
          const result = await processCurrentRoom(message);
          sendResponse(result);
        } catch (error) {
          sendResponse({
            ok: false,
            roomId: message.roomId,
            reason: `Unexpected error while processing this room: ${error?.message || error}`
          });
        }
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
})();
