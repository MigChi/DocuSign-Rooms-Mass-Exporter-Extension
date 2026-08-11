/**************************************************************
 * tests/helpers/chrome-stub.js
 * A minimal fake of the chrome.* APIs background.js touches at the top
 * level of the file (listener registration, the startup resume IIFE) -
 * just enough that requiring background.js under Node doesn't throw on
 * "chrome is not defined", not a behavioral mock of Chrome itself.
 * Nothing in this repo's actual production code reads this file.
 **************************************************************/

function makeChromeStub() {
  return {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({})
    },
    downloads: {
      onDeterminingFilename: { addListener() {} },
      onChanged: { addListener() {} },
      download: async () => ({})
    },
    storage: {
      local: {
        // Empty by default so background.js's startup resume IIFE finds
        // no persisted job and returns immediately - most tests don't
        // care about resume behavior and shouldn't have to stub around it.
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      }
    },
    tabs: {
      query: async () => [],
      get: async () => null,
      update: async () => ({}),
      create: async () => ({ id: 1 }),
      sendMessage: async () => ({})
    }
  };
}

module.exports = { makeChromeStub };
