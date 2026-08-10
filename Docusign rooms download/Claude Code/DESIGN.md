# DocuSign Rooms Bulk Downloader — Architecture & Design Case Study

## Overview

A Chrome extension (Manifest V3) that bulk-exports documents from a DocuSign Rooms account to a local folder structure — one folder per room, containing that room's documents. The project started as a small working extension and was redesigned to reliably handle **10,000+ rooms**, a scale where naive approaches (single-tab, fixed delays, no persistence) become impractical — the original design projected to **55-70 hours** of runtime.

This document walks through the problem in the order it was actually solved: what each step addressed, which options were considered, why the chosen option won, and where an earlier decision was later reversed as new requirements surfaced.

---

## Starting Point: Auditing the Existing Extension

The original extension used a single worker tab, processed rooms strictly sequentially, and relied on fixed `sleep()` delays (~11.5 seconds of pure dead time per room, not counting page load) to wait for DOM state to settle before clicking the next button. Its download-renaming trick — intercepting `chrome.downloads.onDeterminingFilename` to route each ZIP into `Docusign Rooms/<Room Name>/<Room Name>.zip` — was sound, but it depended on tracking exactly **one** active room globally, which meant the whole design could never be parallelized without a rework.

Doing the math on 10,000 rooms against that sequential design (~20-25s/room including page load) put the runtime at 55-70 hours — the actual number that motivated everything below.

---

## Decision 1: Official API vs. Continued Browser Automation

**Problem:** Is there a faster way to get this data than clicking through the UI at all?

**Option considered:** DocuSign's real Rooms REST API (`GetRooms`, `GetDocuments`, per-document `base64Contents` retrieval — verified directly against DocuSign's published OpenAPI spec, not assumed from memory). This would return individual files per room (a good match for "one folder per room," no unzipping needed) and remove browser automation entirely.

**Why it was attractive:** no scrolling, no clicking, no DOM fragility, real pagination and filtering, dramatically faster in principle.

**The blocker:** creating the OAuth credentials (an "Integration Key") required for API access sits behind DocuSign's **Account Administrator** permission — a different privilege tier from being able to use the Rooms product day-to-day. Verified in practice: attempting to reach `admin.docusign.com` produced a sign-in loop rather than a dashboard, confirming no admin rights on the account, and no admin was readily reachable.

**Decision:** abandon the API path for now and invest in making browser automation itself fast, resilient, and observable. This is a real-world instance of **a technically superior solution being inaccessible due to organizational/permission constraints** — the right engineering response is to redesign within the actual constraints, not to look for a workaround around an access-control boundary.

---

## Decision 2: Parallelism Model — Work Queue, Not Divide-and-Conquer

**Problem:** how do multiple browser tabs process 10,000 independent rooms faster than one tab?

**Option initially proposed:** a binary-tree / divide-and-conquer split — two tabs start at the middle of the list, each spawning further splits.

**Why it doesn't fit:** divide-and-conquer earns its complexity reduction from a *recursive subproblem structure with a combine step* (mergesort's split + merge). Downloading room #4,317 has no relationship to room #8,921 and produces no result that needs combining — each room is an independent, variable-cost task. That's the definition of an **embarrassingly parallel** workload, not a divide-and-conquer one.

**Why a shared work queue wins concretely:** with a static split (e.g., two tabs, 5,000 rooms each), if one tab's half happens to contain heavier rooms, that tab runs long while the other sits idle after finishing early — total time is bounded by the *slowest* partition, not the average. A shared queue where any free worker claims the next unclaimed item guarantees no worker is ever idle while work remains; total time approaches `total_work / N`, the theoretical best case for N workers. This dominates static partitioning whenever task duration is variable, which it is here (rooms differ wildly in document count).

**Decision:** one shared queue (an array + a pointer) with a pool of N tabs each claiming work greedily — the classic **producer-consumer / bag-of-tasks** pattern.

---

## Decision 3: Concurrency Safety Without Explicit Locks

**Problem:** multiple tabs claiming from one shared queue is a textbook shared-resource race condition. How is that avoided without a mutex?

**Key insight:** a Chrome extension's background service worker is **single-threaded**, and Chrome serializes all incoming `chrome.runtime.sendMessage` calls through its `onMessage` dispatcher — no two tabs' messages are ever processed truly simultaneously. Additionally, tabs are separate execution contexts with no shared memory at all — the queue can *only* live in the one place that's inherently single-threaded. The "lock" is structural, not something that has to be built.

**The one way to reintroduce the race:** an `await` between reading the queue pointer and advancing it creates a gap where JS can switch to a different tab's claim request mid-operation, letting two tabs read the same pointer value before either increments it.

**Decision:** the claim function must read-and-increment the queue pointer as a single synchronous operation with zero `await` inside it. Everything expensive (navigation, clicking, waiting for a download) happens *after* the claim, fully in parallel across tabs — only the trivial, fast part needs to be a protected critical section.

---

## Decision 4: Scope Reduction via Date-Range Filtering

**Problem:** not all 10,000 rooms are needed — only a target date range. Filtering during the scan can save both scan time (stop scrolling early) and total processing time (fewer rooms queued).

**A key sub-question that shaped the design:** can "is this room empty" be determined for free (e.g., a visible document count on the room card), or does it require opening the room (the same cost as processing it)? Confirmed: not free. This ruled out an upfront "filter out empty rooms" pass entirely — that check was pushed into the per-room worker logic instead (see Decision 7), where a short, targeted timeout distinguishes "nothing to select" from a real failure, without wasting a full processing cycle on it.

**DOM verification (not assumed):** inspected the actual rendered room list and found a real `<table>` structure with explicit `data-qa` attributes (`room-list-row`, `room-name` with a `title` attribute holding the untruncated name, `room-date`) — far more reliable than the original code's generic link-scraping-plus-DOM-climbing fallback chain.

**Decision:** sort the list oldest-first, then apply a three-way branch while scrolling — skip (before range), collect (inside range), stop entirely (past range, since the list is sorted, everything after is guaranteed out of range too) — with a small consecutive-miss buffer before actually stopping, to tolerate any lazy-load ordering noise.

**Correction (later, once real per-room markup was captured):** "confirmed: not free" was correct for the *scan* phase — the list page genuinely has no per-room document count visible without opening each room. It does not hold for the *processing* phase. Once a room's Documents page is actually open (which the pipeline does for every queued room regardless), `[data-qa="group-name"]` renders its document count directly in text — `"Room Docs (0)"` for an empty room, `"Room Docs (11)"` for a room with 11 documents — present whether the room is empty or not. The original per-room code never checked this; it wasted a full 45-second timeout waiting for the Select All checkbox on every empty room, since that checkbox never renders at all when there's nothing to select. Fixed in `processCurrentRoom()`: wait on `group-name` instead (present in both states) and short-circuit immediately if the parsed count is `0`, before ever attempting Select All. Open caveat, not yet verified either way: this reads only the *first* `group-name` element on the page; a room with multiple document folders/groups would need the counts summed, and no multi-folder room has been inspected yet to confirm whether that's a real scenario in this account.

**Critical correction, this decision's central assumption was unverified until now:** the entire skip/collect/stop algorithm above depends on the list being sorted oldest-first. That was never actually enforced or checked at runtime — only assumed, based on one earlier snapshot that happened to show `"Created (Oldest)"` selected. A later markup capture of the same list showed the sort dropdown reading **`"Created (Newest)"`** instead, with rooms rendering newest-to-oldest. Under that ordering, the "stop once several rooms are found past `SCAN_DATE_END`" logic breaks completely: with `SCAN_DATE_END` far in the past relative to real (2026-dated) rooms, *every* room on initial page load is already "past the end date," tripping the stop condition on the very first tick, before scrolling even once — a silent, empty-result failure, not a crash. Since the sort direction is apparently not a fixed account property (it differed between two observed sessions), it cannot be assumed at all — it has to be checked every time. Fixed with a new `getSortLabel()` function reading `[data-qa="filter-sort-drop-down-button"] span[title]`, called at the top of `autoScrollAndCollectRooms()`: if it doesn't read exactly `"Created (Oldest)"`, the function stops immediately, reports the problem through `updateStatus`, and returns an empty array rather than proceeding on a false assumption. This is the same honesty principle applied earlier to empty-room detection ("likely empty" instead of a confident wrong assertion) — a loud, clear failure instead of a silent wrong one.

---

## Decision 5: Batch Scan-Then-Process vs. Streaming (a reversed decision)

**Initial idea:** overlap scanning and downloading — start feeding the queue as rooms are discovered, rather than waiting for the full scroll to finish, to reclaim the scan phase's wall-clock time.

**Why it was reversed:** once "resume after a long pause or crash" became a hard requirement, the streaming approach exposed a correctness problem — the Rooms list is *live* data, and if it's sorted by recent activity, any activity during a partial scan can reorder rooms underneath an in-progress scan, making "diff against a partial checkpoint" unreliable. Meanwhile, the time saved by overlapping (scanning is minutes; processing is hours) was a small fraction of total runtime.

**Decision:** scan once, in full, and save the result as a fixed, immutable list before any processing begins. Resumability is then trivial — track completed indices against a list that never changes — instead of needing reconciliation logic against a moving target. This is a case of **choosing correctness and simplicity over a marginal performance gain**, once the real requirements were fully known.

---

## Decision 6: Persistence & the MV3 Service Worker Lifecycle

**Problem discovered, not assumed upfront:** Manifest V3 background service workers are deliberately ephemeral — Chrome can terminate and restart them independent of any user action, resetting all in-memory state. This isn't a rare edge case for a job running many hours; it's close to guaranteed to happen at least once.

**Decision:** persist the scanned room list (once), the results/status per room (incrementally), and the queue position to `chrome.storage.local` — not just at the end, but as the run progresses — and have the service worker check for an in-progress job on startup before assuming a fresh run.

---

## Decision 7: Replacing Fixed Delays with Real Signals

**Problem:** the original ~11.5 seconds of fixed sleeps per room were pure guesswork, and guesswork scales badly across 10,000 iterations.

**Insight:** `chrome.downloads.onDeterminingFilename` (already used for the folder-renaming trick) fires the moment Chrome registers a new download — a real, already-available signal for "this room's download has started," rather than something to guess at with a timer. Navigating the tab away immediately after is safe, because Chrome's download manager operates independently of the originating tab once a download is underway — an assumption the *original* single-tab design already depended on implicitly.

**Two distinct wait categories identified:**
- Page becoming interactive after navigation — legitimately network-bound, needs a long timeout.
- A button appearing after a client-side click (e.g., the download button appearing after Select All) — a fast UI reaction, not a network wait, and doubles as the fast signal for "this room has nothing to select" if it *doesn't* appear quickly.

**Decision:** replace every fixed sleep with either a real event (with a timeout fallback, so a genuine failure doesn't hang a worker forever) or a short poll sized to what's actually being waited for.

---

## Decision 8: Adaptive Concurrency — A Feedback Loop, Not a Formula

**Problem:** how many parallel tabs should run, and can that number be suggested automatically?

**Key realization:** average time-per-room can't be known before any rooms have actually completed — it depends on document counts, server load, and network conditions, none of which are predictable from the room count alone. This ruled out a one-shot calculation.

**Decision:** start conservative, measure real completion times from the first batch of processed rooms (made materially more accurate by Decision 7 removing artificial delay from that measurement), and use the *measured* rate to project remaining time and suggest — not silently apply — a concurrency change within fixed min/max bounds. The bounds themselves are set by practical limits (memory/CPU, avoiding load patterns that look like abuse to DocuSign's servers), not derived mathematically.

---

## Decision 9: Code Organization — Why Not OOP

**Instinct considered:** convert the growing codebase to class-based OOP for better separation of concerns.

**The concrete, mechanical reason against it:** background.js, each tab's content.js instance, and the panel UI are separate JS realms connected only by `chrome.runtime.sendMessage`, which serializes all data through JSON — stripping any class instance down to a plain object with no methods on the receiving end. A class meant to represent "a worker and its behavior" can't actually span the boundary where the interesting behavior happens, because the platform itself cuts that object in half on every message. Additionally, the design has exactly one queue and one shared state object — OOP's main value (many independent instances with encapsulated state) doesn't apply to a singleton.

**Decision:** organize by splitting into focused files by concern (scan/filter logic, queue/claim logic, persistence, filename routing) using real ES modules in the MV3 service worker (`"type": "module"`, no bundler needed) and multiple shared-scope content script files — solving the actual "keep functions separated" need without fighting the platform's message-passing model.

---

## Final Build Plan (Deliberately Risk-Ordered)

Rather than building all of the above simultaneously, the plan builds and tests in increasing order of risk, so a bug is always isolated to the one new layer just added:

1. **Scanning + filtering + list export**, tested alone — no download logic touched yet.
2. **Single-tab processing with event-driven waits** replacing fixed sleeps — verify speed and correct empty-room detection before adding concurrency.
3. **Full per-room lifecycle status + panel UI** (queued → in progress → done/failed/empty), still single tab.
4. **Persistence and resume**, tested by deliberately killing/reloading the extension mid-run.
5. **The worker-tab pool** (claim-based queue, per-tab filename routing) — introduced last, once everything underneath it is proven solid on one tab.
6. **Min/max bounds + adaptive concurrency suggestion**, which depends on real timing data from step 5.

A small, narrow-date-range dry run (a few dozen rooms) is run through the entire pipeline before trusting it against the full 10,000-room set.

---

## Build Step 1 In Progress: Scanning + Filtering + List Export

The plan above is being executed in order; this section tracks Step 1's actual implementation decisions as they happen, separately from the pre-implementation planning above.

### Decision 10: Splitting content.js by Dependency, Not by File History

**Problem:** `content.js` originally held every scan/scroll/utility/room-page function in one file behind a single IIFE. Once real logic (date filtering, later a worker-tab pool) started landing, that made it hard to see which functions were actually related to which concern.

**Constraint carried over from the planning phase:** content scripts aren't real ES modules — every file listed in `manifest.json`'s `content_scripts` array shares one execution scope, in load order. No IIFE wrapper per file (it would hide top-level declarations from the other files); the only thing enforcing correctness is getting the array order right.

**Decision:** three files, grouped by actual call relationships rather than by where the code originally sat in the single file:
- `content/utils.js` — generic string/URL helpers with no DOM/page context (`sleep`, `cleanName`, `normalizeText`, `getRoomIdFromUrl`, `roomUrlToDocumentsUrl`). The deciding signal for what belongs here: functions called from *more than one* of the other groups (`normalizeText` and `cleanName` are each used by both the scan flow and the room-page flow) — a shared dependency shouldn't be owned by either consumer.
- `content/scan.js` — the Rooms-*list*-page flow: `getScrollContainer`, `getRoomCardsAndLinks`, `autoScrollAndCollectRooms`.
- `content/room.js` — Rooms-*page* concerns, currently just `getRoomNameFromPage`. Named ahead of need: Build Step 2 moves `clickElement`, `selectAllDocuments`, `findBulkDownloadButton`, `findFinalDownloadButton`, `waitForSelector`, and `processCurrentRoom` out of `content.js` into this same file later, since they're the same category of concern — avoids a rename/re-split later for one function that would otherwise sit alone.

Load order requirement: `utils.js` must load before `scan.js` and `room.js` (both depend on it); those two don't depend on each other, so their relative order doesn't matter; `content.js` still loads last.

### Decision 11: Replacing Two DOM Heuristics with DevTools-Confirmed Behavior

**Problem:** two functions in the original code (`getRoomCardsAndLinks` and `findBestScrollContainer`) were built on *guesses about DOM shape* rather than confirmed structure — the same category of fragility already flagged conceptually in Decision 4, now actually being resolved during implementation.

**`getRoomCardsAndLinks`:** the original climbed up from any `a[href]` via `.closest()` through a fallback chain of ancestor types and guessed the room name from the first line of the row's rendered text. Verified against the live page's actual markup instead: a real `<table>` with explicit `data-qa` attributes — `tr[data-qa="room-list-row"]` for each row, `strong[data-qa="room-name"]` (its `title` attribute holds the untruncated name; the extension previously risked failing on CSS-truncated names by reading rendered text instead), and `strong[data-qa="room-date"]`. Rewritten to query these directly. This also adds a `createdDate` field to each room record, which the still-pending date-range filter (Decision 4) depends on.

**`findBestScrollContainer`:** the original queried every `div`, `main`, `section`, `body`, and `html` on the page and picked whichever had the largest `scrollHeight - clientHeight`, on the theory that the room list was probably "the tallest scrollable thing." Verified instead of assumed: selected the Rooms-list container and the table's wrapper in DevTools and ran `getComputedStyle(el).overflowY` against each, plus `document.documentElement` and `document.body` directly. All four returned `"visible"` — confirming this page has **no internally-scrolling wrapper at all**; it's plain document/page scrolling. Replaced the entire heuristic with a one-line `getScrollContainer()` returning `document.scrollingElement || document.documentElement`, and removed the `try/catch` fallback around the scroll call in `autoScrollAndCollectRooms` — it existed only to hedge against the old heuristic possibly returning an element without a working `.scrollTo`, which is no longer a reachable failure mode now that the returned element is guaranteed to be the document's own scrolling element.

**Caveat recorded deliberately, not glossed over:** this is confirmed for the current page rendering at the row counts tested. If DocuSign later switches to a virtualized/windowed list for very long lists (rendering only on-screen rows inside a scrolling wrapper, a common technique at this kind of scale), this assumption would need re-verifying — the symptom to watch for is the scanned room count plateauing while more rooms are known to exist.

**Status (superseded below):** at this point Step 1 had the file split and the selector/scroll fixes in place, with the date-range logic, CSV export, and manifest wiring still outstanding. The date-range skip/collect/stop logic (Decision 4's design) was subsequently implemented by hand — including catching and fixing a real bug during review, where the streak counter was tripping on rooms that were merely too *early* rather than only rooms past the end date, which would have silently returned zero results on any account whose earliest rooms predate the configured start date.

### Decision 12: Closing Out Build Step 1 Under Time Pressure — CSV Export, Manifest Wiring

**Problem:** with a real deadline approaching, finishing the remaining Build Step 1 items by hand (CSV export of the scanned list, the manifest fix) would cost more time than was available, but abandoning the guided, human-typed approach silently would misrepresent how the codebase was actually built (see the process note below).

**Decision:** made explicitly, not by default — asked directly which of three modes to use (AI writes it, a boilerplate/logic hybrid split, or continuing fully guided at a faster pace) and went with full AI implementation for the remainder of Build Step 1, under human review, given the time constraint. This is recorded as a decision with a real tradeoff, not a neutral implementation detail.

**What this covered:**
- Fixed a bug introduced while manually wiring `manifest.json`'s `content_scripts` array by hand: the paths were written as `"utils.js"`, `"scan.js"`, `"room.js"` instead of `"content/utils.js"`, `"content/scan.js"`, `"content/room.js"` — the files live in the `content/` subfolder, so Chrome would have failed to load them.
- Added CSV export for the scanned/filtered room list. Content scripts have no access to `chrome.downloads` (confirmed in Decision 4's era of planning) — only the background service worker does — so this required a new message type, `DS_EXPORT_SCAN_LIST`, sent from `content.js` to `background.js`, which builds the CSV (reusing the existing `csvEscape`/`nowStamp` helpers already used by `createReport()`) and saves it to `Docusign Rooms/_Scan Lists/`.
- Added a dedicated "Scan & Export List (CSV)" button to the panel, deliberately kept **separate** from the existing Start button rather than merged into it — preserving the Build Step 1 philosophy of testing scanning/filtering/export in isolation, with zero risk to the already-working single-tab download flow (`DS_START_QUEUE` → `runQueue`), which needed no changes at all.

**Correction to the paragraph above, once real room-page markup was captured:** `selectAllDocuments()` did need a change after all. The original function only located the Select All *label's text span* (`[data-qa="select-all-docs-label-text"]`) and then guessed at a clickable ancestor via a fallback chain (`label.closest("label") || label.closest("[class*='select']") || label.parentElement?.parentElement?.parentElement || ...`) — the same category of DOM-shape guesswork already replaced with confirmed selectors in Decision 11. Verified against the room Documents page's actual markup: the checkbox itself carries its own `data-qa="select-all-docs"` attribute, directly clickable with no ancestor-climbing needed at all. Replaced the ~25-line guess-chain with a direct `document.querySelector('input[data-qa="select-all-docs"]')` lookup.

**Second correction:** the room's group header, `[data-qa="group-name"]`, was also captured in both an empty room (`"Room Docs (0)"`) and a populated one (`"Room Docs (11)"`) — present in *both* states, unlike the Select All checkbox, which never renders at all when a room is empty. This directly overturns Decision 4's "confirmed: not free" conclusion, but only for the *processing* phase, not the scan phase — the room list still has no visible document count, so scanning still can't skip empty rooms upfront. What it does fix: the original `processCurrentRoom()` waited on the Select All checkbox specifically, which meant every empty room burned the full 45-second timeout before failing. Fixed to wait on `group-name` instead (present either way) and short-circuit immediately if the parsed count is `0`. Caveat, not yet verified: this reads only the first `group-name` element on the page; a room with multiple document folders would need the counts summed, and no such room has been inspected yet.

**Third correction, closing out the last guesswork in single-room processing:** real markup for the post-Download confirmation modal was captured. Two findings: (1) its confirm button, `<button class="btn-action" type="submit">Download</button>` inside `<form id="formDownloadDocuments">`, carries no `data-qa` at all — unusual for this app, a sign this particular modal is an older jQuery-driven component (`ctv.documents.initDownload(...)`) bolted onto the otherwise React-based UI. The original `findFinalDownloadButton()` worked around the missing `data-qa` by scanning every visible button/link on the page for text matching "download" — functional by coincidence, fragile in principle, since any other visible "download"-labeled control anywhere on the page would collide with it. Replaced with a selector scoped to the form's own stable `id`: `#formDownloadDocuments button[type="submit"]`. (2) The original code also did `await sleep(3500)` after clicking Bulk Download, gambling the modal would be open by then, before ever checking for it — the same fixed-delay guesswork Decision 7 eliminated elsewhere. Replaced with `waitForSelector('#formDownloadDocuments button[type="submit"]', 10000)`, resolving the instant the modal actually appears instead of always waiting the full guessed amount. `findBulkDownloadButton()` needed no change — its existing selector matched the captured markup exactly, the one place in this whole pass where prior guesswork happened to already be correct.

**Fourth correction:** the full room detail page (Details tab, not just Documents) was captured, revealing `<strong data-qa="room-name">` as the room's own confirmed name element — the same fix pattern applied to `getRoomNameFromPage()`, replacing a 6-selector guessing chain (`[data-qa*='room-name']`, `[data-qa*='room-title']`, `h1`, three class-name heuristics) plus a `document.title`-scrubbing fallback with one direct, confirmed lookup. This had a side effect worth recording: `normalizeText()` in `content/utils.js` (documented in Decision 10 as shared by both the scan and room-page flows) was only ever called from two places — this function, and the text-matching branch of `findFinalDownloadButton()` removed in the correction above. With both callers gone, it became genuinely dead code and was deleted rather than left in `utils.js` unused. Decision 10's original text describing it as a shared dependency is left as-written above (an accurate record of the reasoning *at the time*); this note is the correction, not a rewrite of that history.

---

## Engineering Concepts Demonstrated

- **Producer-consumer / work-queue parallelism** vs. divide-and-conquer, and why task-duration variance determines which one is actually faster.
- **Critical sections and atomicity without explicit locks**, using a single-threaded event loop's natural serialization as the mutual-exclusion mechanism.
- **Event-driven design vs. fixed-delay polling**, and matching timeout length to what's actually being waited for (network-bound vs. UI-reaction-bound).
- **Platform lifecycle awareness** — designing persistence around Manifest V3's deliberately ephemeral service worker model, not just around user-initiated pauses.
- **Feedback-based adaptive control vs. upfront estimation** — recognizing when a parameter can only be tuned from real measurements, not calculated in advance.
- **Constraint-driven architecture** — a stronger technical solution (the official API) correctly abandoned once it hit a real permissions boundary, rather than pursued around it.
- **Revisiting an earlier decision** (streaming scan/download) when a new requirement (resumability) changed the cost-benefit calculation.
- **Matching code organization to actual runtime boundaries** — rejecting OOP not on stylistic grounds but because of how the platform's message-passing serializes data across execution contexts.

---

## Development Process: Human-Authored, AI-Guided

In the interest of an accurate record, not a polished one: this project was built through an ongoing conversation with Claude (Anthropic's Claude Code), and the two roles involved were kept deliberately separate throughout.

**What the human (Miguel Chica) did:** wrote every line of implementation logic by hand — relocating and rewriting functions, choosing and typing the `data-qa` selectors, splitting files, renaming `findBestScrollContainer` to `getScrollContainer` once its behavior was no longer a guess, and running the actual DevTools investigation (element inspection, `getComputedStyle` checks in the Console) that determined the page has no internally-scrolling wrapper. The AI was explicitly instructed not to write feature code, so that the process would build real, transferable understanding of the codebase rather than trust in unread output.

**What the AI did:** explained unfamiliar language and browser concepts on request (`async`/`await` and Promises, optional chaining, `querySelector` vs `querySelectorAll`, CSS `overflow` and computed styles, why content scripts can't use ES module `import`/`export`); reviewed each hand-written change before the next step began, catching concrete bugs along the way — a duplicate `function getRoomCardsAndLinks` declaration that silently made the fixed version dead code, a missing `return`/dedupe block, a case-sensitive folder-naming risk (`Content/` vs `content/`); and designed the DevTools verification steps (which selectors to check, which `getComputedStyle` properties would answer the question) without performing the check itself, since only the human had the live page open.

**Where the AI wrote directly into files, by explicit request only:** the JSDoc-style documentation comments throughout `content/utils.js`, `content/scan.js`, and `content/room.js`, and one confirmed-dead-code removal (the `try/catch` scroll fallback, after the human agreed it was no longer reachable). Both were requested outright, distinct from the feature logic itself, and are called out here rather than left unattributed.

This distinction is recorded here on purpose: "AI-assisted" can mean anything from autocomplete to fully autonomous code generation, and those are very different claims about who understands the resulting system. Through Decision 11, the person who can explain any line of this codebase is the person who typed it.

**Update (2026-08-10):** that changed for the remainder of Build Step 1. Facing a real deadline, the human explicitly chose to hand off the rest of Step 1 — CSV export and the manifest fix (Decision 12) — to the AI, under human review rather than human authorship. This was a deliberate, asked-and-answered decision (see Decision 12), not a quiet drift away from the process described above. The honest summary going forward: the scanning and date-range-filtering logic (the parts requiring the most actual design judgment) are human-authored and human-debugged; the CSV export plumbing and manifest wiring from this point on are AI-authored and human-reviewed. Later phases will be attributed the same way, as they happen, rather than retroactively.
