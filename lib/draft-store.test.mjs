import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clearDraft, getDraft, hydrateDrafts, rekeyDraft, setDraft } = await jiti.import("./draft-store.ts");

// Map-backed Storage stand-in: drafts persist per key under the pi-draft:
// prefix, so a stub must answer length/key(i)/getItem/setItem/removeItem.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function withStorage(store, fn) {
  globalThis.localStorage = store;
  try {
    return fn();
  } finally {
    delete globalThis.localStorage;
  }
}

test("setDraft mirrors into localStorage; clearDraft removes it", () => {
  const store = fakeStorage();
  withStorage(store, () => {
    setDraft("t1:sess", { value: "hello", images: [] });
    const raw = store.map.get("pi-draft:t1:sess");
    assert.ok(raw, "persisted entry exists");
    const stored = JSON.parse(raw);
    assert.equal(stored.value, "hello");
    assert.equal(typeof stored.t, "number");

    setDraft("t1:empty", { value: "", images: [] });
    assert.equal(store.map.has("pi-draft:t1:empty"), false, "empty drafts don't persist");

    clearDraft("t1:sess");
    assert.equal(store.map.has("pi-draft:t1:sess"), false);
  });
});

test("rekeyDraft moves the persisted entry to the new key", () => {
  const store = fakeStorage();
  withStorage(store, () => {
    setDraft("t2:new:abc", { value: "composer text", images: [] });
    rekeyDraft("t2:new:abc", "t2:sess-1");
    assert.equal(store.map.has("pi-draft:t2:new:abc"), false);
    assert.equal(JSON.parse(store.map.get("pi-draft:t2:sess-1")).value, "composer text");
    clearDraft("t2:sess-1");
  });
});

test("hydrateDrafts restores stored drafts but never clobbers live ones", () => {
  const store = fakeStorage();
  store.map.set("pi-draft:t3:a", JSON.stringify({ value: "stored a", images: [], t: 1 }));
  store.map.set("pi-draft:t3:b", JSON.stringify({ value: "stored b", images: [{ data: "eA==", mimeType: "image/png" }], t: 2 }));
  store.map.set("pi-draft:t3:bad", "{not json");
  withStorage(store, () => {
    setDraft("t3:a", { value: "live a", images: [] });
    hydrateDrafts();
    assert.equal(getDraft("t3:a").value, "live a", "live memory wins");
    assert.equal(getDraft("t3:b").value, "stored b");
    assert.equal(getDraft("t3:b").images.length, 1);
    assert.equal(store.map.has("pi-draft:t3:bad"), false, "malformed entries are swept");
    clearDraft("t3:a");
    clearDraft("t3:b");
  });
});

test("an oversized draft degrades to text-only in storage, still fully in memory", () => {
  const store = fakeStorage();
  withStorage(store, () => {
    const big = "x".repeat(600 * 1024);
    setDraft("t4:big", { value: "typed", images: [{ data: big, mimeType: "image/png" }] });
    assert.equal(getDraft("t4:big").images[0].data.length, big.length, "memory keeps the image");
    const stored = JSON.parse(store.map.get("pi-draft:t4:big"));
    assert.equal(stored.value, "typed");
    assert.deepEqual(stored.images, [], "persisted entry drops oversize images");
    clearDraft("t4:big");
  });
});

test("a throwing storage never breaks the draft API", () => {
  const store = fakeStorage();
  store.setItem = () => { throw new Error("QuotaExceededError"); };
  store.getItem = () => { throw new Error("blocked"); };
  store.removeItem = () => { throw new Error("blocked"); };
  withStorage(store, () => {
    setDraft("t5:k", { value: "v", images: [] });
    assert.equal(getDraft("t5:k").value, "v");
    hydrateDrafts();
    clearDraft("t5:k");
    assert.equal(getDraft("t5:k"), null);
  });
});
