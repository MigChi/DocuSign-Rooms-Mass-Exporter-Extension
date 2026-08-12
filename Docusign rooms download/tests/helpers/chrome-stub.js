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
    set: async () => {},
    // Calls recorded in `removeCalls` (not just a no-op) so a test can
    // assert a persisted job was deliberately left alone - e.g. runQueue()'s
    // crash path, which must NOT clear it so a later resume can still pick
    // the job back up.
    removeCalls: [],
    remove: async (...args) => { storageLocal.removeCalls.push(args); }
  };

  return {
    runtime,
    downloads: {
      onDeterminingFilename: { addListener() {} },
      onChanged: { addListener() {} },
      download: async () => ({}),
      search: async () => []
    },
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
    }
  };
}

module.exports = { makeChromeStub };
