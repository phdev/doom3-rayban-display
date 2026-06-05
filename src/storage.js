const DB_NAME = "doom3-display";
const DB_VERSION = 1;
const STORE_NAME = "packages";
const PK4_KEY = "base/pak-display.pk4";
const URL_PK4_CACHE_VERSION = "v1";
const URL_PK4_PREFIX = `urlpk4:${URL_PK4_CACHE_VERSION}:`;
const LEGACY_BLOB_TIMEOUT_MS = 60000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, callback) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error);
      })
  );
}

export async function savePk4File(file) {
  const bytes = await file.arrayBuffer();
  const record = {
    key: PK4_KEY,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    updatedAt: new Date().toISOString(),
    bytes
  };

  await withStore("readwrite", (store) => store.put(record));
  return getRecordInfo(record);
}

export async function getPk4Info() {
  const record = await withStore("readonly", (store) => store.get(PK4_KEY));
  if (!record) {
    return null;
  }

  return {
    name: record.name,
    size: record.size,
    updatedAt: record.updatedAt
  };
}

export async function readPk4Bytes() {
  const record = await withStore("readonly", (store) => store.get(PK4_KEY));

  if (!record) {
    return null;
  }

  const bytes = toUint8Array(record.bytes);
  if (bytes) {
    return bytes;
  }

  if (record.blob) {
    const buffer = await withTimeout(
      record.blob.arrayBuffer(),
      LEGACY_BLOB_TIMEOUT_MS,
      "Legacy imported PK4 read timed out. Clear and re-import the PK4."
    );
    return new Uint8Array(buffer);
  }

  return null;
}

export async function readCachedUrlPk4(sourceUrl) {
  if (!sourceUrl) {
    return null;
  }

  const record = await withStore("readonly", (store) => store.get(getUrlPk4Key(sourceUrl)));

  if (!record || record.sourceUrl !== sourceUrl) {
    return null;
  }

  return toUint8Array(record.bytes);
}

export async function saveCachedUrlPk4(sourceUrl, bytes, metadata = {}) {
  if (!sourceUrl) {
    throw new Error("Cannot cache PK4 without a source URL");
  }

  const pk4Bytes = toUint8Array(bytes);
  if (!pk4Bytes) {
    throw new Error("Cannot cache empty PK4 data");
  }

  const record = {
    key: getUrlPk4Key(sourceUrl),
    sourceUrl,
    name: metadata.name || "URL pak-display.pk4",
    size: pk4Bytes.byteLength,
    type: metadata.type || "application/octet-stream",
    updatedAt: new Date().toISOString(),
    bytes: copyToArrayBuffer(pk4Bytes)
  };

  await withStore("readwrite", (store) => store.put(record));
  return getRecordInfo(record);
}

export async function clearCachedUrlPk4(sourceUrl) {
  if (!sourceUrl) {
    return;
  }

  await withStore("readwrite", (store) => store.delete(getUrlPk4Key(sourceUrl)));
}

export async function clearPk4File() {
  await withStore("readwrite", (store) => store.delete(PK4_KEY));
}

export function formatBytes(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;

  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }

  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function getRecordInfo(record) {
  return {
    name: record.name,
    size: record.size,
    updatedAt: record.updatedAt
  };
}

function getUrlPk4Key(sourceUrl) {
  return `${URL_PK4_PREFIX}${sourceUrl}`;
}

function toUint8Array(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return null;
}

function copyToArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function withTimeout(promise, ms, message) {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    globalThis.clearTimeout(timer);
  });
}
