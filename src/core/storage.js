'use strict';

function getStorage(name, root = globalThis) {
  try {
    return root?.[name] || null;
  } catch (error) {
    console.warn(`[Veyra] ${name} is unavailable.`, error);
    return null;
  }
}

// Small JSON wrapper that never throws: private mode, quota errors and
// corrupted values all degrade to "nothing stored".
function createJsonStore(storage, logPrefix = '[Veyra]') {
  return {
    available: Boolean(storage),

    read(key) {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        console.warn(`${logPrefix} Could not read ${key}.`, error);
        return null;
      }
    },

    write(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn(`${logPrefix} Could not save ${key}.`, error);
        return false;
      }
    },

    remove(key) {
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch (error) {
        console.warn(`${logPrefix} Could not remove ${key}.`, error);
      }
    },

    readRaw(key) {
      if (!storage) return null;
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },

    writeRaw(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, String(value));
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = {
  createJsonStore,
  getStorage,
};
