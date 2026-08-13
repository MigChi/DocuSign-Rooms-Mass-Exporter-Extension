/**************************************************************
 * tests/helpers/chrome-stub.js
 * A minimal fake of the chrome.* APIs background.js touches at the top
 * level of the file (listener registration, the startup resume IIFE) -
 * just enough that requiring background.js under Node doesn't throw on
 * "chrome is not defined", not a behavioral mock of Chrome itself.
 * Nothing in this repo's actual production code reads this file.
 **************************************************************/

function makeChromeStub() {
  // `runtime.onMessage`/`tabs.onRemoved`/`tabs.onUpdated` capture whatever
  // listener background.js registers (via `this._listener = fn`, `this`
  // being the specific onX object each is called on) rather than silently
  // discarding it like the old no-op stub did - lets tests drive
  // background.js's actual message-dispatch and tab-lifecycle logic
  // directly instead of only the pure functions it calls into. Every
  // outbound chrome.runtime.sendMessage() call is collected in
  // `runtime.sentMessages` so tests can assert on exactly what got
  // broadcast to the panel, in order.
  const runtime = {
    onMessage: { addListener(fn) { this._listener = fn; } },
    sendMessage: async message => {
      runtime.sentMessages.push(message);
      return {};
    },
    sentMessages: []
  };

  const storageLocal = {
    // Empty by default so background.js's startup resume IIFE finds no
    // persisted job and returns immediately - most tests don't care about
    // resume behavior and shouldn't have to stub around it.
    get: async () => ({}),
    // Every call recorded (not just a no-op) so a test can assert real
    // persistence happened - e.g. that a crashed room's result actually
    // made it into a saved snapshot, not just STATE in memory.
    setCalls: [],
    set: async (...args) => { storageLocal.setCalls.push(args); },
    // Calls recorded in `removeCalls` (not just a no-op) so a test can
    // assert a persisted job was deliberately left alone - e.g. runQueue()'s
    // crash path, which must NOT clear it so a later resume can still pick
    // the job back up.
    removeCalls: [],
    remove: async (...args) => { storageLocal.removeCalls.push(args); }
  };

  const downloads = {
    onDeterminingFilename: { addListener() {} },
    onChanged: { addListener() {} },
    // Every call recorded (not just a no-op) so a test can assert on
    // exactly what filename/conflictAction a download - a checkpoint
    // save, a real export, a room ZIP's routing - actually requested.
    downloadCalls: [],
    download: async options => { downloads.downloadCalls.push(options); return {}; },
    search: async () => []
  };

  return {
    runtime,
    downloads,
    storage: {
      local: storageLocal
    },
    tabs: {
      query: async () => [],
      get: async () => null,
      update: async () => ({}),
      create: async () => ({ id: 1 }),
      sendMessage: async () => ({}),
      onRemoved: { addListener(fn) { this._listener = fn; } },
      onUpdated: { addListener(fn) { this._listener = fn; } }
    },
    // Needed since the detached panel window (see DESIGN.md) - chrome.
    // action.onClicked.addListener() runs at require() time, same as the
    // other top-level listener registrations already stubbed above.
    action: {
      onClicked: { addListener() {} }
    },
    windows: {
      get: async () => null,
      update: async () => ({}),
      create: async () => ({ id: 1 })
    },
    // updateKeepAwake() calls these synchronously (not awaited) on every
    // STATE.running/STATE.scanning transition. Calls recorded in `calls`
    // (a single ordered log of "request"/"release" strings, not separate
    // counters) so a test can assert not just that each was called, but in
    // what order relative to STATE actually changing.
    power: {
      calls: [],
      requestKeepAwake(level) { this.calls.push(`request:${level}`); },
      releaseKeepAwake() { this.calls.push("release"); }
    },
    // The scan-stall watchdog (see SCAN_WATCHDOG_ALARM in background.js)
    // creates a real chrome.alarms alarm rather than a JS timer, so it
    // survives a service-worker restart - onAlarm's listener is captured
    // the same way onMessage/onRemoved/onUpdated are, letting a test fire
    // it directly to simulate the alarm's periodic check without waiting
    // on a real 1-minute interval. create()/clear() calls are recorded so
    // a test can confirm the watchdog is actually being armed and disarmed
    // at the right points, not just trust the alarm fires eventually.
    alarms: {
      onAlarm: { addListener(fn) { this._listener = fn; } },
      createCalls: [],
      clearCalls: [],
      create(name, info) { this.createCalls.push({ name, info }); },
      clear(name) { this.clearCalls.push(name); }
    }
  };
}

module.exports = { makeChromeStub };
