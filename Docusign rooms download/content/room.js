/**************************************************************
 * content/room.js
 * Room-PAGE concerns - logic that only makes sense once you're actually
 * on one room's /documents page, as opposed to content/scan.js which
 * only makes sense on the list page.
 *
 * Currently just getRoomNameFromPage(). The other room-page functions
 * (clickElement, selectAllDocuments, getDocumentCount, waitForSelector,
 * processCurrentRoom) still live in content.js rather than here - they
 * could move into this file for consistency, but that's a pure
 * reorganization with no functional benefit, so it's been left alone
 * (per README.md's Status section, this project is in its final state -
 * there's no remaining roadmap this deferral is trading against).
 *
 * Depends on content/utils.js (cleanName, getRoomIdFromUrl) -
 * manifest.json must load utils.js first.
 **************************************************************/

/**
 * Read the room name from the CURRENT page - only meaningful on an
 * individual room's /documents page, not the list page. Called by
 * content.js's processCurrentRoom() and by the "send room page info"
 * block at the bottom of content.js (both still live in content.js
 * until Phase 2 moves them here too).
 */
function getRoomNameFromPage() {
    const nameEl = document.querySelector('strong[data-qa="room-name"]');
    const text = nameEl?.textContent?.trim();

    if (text) return cleanName(text);

    const roomId = getRoomIdFromUrl();
    return cleanName(`Docusign Room ${roomId}`);
}