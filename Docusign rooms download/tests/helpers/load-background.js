/**************************************************************
 * tests/helpers/load-background.js
 * Loads a fresh copy of ../../background.js for each call, with its own
 * fresh STATE object - background.js's exported STATE is a single mutable
 * object, so re-requiring it without clearing Node's module cache would
 * leak state between tests. Also clears content/utils.js's cache entry so
 * background.js's `require("./content/utils.js")` fallback (see
 * background.js's top) re-runs its globalThis attachment against the same
 * fresh load, matching how a real service worker restart would behave.
 **************************************************************/

const path = require("path");
const { makeChromeStub } = require("./chrome-stub");

const BACKGROUND_PATH = path.join(__dirname, "..", "..", "background.js");
const UTILS_PATH = path.join(__dirname, "..", "..", "content", "utils.js");

// `storageLocalGet`, if given, replaces the stub's chrome.storage.local.get
// - the one override the startup-resume tests need, to simulate a
// persisted job already existing when background.js's top-level resume
// IIFE runs (that IIFE executes immediately on require(), before the
// caller gets a chance to touch anything).
function freshBackground({ storageLocalGet } = {}) {
  const stub = makeChromeStub();
  if (storageLocalGet) stub.storage.local.get = storageLocalGet;
  global.chrome = stub;

  delete require.cache[require.resolve(BACKGROUND_PATH)];
  delete require.cache[require.resolve(UTILS_PATH)];

  return require(BACKGROUND_PATH);
}

module.exports = { freshBackground };
