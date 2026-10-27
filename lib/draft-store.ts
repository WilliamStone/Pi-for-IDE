import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

// Drafts also mirror into localStorage, per draft key, so typed-but-unsent
// text survives a page reload: browser refresh, an IDE webview whose host
// extension reloaded, or a tab that got closed and reopened. Writes go
// through synchronously — a webview destroyed by a host reset fires no
// reliable pagehide/beforeunload, so a debounced flush could lose the last
// keystrokes. Only the touched key is (de)serialized, so a keystroke costs
// one small setItem.

const STORAGE_PREFIX = "pi-draft:";
const MAX_PERSISTED_DRAFTS = 200;
// A draft whose serialized form exceeds this keeps only its text — a few MB
// of base64 screenshots would stringify on every keystroke and pressure the
// origin's quota.
const MAX_PERSISTED_ENTRY_BYTES = 512 * 1024;

interface StoredDraft extends ChatDraft {
  /** Last write time — drives oldest-first eviction. */
  t: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function persistedKey(key: string): string {
  return STORAGE_PREFIX + key;
}

function serializeDraft(draft: ChatDraft): string | null {
  try {
    const full = JSON.stringify({ ...draft, t: Date.now() } satisfies StoredDraft);
    if (full.length <= MAX_PERSISTED_ENTRY_BYTES) return full;
    return JSON.stringify({
      value: draft.value,
      images: [],
      t: Date.now(),
    } satisfies StoredDraft);
  } catch {
    return null;
  }
}

function eachPersistedKey(fn: (storageKey: string, draftKey: string) => void): void {
  const store = storage();
  if (!store) return;
  for (let i = 0; i < store.length; i++) {
    const storageKey = store.key(i);
    if (storageKey?.startsWith(STORAGE_PREFIX)) fn(storageKey, storageKey.slice(STORAGE_PREFIX.length));
  }
}

function evictOldestPersisted(keep: number): void {
  const store = storage();
  if (!store) return;
  const entries: Array<{ storageKey: string; t: number }> = [];
  eachPersistedKey((storageKey) => {
    let t = 0;
    try {
      t = (JSON.parse(store.getItem(storageKey) ?? "{}") as StoredDraft).t ?? 0;
    } catch {
      // Unparseable entries evict first (t = 0 sorts oldest).
    }
    entries.push({ storageKey, t });
  });
  entries.sort((a, b) => a.t - b.t);
  for (const { storageKey } of entries.slice(0, Math.max(0, entries.length - keep))) {
    store.removeItem(storageKey);
  }
}

function persistDraft(key: string, draft: ChatDraft): void {
  const store = storage();
  if (!store) return;
  const serialized = serializeDraft(draft);
  if (!serialized) return;
  try {
    store.setItem(persistedKey(key), serialized);
  } catch {
    // Quota pressure: drop the older half, then give up quietly if a retry
    // still doesn't fit — persistence is best-effort, never a write error.
    evictOldestPersisted(MAX_PERSISTED_DRAFTS / 2);
    try {
      store.setItem(persistedKey(key), serialized);
    } catch {
      /* storage full or blocked */
    }
  }
}

function removePersisted(key: string): void {
  try {
    storage()?.removeItem(persistedKey(key));
  } catch {
    /* storage blocked */
  }
}

/** Loads persisted drafts for keys not already live in memory. */
export function hydrateDrafts(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    eachPersistedKey((storageKey, draftKey) => {
      if (!drafts.has(draftKey)) keys.push(storageKey);
    });
    for (const storageKey of keys) {
      try {
        const stored = JSON.parse(store.getItem(storageKey) ?? "") as StoredDraft;
        drafts.set(storageKey.slice(STORAGE_PREFIX.length), {
          value: stored.value ?? "",
          images: Array.isArray(stored.images) ? stored.images : [],
        });
      } catch {
        store.removeItem(storageKey);
      }
    }
    evictOldestPersisted(MAX_PERSISTED_DRAFTS);
  } catch {
    /* storage blocked */
  }
}

hydrateDrafts();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    removePersisted(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
  persistDraft(key, draft);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  removePersisted(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
