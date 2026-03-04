// review.js
async function ensureTagDatalist() {
  const id = "vfTagList";
  let dl = document.getElementById(id);
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = id;
    document.body.appendChild(dl);
  }

  const tagInputs = ["vfEditTags", "vfDashEditTags"].map(x => document.getElementById(x)).filter(Boolean);
  for (const inp of tagInputs) inp.setAttribute("list", id);

  try {
    const r = await chrome.runtime.sendMessage({ type: "VF_LIST_TAGS" });
    if (!r?.ok) return;
    const tags = Array.isArray(r.tags) ? r.tags : [];
    dl.innerHTML = "";
    tags.slice(0, 300).forEach(t => {
      const op = document.createElement("option");
      op.value = t;
      dl.appendChild(op);
    });
  } catch {}
}

async function send(msg){
  if (window.VF && VF.rpc) return await VF.rpc(msg);
  return await chrome.runtime.sendMessage(msg);
}
let db = null;
let queue = [];
let current = null;

let activeTag = "";
let sessionLimit = 50;
let queueMode = "smart"; // smart | due


// session stats
let sessionTotal = 0;
let sessionDone = 0;
let sessionRatedIds = new Set();
let combo = 0;

let toastEl = null;
function showToast(text){
  if (!toastEl){
    toastEl = document.createElement("div");
    toastEl.className = "vfToast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.remove("show");
  // restart animation
  void toastEl.offsetWidth;
  toastEl.classList.add("show");
}

// mode: "rec" | "recall"
let mode = localStorage.getItem("vf_mode") || "rec";

// recall state
let isChecked = false;
let isCorrect = false;

function fmt(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function humanIn(ts) {
  if (!ts) return "-";
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} hour(s)`;
  const days = Math.round(hours / 24);
  return `in ${days} day(s)`;
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function wordHasTag(w, tag) {
  const t = normalize(tag);
  if (!t) return true;
  return (w.tags || []).some(x => normalize(x) === t || normalize(x).includes(t));
}

function collectTagStatsFromDB() {
  const map = new Map();
  for (const w of (db?.words || [])) {
    for (const raw of (w.tags || [])) {
      const t = (raw || "").trim();
      if (!t) continue;
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

function renderTagChips() {
  const wrap = document.getElementById("tagChips");
  if (!wrap) return;
  wrap.innerHTML = "";

  const makeChip = (label, value) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + ((activeTag || "") === value ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", async () => {
      activeTag = value;
      localStorage.setItem("vf_active_tag", activeTag);
      await load();
    });
    return b;
  };

  wrap.appendChild(makeChip("All", ""));
  const stats = collectTagStatsFromDB();
  for (const [t, n] of stats) {
    wrap.appendChild(makeChip(`${t} (${n})`, t));
  }
}

function renderQueue() {
  const list = document.getElementById("queueList");
  list.innerHTML = "";

  const preview = queue.slice(0, 10);
  for (const w of preview) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="top">
        <div class="word">${escapeHtml(w.word)}</div>
        <div class="meta">${escapeHtml(humanIn(w.srs?.dueAt || 0))}</div>
      </div>
      <div class="meta">${escapeHtml(w.meaning || "(no meaning)")}</div>
    `;
    list.appendChild(el);
  }

  document.getElementById("queueCount").textContent = String(queue.length);
  document.getElementById("queuePill").textContent = String(queue.length);
}

function setInfo() {
  const streak = db?.stats?.streak || 0;
  const tagText = activeTag ? ` • tag: ${activeTag}` : "";
  document.getElementById("info").textContent =
    `${queue.length} due • session ${sessionDone}/${sessionTotal} • streak ${streak}${tagText}`;
  document.getElementById("streakText").textContent = `🔥 ${streak}`;
}

function setProgress() {
  const pct = sessionTotal ? Math.round((sessionDone / sessionTotal) * 100) : 0;
  document.getElementById("bar").style.width = `${pct}%`;
  document.getElementById("leftText").textContent =
    `${sessionDone}/${sessionTotal} done • ${queue.length} left`;
  const c = document.getElementById("comboText");
  if (c) c.textContent = `⚡ ${combo}`;
}

function setModeUI() {
  const recBtn = document.getElementById("modeRec");
  const recallBtn = document.getElementById("modeRecall");

  recBtn.classList.toggle("active", mode === "rec");
  recallBtn.classList.toggle("active", mode === "recall");

  // recognition: show word front; recall: show meaning front
  document.getElementById("frontLabel").textContent = mode === "rec" ? "Word" : "Meaning (VI)";
  document.getElementById("revealBtn").style.display = (mode === "rec" && current) ? "block" : "none";
  document.getElementById("recallBox").style.display = (mode === "recall" && current) ? "block" : "none";
}

function setCheckBadge(state, text) {
  const badge = document.getElementById("checkBadge");
  badge.classList.remove("ok", "bad");
  badge.textContent = text;
  if (state === "ok") badge.classList.add("ok");
  if (state === "bad") badge.classList.add("bad");
}

function resetRecallState() {
  isChecked = false;
  isCorrect = false;
  const input = document.getElementById("recallInput");
  input.value = "";
  setCheckBadge("none", "Not checked");
}

function showWord(w) {
  current = w;
  resetRecallState();

  document.getElementById("ttsBtn").disabled = !w;
  document.getElementById("skipBtn").disabled = !w;
  const eb = document.getElementById("editBtn");
  if (eb) eb.disabled = !w;

  const mb = document.getElementById("meaningBox");
  mb.classList.remove("show");
  mb.style.display = "none";
  document.getElementById("revealBtn").style.display = "none";
  document.getElementById("recallBox").style.display = "none";

  if (!w) {
    document.getElementById("wordText").textContent = "Done 🎉";
    document.getElementById("meaningText").textContent = "Great job!";
    document.getElementById("nextReviewText").textContent = "-";
    document.getElementById("intervalText").textContent = "-";
    document.getElementById("noteText").style.display = "none";
    return;
  }

  // Front side depends on mode
  if (mode === "rec") {
    document.getElementById("wordText").textContent = w.word;
  } else {
    document.getElementById("wordText").textContent = w.meaning || "(no meaning)";
  }

  // Back side content
  document.getElementById("meaningText").textContent = w.meaning || "(no meaning)";
  const note = (w.note || "").trim();
  const noteEl = document.getElementById("noteText");
  if (note) {
    noteEl.style.display = "block";
    noteEl.textContent = note;
  } else {
    noteEl.style.display = "none";
  }

  // schedule preview (current dueAt)
  const dueAt = w?.srs?.dueAt || 0;
  const intervalDays = w?.srs?.intervalDays || 0;
  document.getElementById("nextReviewText").textContent = dueAt ? `${fmt(dueAt)} • ${humanIn(dueAt)}` : "-";
  document.getElementById("intervalText").textContent = intervalDays ? `${intervalDays} day(s)` : "-";

  setModeUI();

  // focus recall input
  if (mode === "recall") {
    setTimeout(() => document.getElementById("recallInput").focus(), 0);
  }
}


async function loadQueue() {
  const res = await send({ type: "VF_GET_DB" });
  if (!res.ok) return;

  db = res.db;
  const now = Date.now();

  const all = db.words.filter(w => wordHasTag(w, activeTag));

  const due = all.filter(w => (w.srs?.dueAt ?? 0) <= now)
    .sort((a, b) => (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0));

  if (queueMode === "due") {
    queue = due.slice(0, sessionLimit);
  } else {
    // smart mode: due -> trouble -> new -> soon
    const notDue = all.filter(w => (w.srs?.dueAt ?? 0) > now);

    const trouble = notDue
      .filter(w => (w.srs?.lapses ?? 0) > 0)
      .sort((a, b) => {
        const dl = (b.srs?.lapses ?? 0) - (a.srs?.lapses ?? 0);
        if (dl !== 0) return dl;
        return (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0);
      });

    const fresh = notDue
      .filter(w => (w.srs?.reps ?? 0) === 0)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    // "soon" = due within next 48h
    const soonWindow = now + 48 * 60 * 60 * 1000;
    const soon = notDue
      .filter(w => (w.srs?.dueAt ?? Infinity) <= soonWindow)
      .sort((a, b) => (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0));

    const pick = [];
    const seen = new Set();

    const pushUniq = (arr) => {
      for (const w of arr) {
        if (pick.length >= sessionLimit) break;
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        pick.push(w);
      }
    };

    pushUniq(due);
    pushUniq(trouble);
    pushUniq(fresh);
    pushUniq(soon);

    // If still short, fill remaining by earliest due
    if (pick.length < sessionLimit) {
      const rest = notDue
        .filter(w => !seen.has(w.id))
        .sort((a, b) => (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0));
      pushUniq(rest);
    }

    queue = pick;
  }

  renderQueue();
  setProgress();
  setInfo();

  renderTagChips();
}


async function load() {
  const params = new URLSearchParams(location.search);
  activeTag = params.get("tag") || localStorage.getItem("vf_active_tag") || "";
  localStorage.setItem("vf_active_tag", activeTag);
  sessionLimit = Number(params.get("limit") || 50) || 50;
  if (sessionLimit < 1) sessionLimit = 50;
  // queue mode: prefer "queue", fallback old "mode=due"
  const qp = (params.get("queue") || params.get("q") || "").toLowerCase();
  const legacy = (params.get("mode") || "").toLowerCase();
  queueMode = (qp === "due" || qp === "smart") ? qp : ((legacy === "due") ? "due" : "smart");

  await loadQueue();
  sessionTotal = queue.length;
  sessionDone = 0;
  sessionRatedIds = new Set();
  combo = 0;
  setProgress();
  setInfo();
  showWord(queue.shift() || null);
}

function reveal() {
  if (!current) return;
  const mb = document.getElementById("meaningBox");
  mb.style.display = "block";
  // trigger transition
  requestAnimationFrame(() => mb.classList.add("show"));
  document.getElementById("revealBtn").style.display = "none";
}

function checkRecall() {
  if (!current) return;

  const input = document.getElementById("recallInput");
  const typed = normalize(input.value);
  const ans = normalize(current.word);

  isChecked = true;
  isCorrect = typed === ans && ans.length > 0;

  if (isCorrect) {
    setCheckBadge("ok", "Correct ✓");
  } else {
    setCheckBadge("bad", `Wrong ✗ (Ans: ${current.word})`);
  }

  // auto reveal back after check
  const mb = document.getElementById("meaningBox");
  mb.style.display = "block";
  requestAnimationFrame(() => mb.classList.add("show"));
}

async function rate(rating) {
  if (!current) return;

  // In Recall mode: force check before rating
  if (mode === "recall" && !isChecked) {
    checkRecall();
    return;
  }

  // combo is kept only for UI feedback (XP has been removed)
  const correctNow = (mode === "recall") ? !!isCorrect : (rating >= 2);
  const nextCombo = correctNow ? (combo + 1) : 0;

  const rr = await send({ type: "VF_APPLY_REVIEW", wordId: current.id, rating, isCorrect: (mode === "recall") ? !!isCorrect : undefined });
  // keep UI stats live without requiring reload
  if (rr?.ok && rr?.stats) {
    db.stats = { ...(db.stats || {}), ...rr.stats };
  }

  // toast feedback
  if (correctNow){
    if (nextCombo >= 5) showToast(`Perfect! ⚡ Combo x${nextCombo}`);
    else if (nextCombo >= 3) showToast(`Nice! ⚡ Combo x${nextCombo}`);
    else showToast(`Good ✓`);
  } else {
    showToast(`Try again…`);
  }

  combo = nextCombo;

  // Count only UNIQUE words in this session (avoid session 28/15 when repeats happen)
  if (!sessionRatedIds.has(current.id)) {
    sessionRatedIds.add(current.id);
    sessionDone += 1;
  }
  setProgress();

  // remove current khỏi queue hiện tại (tránh lặp trong session)
  queue = queue.filter(w => w.id !== current.id);

  setInfo();
  renderQueue();

  const next = queue.shift() || null;
  if (!next) {
    finishSession();
  } else {
    showWord(next);
  }
}

document.getElementById("modeRec").addEventListener("click", () => {
  mode = "rec";
  localStorage.setItem("vf_mode", mode);
  showWord(current);
});

document.getElementById("modeRecall").addEventListener("click", () => {
  mode = "recall";
  localStorage.setItem("vf_mode", mode);
  showWord(current);
});

document.getElementById("revealBtn").addEventListener("click", reveal);

document.getElementById("checkBtn").addEventListener("click", checkRecall);

document.getElementById("recallInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkRecall();
});

document.getElementById("ttsBtn").addEventListener("click", () => {
  if (current) speak(current.word);
});

document.getElementById("skipBtn").addEventListener("click", () => {
  if (!current) return;
  queue.push(current);
  showWord(queue.shift() || null);
  renderQueue();
  setInfo();
  setProgress();
});

document.getElementById("openDash").addEventListener("click", (e) => {
  e.preventDefault();
  const url = new URL(chrome.runtime.getURL("dashboard.html"));
  // dashboard reads localStorage, so no need query, but keep it for clarity
  chrome.tabs.create({ url: url.toString() });
});

document.getElementById("rateRow").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-rate]");
  if (!btn) return;
  const rating = Number(btn.dataset.rate);
  await rate(rating);
});

// Keyboard shortcuts
window.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") window.close();

  if (e.code === "Space") {
    e.preventDefault();
    reveal();
  }

  if (mode === "recall" && e.key === "Enter") {
    checkRecall();
  }

  if (e.key === "1") await rate(0);
  if (e.key === "2") await rate(1);
  if (e.key === "3") await rate(2);
  if (e.key === "4") await rate(3);
});


// ===== Edit modal (Review) =====
function openEditModal(w) {
  const ov = document.getElementById("vfEditOverlay");
  if (!ov) return;
  ov.style.display = "flex";

  document.getElementById("vfEditWord").value = w.word || "";
  document.getElementById("vfEditMeaning").value = w.meaning || "";
  document.getElementById("vfEditExample").value = w.example || "";
  document.getElementById("vfEditNote").value = w.note || "";
  document.getElementById("vfEditTags").value = (w.tags || []).join(", ");
}

function closeEditModal() {
  const ov = document.getElementById("vfEditOverlay");
  if (!ov) return;
  ov.style.display = "none";
}

document.getElementById("editBtn")?.addEventListener("click", () => {
  if (!current) return;
  openEditModal(current);
});

document.getElementById("vfEditClose")?.addEventListener("click", closeEditModal);

document.getElementById("vfEditOverlay")?.addEventListener("mousedown", (e) => {
  if (e.target?.id === "vfEditOverlay") closeEditModal();
});

document.getElementById("vfEditSave")?.addEventListener("click", async () => {
  if (!current) return;

  const tags = (document.getElementById("vfEditTags").value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const patch = {
    word: document.getElementById("vfEditWord").value.trim(),
    meaning: document.getElementById("vfEditMeaning").value.trim(),
    example: document.getElementById("vfEditExample").value.trim(),
    note: document.getElementById("vfEditNote").value.trim(),
    tags
  };

  // ✅ Prompt reset SRS when meaning/word changed
  const changedCore = patch.word !== (current.word || "") || patch.meaning !== (current.meaning || "");
  if (changedCore) {
    const ok = confirm("Bạn vừa sửa WORD/MEANING. Reset lịch ôn (SRS) về từ mới và due ngay hôm nay không?");
    if (ok) patch.resetSrs = true;
  }

  const r = await send({ type: "VF_UPDATE_WORD", id: current.id, patch });
  if (!r?.ok) return alert("Update failed: " + (r?.error || "Unknown"));

  closeEditModal();
  location.reload();
});

document.getElementById("vfEditDelete")?.addEventListener("click", async () => {
  if (!current) return;
  if (!confirm(`Delete "${current.word}"?`)) return;

  const r = await send({ type: "VF_DELETE_WORD", id: current.id });
  if (!r?.ok) return alert("Delete failed: " + (r?.error || "Unknown"));

  closeEditModal();
  location.reload();
});



function launchConfetti() {
  const root = document.getElementById("confetti");
  if (!root) return;
  root.innerHTML = "";
  const n = 70;
  for (let i = 0; i < n; i++) {
    const d = document.createElement("div");
    d.className = "cf";
    d.style.left = Math.random() * 100 + "vw";
    d.style.setProperty("--d", (900 + Math.random() * 900) + "ms");
    d.style.background = `hsl(${Math.floor(Math.random()*360)}, 90%, 65%)`;
    d.style.transform = `rotate(${Math.random()*180}deg)`;
    d.style.width = (6 + Math.random()*6) + "px";
    d.style.height = (10 + Math.random()*10) + "px";
    root.appendChild(d);
  }
  setTimeout(() => { root.innerHTML = ""; }, 1600);
}

function finishSession() {
  // small celebration + keep user motivated
  launchConfetti();
  const title = document.getElementById("wordText");
  if (title) title.textContent = "Session done 🎉";
  const revealBtn = document.getElementById("revealBtn");
  if (revealBtn) {
    revealBtn.textContent = "Back to dashboard";
    revealBtn.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  }
  const meaningBox = document.getElementById("meaningBox");
  if (meaningBox) {
    meaningBox.classList.add("show");
    document.getElementById("meaningText").textContent =
      "Great job. Keep sessions short and consistent to build streaks.";
    const rateRow = document.getElementById("rateRow");
    if (rateRow) rateRow.style.display = "none";
    const recallBox = document.getElementById("recallBox");
    if (recallBox) recallBox.style.display = "none";
    const nextReviewText = document.getElementById("nextReviewText");
    if (nextReviewText) nextReviewText.textContent = "—";
    const intervalText = document.getElementById("intervalText");
    if (intervalText) intervalText.textContent = "—";
  }
}

// ===== Robust close modal fix =====
document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest("#vfEditClose");
  if (closeBtn) {
    closeEditModal();
    return;
  }

  if (e.target?.id === "vfEditOverlay") {
    closeEditModal();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeEditModal();
  }
});
load();