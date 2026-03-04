// storage.js
const DB_KEY = "vf_db_v1";
const SCHEMA_VERSION = 3;
const APP_VERSION = "1.2.0";

function nowMs() {
  return Date.now();
}
function startOfDayMs(ts = nowMs()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function uid() {
  return Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
}

export async function getDB() {
  const res = await chrome.storage.local.get(DB_KEY);
  if (!res[DB_KEY]) {
    const empty = {
      words: [], // array of Word
      settings: { dailyGoal: 10 },
      stats: {
        streak: 0,
        lastStudyDay: 0,
        totalReviewed: 0,
        totalCorrect: 0
      },
      createdAt: nowMs()
    };
    await chrome.storage.local.set({ [DB_KEY]: empty });
    return empty;
  }

  const db = res[DB_KEY];

  // ===== repair/migrate (non-breaking) =====
  db.schemaVersion = Number(db.schemaVersion || 1);
  db.appVersion = String(db.appVersion || APP_VERSION);

  db.words ??= [];
  db.settings ??= { dailyGoal: 10 };
  db.settings.dailyGoal = Number(db.settings.dailyGoal || 10);
  db.settings.features ??= {
    systemTags: true,
    tagAutocomplete: true,
    weakFilter: true,
    autoBackup: true
  };

  // Stats are intentionally minimal to reduce bug surface (XP removed).
  // We still tolerate legacy XP fields on disk for backward compatibility.
  db.stats ??= { streak: 0, lastStudyDay: 0, totalReviewed: 0, totalCorrect: 0 };
  db.stats.streak ??= 0;
  db.stats.lastStudyDay ??= 0;
  db.stats.totalReviewed ??= 0;
  db.stats.totalCorrect ??= 0;
  db.stats.lastBackupDay ??= db.stats.lastBackupDay || 0;

  // Remove legacy XP counters from the in-memory object to avoid accidental use.
  // (They may still exist in storage from older versions; we just ignore them.)
  if ("xpTotal" in db.stats) delete db.stats.xpTotal;
  if ("xpToday" in db.stats) delete db.stats.xpToday;
  if ("xpDay" in db.stats) delete db.stats.xpDay;

  if (!db.studyLog || typeof db.studyLog !== "object") db.studyLog = {};
  if (!Array.isArray(db.backups)) db.backups = [];
  if (!Array.isArray(db.debugLog)) db.debugLog = [];

  db.createdAt ??= nowMs();
  db.schemaVersion = SCHEMA_VERSION;

  await chrome.storage.local.set({ [DB_KEY]: db });
  return db;
}

export async function setDB(db) {
  await chrome.storage.local.set({ [DB_KEY]: db });
}

export function normalizeWord(raw) {
  return (raw || "").trim().replace(/\s+/g, " ");
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}


export function normalizeTag(t) {
  return (t || "").trim().toLowerCase().replace(/\s+/g, "-");
}
export function uniqTags(arr) {
  const out = [];
  const seen = new Set();
  for (const t of (arr || [])) {
    const x = normalizeTag(t);
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
export function splitTags(s) {
  return uniqTags((s || "").split(",").map(x => x.trim()).filter(Boolean));
}
export function isSystemTag(t) {
  const x = normalizeTag(t);
  return x.startsWith("src:") || x.startsWith("pos:") || x.startsWith("type:") || x.startsWith("lvl:");
}
export function computeStrength(w) {
  const s = w?.srs || {};
  const interval = Number(s.intervalDays ?? 0);
  const lapses = Number(s.lapses ?? 0);
  const base = Math.max(0, Math.min(100, Math.log2(interval + 1) * 25));
  const penalty = Math.max(0, Math.min(80, lapses * 12));
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

// --- Word Model ---
// {
//   id, word, meaning, example, note, tags:[],
//   createdAt,
//   srs: { intervalDays, ease, reps, lapses, dueAt }
// }

export function makeWord({ word, meaning, pos = "", example = "", note = "", tags = [] }) {
  const w = normalizeWord(word);
  const m = (meaning || "").trim();
  return {
    id: uid(),
    word: w,
    meaning: m,
    pos: (pos || "").trim(),
    example,
    note,
    tags,
    createdAt: nowMs(),
    srs: {
      stepIndex: 0,        // 0=new (step 1), 1=step2, 2=step3, >=3 => SM-2
      intervalDays: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      dueAt: nowMs()
    }
  };
}

export async function addOrMergeWord(payload) {
  const db = await getDB();
  const w = normalizeWord(payload.word);
  if (!w) return { ok: false, error: "Empty word" };

  const existing = db.words.find(x => x.word.toLowerCase() === w.toLowerCase());
  if (existing) {
    // merge nhẹ: nếu meaning trống thì cập nhật, tags union
    if (!existing.meaning && payload.meaning) existing.meaning = payload.meaning.trim();
    if ((!existing.pos || existing.pos.trim()==="") && payload.pos) existing.pos = String(payload.pos).trim();
    const newTags = Array.isArray(payload.tags) ? payload.tags : [];
    existing.tags = uniqTags([...(existing.tags || []), ...newTags]);
    if (payload.example && !existing.example) existing.example = payload.example;
    if (payload.note && !existing.note) existing.note = payload.note;

    await setDB(db);
    return { ok: true, merged: true, word: existing };
  }

  const created = makeWord(payload);
  db.words.unshift(created);
  await setDB(db);
  return { ok: true, merged: false, word: created };
}

export function getDueWords(db, limit = 50) {
  const t = nowMs();
  return db.words
    .filter(w => (w.srs?.dueAt ?? 0) <= t)
    .sort((a, b) => (a.srs.dueAt ?? 0) - (b.srs.dueAt ?? 0))
    .slice(0, limit);
}

export function getNextDueInfo(db) {
  if (!db.words.length) return { nextDueAt: 0, dueCount: 0 };
  const t = nowMs();
  const dueCount = db.words.filter(w => (w.srs?.dueAt ?? 0) <= t).length;
  const future = db.words
    .map(w => w.srs?.dueAt ?? Infinity)
    .filter(x => x > t)
    .sort((a, b) => a - b)[0];
  return { nextDueAt: Number.isFinite(future) ? future : 0, dueCount };
}

// --- SRS update with Learning Steps + SM-2 ---
// rating: 0=Again, 1=Hard, 2=Good, 3=Easy
export function applySRS(wordObj, rating) {
  const t = nowMs();

  const s = wordObj.srs || {
    stepIndex: 0,
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    dueAt: t
  };

  let stepIndex = s.stepIndex ?? 0;
  let ease = s.ease ?? 2.5;
  let interval = s.intervalDays ?? 0;
  let reps = s.reps ?? 0;
  let lapses = s.lapses ?? 0;

  // Learning steps schedule (rõ ràng cho từ mới)
  // stepIndex: 0 -> 10 phút, 1 -> 1 ngày, 2 -> 3 ngày
  const stepSchedule = [
    10 * 60 * 1000,
    1 * 24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000
  ];

  // If Again: always come back soon + penalize
  if (rating === 0) {
    lapses += 1;
    reps = 0;
    interval = 0;
    ease = clamp(ease - 0.2, 1.3, 3.0);

    // Back to step 0 (new) when failed
    stepIndex = 0;
    s.dueAt = t + stepSchedule[0];
  } else {
    // If still in learning steps
    if (stepIndex < stepSchedule.length) {
      if (rating === 1) {
        // Hard: stay in same step but later
        s.dueAt = t + Math.round(stepSchedule[stepIndex] * 1.3);
      } else {
        // Good/Easy: move to next step
        stepIndex += 1;
        if (stepIndex < stepSchedule.length) {
          s.dueAt = t + stepSchedule[stepIndex];
        } else {
          // Graduated to SM-2
          reps = 1;
          interval = 1;
          s.dueAt = t + interval * 24 * 60 * 60 * 1000;
        }
      }
    } else {
      // SM-2 phase
      reps += 1;

      const quality = [1, 3, 4, 5][clamp(rating, 0, 3)];
      const diff = 5 - quality;
      ease = ease + (0.1 - diff * (0.08 + diff * 0.02));
      ease = clamp(ease, 1.3, 3.0);

      if (reps === 1) interval = 1;
      else if (reps === 2) interval = 3;
      else interval = Math.round(interval * ease);

      if (rating === 1) interval = Math.max(1, Math.round(interval * 0.8));
      else if (rating === 3) interval = Math.round(interval * 1.3);

      s.dueAt = t + interval * 24 * 60 * 60 * 1000;
    }
  }

  wordObj.srs = {
    stepIndex,
    intervalDays: interval,
    ease,
    reps,
    lapses,
    dueAt: s.dueAt
  };

  return wordObj;
}

export async function recordStudyResult({ isCorrect, points = 0, countForHeatmap = true }) {
  const db = await getDB();

  const today = startOfDayMs();
  const last = Number(db.stats.lastStudyDay || 0);
  const deltaDays = last ? Math.floor((today - last) / (24 * 60 * 60 * 1000)) : null;

  if (!last) {
    db.stats.streak = 1;
  } else if (deltaDays === 0) {
    // same day
  } else if (deltaDays === 1) {
    db.stats.streak = (db.stats.streak || 0) + 1;
  } else {
    db.stats.streak = 1;
  }

  db.stats.lastStudyDay = today;
  db.stats.totalReviewed = (db.stats.totalReviewed || 0) + 1;
  if (isCorrect) db.stats.totalCorrect = (db.stats.totalCorrect || 0) + 1;

  // XP removed by design (most bugs were caused by XP sync / UI drift).
  // Keep `points` parameter for API compatibility but ignore it.
  void points;

  if (!db.studyLog || typeof db.studyLog !== "object") db.studyLog = {};
  if (countForHeatmap) {
    const d = new Date(today);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    db.studyLog[k] = (db.studyLog[k] || 0) + 1;
  }

  await setDB(db);
  return db.stats;
}

// Record a study *activity* for streak/heatmap without affecting review accuracy counters.
// Use this when user adds a new word or performs non-review learning actions.
export async function recordStudyActivity({ countForHeatmap = true } = {}) {
  const db = await getDB();

  const today = startOfDayMs();
  const last = Number(db.stats.lastStudyDay || 0);
  const deltaDays = last ? Math.floor((today - last) / (24 * 60 * 60 * 1000)) : null;

  if (!last) {
    db.stats.streak = 1;
  } else if (deltaDays === 0) {
    // same day
  } else if (deltaDays === 1) {
    db.stats.streak = (db.stats.streak || 0) + 1;
  } else {
    db.stats.streak = 1;
  }

  db.stats.lastStudyDay = today;

  if (!db.studyLog || typeof db.studyLog !== "object") db.studyLog = {};
  if (countForHeatmap) {
    const d = new Date(today);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    db.studyLog[k] = (db.studyLog[k] || 0) + 1;
  }

  await setDB(db);
  return db.stats;
}

export async function exportDB() {
  const db = await getDB();
  return JSON.stringify(db, null, 2);
}

export async function importDB(jsonText) {
  const parsed = JSON.parse(jsonText);
  // minimal validation
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.words)) {
    throw new Error("Invalid backup format.");
  }
  await chrome.storage.local.set({ [DB_KEY]: parsed });
  return parsed;
}

export async function pushDebugLog(entry) {
  const db = await getDB();
  db.debugLog ??= [];
  db.debugLog.push({ t: nowMs(), ...entry });
  if (db.debugLog.length > 30) db.debugLog = db.debugLog.slice(-30);
  await setDB(db);
}

export async function maybeAutoBackup() {
  const db = await getDB();
  const today = startOfDayMs();
  const last = Number(db.stats.lastBackupDay || 0);
  if (last === today) return false;

  db.backups ??= [];
  const snapshot = {
    t: nowMs(),
    day: today,
    schemaVersion: db.schemaVersion,
    appVersion: db.appVersion,
    words: db.words,
    settings: db.settings,
    stats: db.stats,
    studyLog: db.studyLog
  };
  db.backups.unshift(snapshot);
  db.backups = db.backups.slice(0, 7);
  db.stats.lastBackupDay = today;

  await setDB(db);
  return true;
}

export async function listAllTags() {
  const db = await getDB();
  const set = new Set();
  for (const w of (db.words || [])) {
    for (const t of (w.tags || [])) set.add(normalizeTag(t));
  }
  return Array.from(set).filter(Boolean).sort();
}
