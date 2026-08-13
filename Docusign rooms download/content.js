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

  // Every document row (confirmed via captured markup, 2026-08) has 6
  // columns - Checkbox, Type, Document, Owner, Added, Size, in that order -
  // and the row's own file size lives in the LAST <td>, as a bare
  // <strong>0 B</strong> / <strong>224 KB</strong> with no data-qa of its
  // own. Anchored off input[data-qa="document-checkbox"] (a real, stable
  // data-qa, same convention as everywhere else in this codebase) rather
  // than the row's own data-qa, which is just that document's numeric ID -
  // not a fixed string to match against, unlike tr[data-qa="room-list-row"]
  // on the list page. A room genuinely can contain both real documents and
  // 0-byte placeholder ones side by side (confirmed live), so this needs
  // to be checked per-document, not once for the whole room. The actual
  // 0-byte judgment is isZeroByteSizeText() (content/utils.js) - pure text
  // matching, kept there (not duplicated here) so it has real test
  // coverage; this function's only job is the DOM read.
  function getDocumentRows() {
    return [...document.querySelectorAll('input[data-qa="document-checkbox"]')].map(checkbox => {
      const row = checkbox.closest("tr");
      const label = row?.querySelector('label[data-qa="document-checkbox-label"]');
      const cells = row ? [...row.querySelectorAll("td")] : [];
      const sizeText = cells[cells.length - 1]?.textContent?.trim() || "";
      return { checkbox, label, sizeText, cellCount: cells.length, isZeroByte: isZeroByteSizeText(sizeText) };
    });
  }

  // Confirmed live (twice): clicking the native <input> directly is
  // reverted by the page every time (checked stays false) - the label and
  // input are siblings in the markup (not label-wraps-input), and the
  // app's real click handler is bound to the <label>, not the input, so a
  // click dispatched straight at the input never reaches it. label.click()
  // is confirmed working and tried first; the manually dispatched
  // MouseEvent on the checkbox remains as a fallback for any room where
  // the label isn't found. Verifies against the actual document
  // checkboxes instead of assuming success. Split out from
  // selectAllDocuments() below so the original, long-proven "click the one
  // Select All toggle" path stays completely untouched for the common case
  // (a room with no 0-byte documents).
  async function selectAllViaToggle() {
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

  // Confirmed live (reported directly): a room's Bulk Download button never
  // renders if every currently-*selected* document is 0 bytes - even when
  // the room also has real, non-empty documents sitting right alongside
  // them. The blunt Select All toggle has no way to exclude specific
  // documents, so a room with a mix of real and 0-byte files was failing
  // outright ("Bulk download button was not found") even though its real
  // documents were perfectly downloadable on their own.
  //
  // Deliberately only takes this per-document path when the room actually
  // *has* a 0-byte document at all, and only once every one of its
  // document rows is confirmed to have actually rendered (see the wait
  // loop below) - a room with no 0-byte documents, or one whose row count
  // couldn't be confirmed complete in time, behaves exactly as before,
  // through selectAllViaToggle() above, unmodified. Keeps this fix's
  // blast radius as narrow as the specific problem it addresses, rather
  // than replacing a long-proven interaction pattern for every room just
  // to cover an edge case most rooms don't have - and never risks a false
  // "genuinely nothing downloadable here" conclusion from an incomplete
  // read.
  //
  // Returns { selected, allZeroByte } rather than a plain boolean -
  // processCurrentRoom() uses allZeroByte to give a specific, honest
  // failure reason for the one case this still can't fix (every document
  // in the room is 0 bytes, so there is nothing non-zero left to select
  // and the button still won't appear) instead of the generic "not found"
  // message that case would otherwise get, indistinguishable from a real
  // page-structure problem. `documentCount` (from getDocumentCount(),
  // already read by processCurrentRoom() before calling this) is the one
  // thing that makes `allZeroByte` trustworthy - see the wait loop below.
  async function selectAllDocuments(documentCount) {
    // Guards against exactly the class of bug this project has hit before
    // with the room list (Decisions 39/40): an element existing in the DOM
    // is not the same as its own content, or its siblings, having finished
    // rendering. `[data-qa="group-name"]` being present only proves the
    // group HEADER has rendered, not that every one of its document ROWS
    // has - if getDocumentRows() ran while only some rows had painted in,
    // and those happened to all be 0-byte ones, this would wrongly report
    // "every document in this room is 0 bytes" for a room that actually
    // has real documents still loading. Polls for the row count to reach
    // documentCount (the group header's own claimed total, already
    // established as reliable - see getDocumentCount()'s own history in
    // DESIGN.md Decision 4) before trusting anything about zero-byte-ness;
    // gives up after a real, generous wait and falls back to the original,
    // always-safe Select All toggle rather than ever risking a false
    // "genuinely nothing downloadable" conclusion from a partial read.
    let rows = getDocumentRows();
    if (typeof documentCount === "number" && rows.length < documentCount) {
      const start = Date.now();
      while (rows.length < documentCount && Date.now() - start < 10000) {
        await sleep(300);
        rows = getDocumentRows();
      }
    }

    const rowsIncomplete = typeof documentCount === "number" && rows.length < documentCount;
    const hasZeroByteDoc = rows.some(r => r.isZeroByte);

    // Only logged for the cases actually worth seeing - a room with no
    // 0-byte documents (the common case) takes the untouched toggle path
    // silently, same as it always has. A per-room dump on every single
    // room in a multi-thousand-room run would otherwise be real console
    // noise for no benefit.
    if (hasZeroByteDoc || rowsIncomplete) {
      console.log(
        "[DSBD] getDocumentRows():", rows.map(r => ({ sizeText: r.sizeText, isZeroByte: r.isZeroByte })),
        "documentCount:", documentCount, "rowsIncomplete:", rowsIncomplete
      );
    }

    if (!rows.length || !hasZeroByteDoc || rowsIncomplete) {
      const selected = await selectAllViaToggle();
      return { selected, allZeroByte: false };
    }

    const nonZero = rows.filter(r => !r.isZeroByte);
    const allZeroByte = nonZero.length === 0;
    // Every document is 0 bytes - nothing gained by excluding all of them,
    // so select everything anyway (matches the pre-existing behavior for
    // this specific case) rather than selecting nothing at all.
    const targets = allZeroByte ? rows : nonZero;

    targets[0]?.checkbox?.scrollIntoView({ block: "center" });

    for (const { checkbox, label } of targets) {
      label?.click();
      if (checkbox && !checkbox.checked) {
        checkbox.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: 1
        }));
      }
    }

    await sleep(400);
    return { selected: anyDocumentChecked(), allZeroByte };
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

    const selection = await selectAllDocuments(documentCount);
    console.log("[DSBD] selectAllDocuments() succeeded:", selection.selected, "allZeroByte:", selection.allZeroByte);

    if (!selection.selected) {
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
      // A room where every document is 0 bytes is a correctly-determined
      // terminal state, not a failure - the same reasoning the empty-room
      // case above already uses. ok: true (not false) and a distinct
      // allZeroByte flag, mirroring `empty` above exactly, so
      // background.js's processRoom() can give it its own real status
      // ("Complete (All 0 Bytes)") instead of "Failed" - which matters
      // beyond just labeling: a "Failed" room gets silently retried on
      // every future CSV-upload resume forever (parseUploadedCsv() only
      // skips Downloaded/Complete rows), which would mean re-attempting
      // this exact, permanently unresolvable room every single time
      // someone re-uploads a report - a real, reported concern once this
      // fix made "the button showed up" and "the button will never show
      // up no matter what" two genuinely different, distinguishable
      // outcomes for the first time.
      if (selection.allZeroByte) {
        return {
          ok: true,
          allZeroByte: true,
          roomId,
          roomName,
          reason: "Every document in this room is 0 bytes - nothing to download"
        };
      }

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

        // Periodic aggregate progress for the panel's Activity Log -
        // "nice visual like it was for downloads," requested directly.
        // Deliberately a summary (rooms found/in-range/pages fetched so
        // far), not one entry per room - the download side's Activity Log
        // covers events like worker-tab lifecycle changes, which happen
        // at most a handful of times per run; a real per-room entry here
        // would mean tens of thousands of log lines on a large scan,
        // which is neither readable nor something a CSV export should
        // have to carry.
        const reportActivity = evt => {
          chrome.runtime.sendMessage({ type: "DS_SCAN_ACTIVITY", ...evt }).catch(() => {});
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
          const rooms = await autoScrollAndCollectRooms(reportProgress, dateRange, scanControl, reportCheckpoint, reportActivity);
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
        // room for the full room-processing bound (180s) instead of
        // failing immediately with a real reason, and do so on every
        // single room where it happens across a whole run.
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
