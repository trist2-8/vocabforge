// stats.js
const STATS_KEY = "toeic_stats_v1";

function todayKey(d = new Date()) {
  // yyyy-mm-dd theo local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function diffDays(aKey, bKey) {
  // aKey, bKey: yyyy-mm-dd
  const [ay, am, ad] = aKey.split("-").map(Number);
  const [by, bm, bd] = bKey.split("-").map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

export async function getStats() {
  const res = await chrome.storage.local.get(STATS_KEY);
  return (
    res[STATS_KEY] || {
      xp: 0,
      streak: 0,
      lastActiveDay: null, // ngày gần nhất có học (yyyy-mm-dd)
      lastOpenDay: null,   // ngày gần nhất mở app/review (yyyy-mm-dd)
    }
  );
}

export async function setStats(next) {
  await chrome.storage.local.set({ [STATS_KEY]: next });
}

export async function ensureDailyStreakOnOpen() {
  const stats = await getStats();
  const t = todayKey();

  // chỉ cần mở app là cập nhật logic "qua ngày" một lần
  if (stats.lastOpenDay === t) return stats;

  // Nếu chưa từng active ngày nào thì chỉ set lastOpenDay
  if (!stats.lastActiveDay) {
    const next = { ...stats, lastOpenDay: t };
    await setStats(next);
    return next;
  }

  // Nếu đã có lastActiveDay, kiểm tra xem đã "đứt" streak chưa
  const gap = diffDays(stats.lastActiveDay, t);

  // gap >= 2 nghĩa là bỏ ít nhất 1 ngày không học => reset streak về 0
  // (gap=1: hôm qua học, hôm nay chưa học => giữ streak, đợi khi học sẽ +1)
  if (gap >= 2) {
    const next = { ...stats, streak: 0, lastOpenDay: t };
    await setStats(next);
    return next;
  }

  const next = { ...stats, lastOpenDay: t };
  await setStats(next);
  return next;
}

export async function markStudiedTodayAndMaybeIncreaseStreak() {
  const stats = await getStats();
  const t = todayKey();

  // Nếu hôm nay đã active rồi => không tăng streak nữa
  if (stats.lastActiveDay === t) return stats;

  // Nếu hôm qua active => streak + 1, còn không => streak = 1
  if (stats.lastActiveDay) {
    const gap = diffDays(stats.lastActiveDay, t);
    const nextStreak = gap === 1 ? (stats.streak || 0) + 1 : 1;
    const next = { ...stats, streak: nextStreak, lastActiveDay: t };
    await setStats(next);
    return next;
  }

  const next = { ...stats, streak: 1, lastActiveDay: t };
  await setStats(next);
  return next;
}

export async function addXP(amount) {
  const stats = await getStats();
  const next = { ...stats, xp: (stats.xp || 0) + (amount || 0) };
  await setStats(next);
  return next;
}