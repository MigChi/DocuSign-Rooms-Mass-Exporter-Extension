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

## Engineering Concepts Demonstrated

- **Producer-consumer / work-queue parallelism** vs. divide-and-conquer, and why task-duration variance determines which one is actually faster.
- **Critical sections and atomicity without explicit locks**, using a single-threaded event loop's natural serialization as the mutual-exclusion mechanism.
- **Event-driven design vs. fixed-delay polling**, and matching timeout length to what's actually being waited for (network-bound vs. UI-reaction-bound).
- **Platform lifecycle awareness** — designing persistence around Manifest V3's deliberately ephemeral service worker model, not just around user-initiated pauses.
- **Feedback-based adaptive control vs. upfront estimation** — recognizing when a parameter can only be tuned from real measurements, not calculated in advance.
- **Constraint-driven architecture** — a stronger technical solution (the official API) correctly abandoned once it hit a real permissions boundary, rather than pursued around it.
- **Revisiting an earlier decision** (streaming scan/download) when a new requirement (resumability) changed the cost-benefit calculation.
- **Matching code organization to actual runtime boundaries** — rejecting OOP not on stylistic grounds but because of how the platform's message-passing serializes data across execution contexts.
