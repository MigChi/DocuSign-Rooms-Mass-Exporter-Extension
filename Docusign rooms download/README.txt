# Docusign Rooms Bulk Downloader

This Chrome extension bulk-downloads Docusign Rooms documents by automating the same manual process:
Room Documents page → Select All → Download → ZIP.

## What it does

- Auto-scrolls the Docusign Rooms list page to load all rooms.
- Collects room links.
- Opens one worker tab.
- Goes directly to each room's `/documents` page.
- Clicks Select All using the working selector:
  `[data-qa="select-all-docs-label-text"]`
- Clicks the bulk download button:
  `button[data-qa="Download"][data-dd-action-name="Bulk Action - Download"]`
- Saves every ZIP inside a folder:
  `Downloads/Docusign Rooms/Room Name/Room Name.zip`
- Creates a CSV report after it finishes:
  `Downloads/Docusign Rooms/_Download Reports/Docusign Rooms Download Report <timestamp>.csv`
- Includes Start, Pause, Resume, and Stop buttons.

## Install

1. Unzip this folder.
2. Go to `chrome://extensions`.
3. Turn on Developer Mode.
4. Click Load unpacked.
5. Select the unzipped folder.

## Use

1. Go to the main Docusign Rooms list page.
2. Let the page load.
3. Use the floating Docusign Bulk Downloader panel at the bottom-right.
4. Click Start.
5. If Chrome asks to allow multiple downloads, click Allow.

## Notes

Chrome page scripts cannot rename Docusign downloads by themselves. This extension uses the Chrome Downloads API to put each room download in its own folder and rename the ZIP.


Tiny credit line below the control buttons: created by Miguel Chica

Versions 1.0.x (original release, through the popup feature) were created
by jannelthetech. Version 2.0 onward is a substantial rewrite and
reorganization by Miguel Chica, built on top of that original extension.


## Version 1.0.2 (original release, by jannelthetech)

Clicking the Chrome extension icon now opens a popup with Start, Pause, Resume, and Stop controls.

If the popup says it cannot start:
1. Open the main Docusign Rooms list page.
2. Refresh the Docusign page.
3. Click the extension icon again.
4. Click Start.


## Version 2.0 (current - rewrite by Miguel Chica)

A major reorganization and rewrite of the extension, aimed at making bulk
exports practical at 10,000+ rooms instead of a few dozen. Full reasoning
behind every design decision below is documented in `DESIGN.md`.

Done so far:
- Removed the toolbar popup (Start/Pause/Resume/Stop) added in 1.0.2. Its
  Start button sent a message (`DS_COLLECT_AND_START`) that content.js
  never actually listened for, so clicking Start from the popup always
  failed with "Could not start." The floating in-page panel was the only
  control surface that ever worked correctly, so it's now the only one.
  `manifest.json` no longer declares `action.default_popup`; `popup.html`
  / `popup.js` remain in the folder but are unused.

Planned (in progress):
- Date-range filtering during the scan (skip/collect/stop), so only rooms
  in a chosen date window are scanned and queued at all.
- Save the scanned room list to disk (CSV) and reload it later, so a scan
  never has to be repeated once it's been done.
- A shared work queue with multiple worker tabs claiming rooms
  concurrently, instead of one tab processing rooms one at a time.
- Persisted progress (via chrome.storage.local) so a run can resume after
  a browser restart, a killed extension service worker, or a long pause -
  not just a manual pause/resume within one session.
- Per-room status tracking through its full lifecycle (queued, in
  progress, done, failed, empty) shown live in the panel, per worker tab.
- Real event-based waits (Chrome's download-started event, short polling
  for UI state) replacing fixed delays, cutting dead time per room.
- A suggested worker-tab count based on measured average time-per-room,
  within safe min/max bounds.

See `DESIGN.md` for the full reasoning behind each of these decisions,
including alternatives that were considered and rejected along the way.
