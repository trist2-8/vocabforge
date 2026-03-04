// background.js (MV3 module)
// System pack: safer message routing + consistent responses + optional debug logging.

import {
  addOrMergeWord,
  getDB,
  setDB,
  applySRS,
  recordStudyResult,
  recordStudyActivity,
  exportDB,
  importDB,
  uniqTags,
  maybeAutoBackup,
  pushDebugLog,
  listAllTags
} from "./storage.js";

function guessType(word) {
  const w = (word || "").trim();
  return /\s/.test(w) ? "phrase" : "word";
}

function addSystemTags(payload, { srcHost = "", pos = "", type = "" } = {}) {
  payload.tags = Array.isArray(payload.tags) ? payload.tags : [];
  const sys = [];
  if (srcHost) sys.push(`src:${srcHost}`);
  if (pos) sys.push(`pos:${String(pos).toLowerCase()}`);
  if (type) sys.push(`type:${type}`);
  payload.tags = uniqTags([...(payload.tags || []), ...sys]);
  return payload;
}

const MENU_ID = "vf_add_word";
const LOOKUP_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const TRANSLATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const lookupCache = new Map();
const translateCache = new Map();

function makeCacheKey(prefix, raw) {
  return `${prefix}:${String(raw || "").trim().toLowerCase()}`;
}

function readCache(store, key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(store, key, value, ttlMs) {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
}

async function fetchJSONWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ===== Dictionary lookup (EN) =====
async function lookupMeaning(word) {
  const normalized = (word || "").trim().toLowerCase();
  const w = encodeURIComponent(normalized);
  if (!w || !normalized) return null;

  const cacheKey = makeCacheKey("lookup", normalized);
  const cached = readCache(lookupCache, cacheKey);
  if (cached) return cached;

  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${w}`;
  const data = await fetchJSONWithTimeout(url, 6500);
  const first = data?.[0];
  if (!first) return null;

  const phonetic =
    first?.phonetic ||
    (first?.phonetics?.find(p => p.text)?.text ?? "");

  const meanings = first?.meanings || [];
  const bestMeaning = (meanings || [])
    .slice()
    .sort((a, b) => (b?.definitions?.length || 0) - (a?.definitions?.length || 0))[0] || meanings?.[0];

  const defObj = bestMeaning?.definitions?.[0];
  const pos = (bestMeaning?.partOfSpeech || meanings?.[0]?.partOfSpeech || "").trim();

  const meaning = defObj?.definition || "";
  const example = defObj?.example || "";

 const out = { meaning, ipa: phonetic || "", example: example || "", pos };
  writeCache(lookupCache, cacheKey, out, LOOKUP_CACHE_TTL_MS);
  return out;
}

// ===== Translate to VI (Google endpoint) =====
async function translateToVi(text) {
  const normalized = (text || "").trim();
  const q = encodeURIComponent(normalized);
  if (!q || !normalized) return "";

  const cacheKey = makeCacheKey("translate", normalized);
  const cached = readCache(translateCache, cacheKey);
  if (typeof cached === "string") return cached;

  const googleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${q}`;
  const googleData = await fetchJSONWithTimeout(googleUrl, 6000);
  const googleOut = (googleData?.[0] || []).map(x => x?.[0] || "").join("").trim();
  if (googleOut) {
    writeCache(translateCache, cacheKey, googleOut, TRANSLATE_CACHE_TTL_MS);
    return googleOut;
  }

  const myMemoryUrl = `https://api.mymemory.translated.net/get?q=${q}&langpair=auto|vi`;
  const myMemoryData = await fetchJSONWithTimeout(myMemoryUrl, 6000);
  const fallbackOut = (myMemoryData?.responseData?.translatedText || "").trim();
  if (fallbackOut) {
    writeCache(translateCache, cacheKey, fallbackOut, TRANSLATE_CACHE_TTL_MS);
    return fallbackOut;
  }

  return "";
}

// Build payload ưu tiên VI; note giữ EN + IPA
async function buildAutoPayload(word) {
  const lookup = await lookupMeaning(word);
  const enMeaning = lookup?.meaning || "";
  const viMeaning = enMeaning ? await translateToVi(enMeaning) : "";
  const pos = (lookup?.pos || "").trim();

  const note = [
    lookup?.ipa ? `IPA: ${lookup.ipa}` : "",
    enMeaning ? `EN: ${enMeaning}` : ""
  ].filter(Boolean).join("\n");

  return {
    word,
    meaning: (viMeaning || enMeaning || "").trim(),
    pos,
    example: (lookup?.example || "").trim(),
    note
  };
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Add to VocabForge: "%s"',
      contexts: ["selection"]
    });
  } catch {}

  chrome.alarms.create("vf_tick", { periodInMinutes: 30 });
});

// Context menu add => auto VI
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const selection = (info.selectionText || "").trim().slice(0, 120);
  if (!selection) return;

  const payload = await buildAutoPayload(selection);
  await addOrMergeWord(payload);

  chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
});

function senderHost(sender) {
  try {
    return sender?.url ? new URL(sender.url).hostname : "";
  } catch {
    return "";
  }
}

async function safePushDebug(entry) {
  try { await pushDebugLog(entry); } catch {}
}

const handlers = {
  async VF_LOOKUP(msg) {
    const info = await lookupMeaning(msg.word);
    return { ok: true, info: info || null };
  },

  async VF_LOOKUP_ALL(msg) {
    const rawWord = (msg?.word || "").trim();
    if (!rawWord) return { ok: false, error: "Empty word" };

    const info = await lookupMeaning(rawWord);
    if (info) {
      const enMeaning = info.meaning || "";
      const viMeaning = enMeaning ? await translateToVi(enMeaning) : "";

      return {
        ok: true,
        data: {
          enMeaning,
          viMeaning,
          ipa: info.ipa || "",
          example: info.example || "",
          pos: (info.pos || "").trim()
        }
      };
    }

    const viMeaning = (await translateToVi(rawWord)) || "";
    const fallbackPos = /\s/.test(rawWord) ? "phrase" : "";

    return {
      ok: true,
      data: {
        enMeaning: "",
        viMeaning: viMeaning.trim(),
        ipa: "",
        example: "",
        pos: fallbackPos
      }
    };
  },

  async VF_TRANSLATE(msg) {
    const q = (msg?.payload?.q || "").trim();
    if (!q) return { ok: false, error: "Empty q" };

    const isSingle = /^[A-Za-z'-]+$/.test(q);
    let pos = "";
    let meaning = "";

    if (isSingle) {
      const info = await lookupMeaning(q);
      pos = (info?.pos || "").trim();
      const enMeaning = (info?.meaning || "").trim();
      if (enMeaning) {
        meaning = await translateToVi(enMeaning);
        meaning = (meaning || enMeaning).trim();
      } else {
        meaning = (await translateToVi(q)) || "";
      }
    } else {
      pos = "phrase";
      meaning = (await translateToVi(q)) || "";
    }

    return { ok: true, meaning: meaning.trim(), pos };
  },

  async VF_QUICK_ADD(msg, sender) {
    const word = (msg.word || "").trim();
    if (!word) return { ok: false, error: "Empty selection" };

    const payload = await buildAutoPayload(word);
    const srcHost = senderHost(sender);

    addSystemTags(payload, { srcHost, pos: payload.pos || "", type: guessType(word) });

    // merge meta from content script (auto tags + context)
    const metaTags = Array.isArray(msg?.meta?.tags) ? msg.meta.tags : [];
    const context = (msg?.meta?.context || "").trim();
    if (metaTags.length) payload.tags = Array.from(new Set([...(payload.tags || []), ...metaTags]));
    if (context) payload.note = [payload.note, `SRC: ${context}`].filter(Boolean).join("\n");

    const r = await addOrMergeWord(payload);
    // Adding a word counts as a learning activity for streak/heatmap.
    // (Does NOT affect review accuracy counters.)
    try { await recordStudyActivity({ countForHeatmap: true }); } catch {}
    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true, result: r };
  },

  async VF_ADD_WORD(msg) {
    const payload = { ...(msg.payload || {}) };

    const metaTags = Array.isArray(msg?.meta?.tags) ? msg.meta.tags : [];
    const context = (msg?.meta?.context || "").trim();
    if (metaTags.length) payload.tags = Array.from(new Set([...(payload.tags || []), ...metaTags]));
    if (context) payload.note = [payload.note, `SRC: ${context}`].filter(Boolean).join("\n");

    if (payload.word && (!payload.meaning || payload.meaning.trim() === "")) {
      const auto = await buildAutoPayload(payload.word);
      payload.meaning = auto.meaning;
      payload.example = payload.example || auto.example || "";
      payload.note = payload.note || auto.note || "";
      payload.pos = payload.pos || auto.pos || "";
    }

    const r = await addOrMergeWord(payload);
    // Adding a word counts as a learning activity for streak/heatmap.
    // (Does NOT affect review accuracy counters.)
    try { await recordStudyActivity({ countForHeatmap: true }); } catch {}
    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true, result: r };
  },

  async VF_UPDATE_WORD(msg) {
    const { id, patch } = msg || {};
    if (!id) return { ok: false, error: "Missing id" };

    const db = await getDB();
    const idx = db.words.findIndex(w => w.id === id);
    if (idx < 0) return { ok: false, error: "Word not found" };

    const nextWord = (patch?.word || "").trim();
    if (nextWord) {
      const dup = db.words.some(w => w.id !== id && (w.word || "").toLowerCase() === nextWord.toLowerCase());
      if (dup) return { ok: false, error: "Duplicate word" };
      db.words[idx].word = nextWord;
    }

    if (typeof patch?.meaning === "string") db.words[idx].meaning = patch.meaning.trim();
    if (typeof patch?.example === "string") db.words[idx].example = patch.example.trim();
    if (typeof patch?.note === "string") db.words[idx].note = patch.note.trim();
    if (Array.isArray(patch?.tags)) db.words[idx].tags = patch.tags.map(t => (t || "").trim()).filter(Boolean);

    if (patch?.resetSrs) {
      db.words[idx].srs = {
        stepIndex: 0,
        intervalDays: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
        dueAt: Date.now()
      };
    }

    await setDB(db);
    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true };
  },

  async VF_DELETE_WORD(msg) {
    const id = msg?.id;
    if (!id) return { ok: false, error: "Missing id" };
    const db = await getDB();
    const before = db.words.length;
    db.words = db.words.filter(w => w.id !== id);
    await setDB(db);
    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true, deleted: before - db.words.length };
  },

  async VF_LIST_TAGS() {
    const tags = await listAllTags();
    return { ok: true, tags };
  },

  async VF_GET_DB() {
    const db = await getDB();
    return { ok: true, db };
  },

  async VF_APPLY_REVIEW(msg) {
    const db = await getDB();
    const w = db.words.find(x => x.id === msg.wordId);
    if (!w) return { ok: false, error: "Word not found" };

    applySRS(w, msg.rating);
    await setDB(db);

    const isCorrect = (typeof msg.isCorrect === "boolean") ? msg.isCorrect : (msg.rating >= 2);
    let points = isCorrect ? (msg.rating >= 3 ? 12 : 10) : 2;
    const mult = Number(msg.multiplier || 1);
    if (Number.isFinite(mult)) points = Math.round(points * Math.max(0.5, Math.min(2, mult)));

    const stats = await recordStudyResult({ isCorrect, points });

    try {
      const db2 = await getDB();
      if (db2?.settings?.features?.autoBackup) await maybeAutoBackup();
    } catch (e) {
      await safePushDebug({ type: "ERR", where: "autoBackup", msg: String(e) });
    }

    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true, stats };
  },

  async VF_EXPORT() {
    const text = await exportDB();
    return { ok: true, text };
  },

  async VF_IMPORT(msg) {
    const r = await importDB(msg.text);
    chrome.runtime.sendMessage({ type: "VF_DB_UPDATED" }).catch(() => {});
    return { ok: true, db: r };
  },

  async VF_SYSLOG(msg) {
    // optional: allow UI to push system logs into db.debugLog
    const entry = msg?.entry;
    if (!entry) return { ok: false, error: "Missing entry" };
    await safePushDebug({ type: "UI", ...entry });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;
    const fn = handlers[type];
    if (!fn) {
      sendResponse({ ok: false, error: "Unknown message" });
      return;
    }
    const res = await fn(msg, sender);
    sendResponse(res);
  })().catch(async (e) => {
    await safePushDebug({ type: "ERR", where: "onMessage", msg: String(e), req: { type: msg?.type } });
    sendResponse({ ok: false, error: String(e?.message || e) });
  });

  return true;
});