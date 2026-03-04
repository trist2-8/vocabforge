// dashboard.js
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
let activeTag = localStorage.getItem("vf_active_tag") || "";

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

function computeDueCount() {
  const now = Date.now();
  return db.words.filter(w => (w.srs?.dueAt ?? 0) <= now).length;
}


// ===== Streak flame UI (tiered like reference) =====
const VF_STREAK_MILESTONES = [
  { days: 3,  outer: "var(--vf-flame-yellow-outer)",  core: "var(--vf-flame-yellow-core)" },
  { days: 10, outer: "var(--vf-flame-orange-outer)",  core: "var(--vf-flame-orange-core)" },
  { days: 30, outer: "var(--vf-flame-red-outer)",     core: "var(--vf-flame-red-core)" },
  { days: 100,outer: "var(--vf-flame-purple-outer)",  core: "var(--vf-flame-purple-core)" },
  { days: 200,outer: "var(--vf-flame-locked-outer)",  core: "var(--vf-flame-locked-core)" },
];

function vfFlameSvg(outerCss, coreCss, animated = true) {
  const animClass = animated ? "vfFlameAnim" : "";
  return `
    <svg class="vfFlameSvg ${animClass}" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M33 3c2 10-4 15-8 21-5 7-7 11-7 18 0 10 8 19 18 19s18-9 18-19c0-9-6-16-10-22-4-6-7-10-7-17-3 3-4 6-4 10 0 6 4 10 6 14 2 3 4 6 4 10 0 6-5 11-11 11S21 44 21 38c0-6 3-10 6-14 4-5 9-10 6-21Z"
        fill="${outerCss}"/>
      <path d="M33 24c0 5-3 8-5 11-2 3-3 5-3 8 0 5 4 9 9 9s9-4 9-9c0-5-4-8-6-11-1-2-3-4-4-8Z"
        fill="${coreCss}" opacity="0.95"/>
    </svg>`;
}

function vfStreakTierColors(streakDays) {
  if (streakDays >= 100) return VF_STREAK_MILESTONES[3];
  if (streakDays >= 30)  return VF_STREAK_MILESTONES[2];
  if (streakDays >= 10)  return VF_STREAK_MILESTONES[1];
  if (streakDays >= 3)   return VF_STREAK_MILESTONES[0];
  return VF_STREAK_MILESTONES[0];
}

function renderStreakUI(streakDays = 0) {
  const pill = document.getElementById("dashStreakPill");
  const bar  = document.getElementById("dashStreakBar");
  const tier = vfStreakTierColors(streakDays);

  if (pill) {
    pill.innerHTML = `<span class="vfFlameBadge">${vfFlameSvg(tier.outer, tier.core, true)}<span class="vfFlameNum">${streakDays}</span></span>`;
  }
  if (bar) {
    bar.innerHTML = VF_STREAK_MILESTONES.map((m) => {
      const achieved = streakDays >= m.days;
      const outer = achieved ? m.outer : "var(--vf-flame-locked-outer)";
      const core  = achieved ? m.core  : "var(--vf-flame-locked-core)";
      const cls = achieved ? "vfStreakMilestone achieved" : "vfStreakMilestone locked";
      return `
        <div class="${cls}" title="${m.days} day(s)">
          ${vfFlameSvg(outer, core, achieved)}
          <div class="lbl">${m.days}d</div>
        </div>`;
    }).join("");
  }
}

function renderTop() {
  const due = computeDueCount();
  const streak = db.stats?.streak || 0;
  const total = db.words.length;
  const acc = db.stats?.totalReviewed ? Math.round((db.stats.totalCorrect / db.stats.totalReviewed) * 100) : 0;
  document.getElementById("topStats").textContent = `${total} words • ${due} due • accuracy ${acc}%`;
  renderStreakUI(streak);
}

function filterWords() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const tag = document.getElementById("tag").value.trim().toLowerCase();
  const chipTag = (activeTag || "").trim().toLowerCase();

  return db.words.filter(w => {
    const hay = `${w.word} ${w.meaning} ${(w.tags || []).join(" ")} ${w.note || ""} ${w.example || ""}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (chipTag) {
      const tags = (w.tags || []).map(t => (t || "").toLowerCase());
      if (!tags.some(t => t === chipTag || t.includes(chipTag))) return false;
    }
    if (tag) {
      const tags = (w.tags || []).map(t => (t || "").toLowerCase());
      if (!tags.some(t => t.includes(tag))) return false;
    }
    return true;
  });
}

function collectTagStats() {
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
    .slice(0, 14);
}

function renderTagChips() {
  const wrap = document.getElementById("tagChips");
  if (!wrap) return;
  wrap.innerHTML = "";

  const makeChip = (label, value) => {
    const btn = document.createElement("button");
    btn.className = "chip" + ((activeTag || "") === value ? " active" : "");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      activeTag = value;
      localStorage.setItem("vf_active_tag", activeTag);
      document.getElementById("tag").value = activeTag;
      renderTagChips();
      renderList(filterWords());
    });
    return btn;
  };

  wrap.appendChild(makeChip("All", ""));
  const stats = collectTagStats();
  for (const [t, n] of stats) {
    wrap.appendChild(makeChip(`${t} (${n})`, t));
  }
}

function renderList(words) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const now = Date.now();

  for (const w of words.slice(0, 200)) {
    const isDue = (w.srs?.dueAt ?? 0) <= now;
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="top">
        <div class="word">${escapeHtml(w.word)}</div>
        <div class="row" style="gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;">
          <div class="meta">${isDue ? "✅ due" : "⏳"} • next ${escapeHtml(fmtDate(w.srs?.dueAt))}</div>
          <button class="btn ghost" data-edit="${w.id}" style="padding:6px 10px;">Edit</button>
        </div>
      </div>
      <div class="meta"><b>${escapeHtml(w.meaning || "(no meaning)")}</b></div>
      <div class="meta">tags: ${escapeHtml((w.tags || []).join(", ") || "-")} • EF ${(w.srs?.ease || 2.5).toFixed(2)} • reps ${w.srs?.reps || 0} • lapses ${w.srs?.lapses || 0}</div>
    `;
    list.appendChild(el);
  }

  document.getElementById("countText").textContent = `Showing ${Math.min(words.length, 200)} / ${words.length}`;
}

async function load() {
  const res = await send({ type: "VF_GET_DB" });
  if (!res.ok) return;
  db = res.db;

  // sync tag input with chip tag
  if (activeTag && !document.getElementById("tag").value.trim()) {
    document.getElementById("tag").value = activeTag;
  }

  renderTagChips();

  renderTop();
  renderList(filterWords());
}

document.getElementById("applyFilter").addEventListener("click", () => {
  // also update activeTag from input if user typed a full tag
  const v = document.getElementById("tag").value.trim();
  activeTag = v;
  localStorage.setItem("vf_active_tag", activeTag);
  renderTagChips();
  renderList(filterWords());
});

document.getElementById("openReview").addEventListener("click", () => {
  const url = new URL(chrome.runtime.getURL("review.html"));
  if (activeTag) url.searchParams.set("tag", activeTag);
  chrome.tabs.create({ url: url.toString() });
});

document.getElementById("exportBtn").addEventListener("click", async () => {
  const r = await send({ type: "VF_EXPORT" });
  if (!r.ok) return alert("Export failed");

  const blob = new Blob([r.text], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `vocabforge-backup-${Date.now()}.json`;
  a.click();

  URL.revokeObjectURL(url);
});

document.getElementById("importBtn").addEventListener("click", async () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const r = await send({ type: "VF_IMPORT", text });
    if (!r.ok) return alert("Import failed: " + r.error);
    await load();
    alert("Import OK!");
  };
  input.click();
});

load();


// ===== Dashboard Edit Modal =====
let editingId = null;

function openDashEdit(w) {
  editingId = w.id;
  const ov = document.getElementById("vfDashEditOverlay");
  if (!ov) return;
  ov.style.display = "flex";

  document.getElementById("vfDashEditWord").value = w.word || "";
  document.getElementById("vfDashEditMeaning").value = w.meaning || "";
  document.getElementById("vfDashEditExample").value = w.example || "";
  document.getElementById("vfDashEditNote").value = w.note || "";
  document.getElementById("vfDashEditTags").value = (w.tags || []).join(", ");
  // stash current baseline for reset prompt
  document.getElementById("vfDashEditOverlay").dataset.baseWord = w.word || "";
  document.getElementById("vfDashEditOverlay").dataset.baseMeaning = w.meaning || "";
}

function closeDashEdit() {
  const ov = document.getElementById("vfDashEditOverlay");
  if (!ov) return;
  ov.style.display = "none";
  editingId = null;
}

document.getElementById("vfDashEditClose")?.addEventListener("click", closeDashEdit);
document.getElementById("vfDashEditOverlay")?.addEventListener("mousedown", (e) => {
  if (e.target?.id === "vfDashEditOverlay") closeDashEdit();
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("button[data-edit]");
  if (!btn) return;
  const id = btn.getAttribute("data-edit");
  const w = db?.words?.find(x => x.id === id);
  if (w) openDashEdit(w);
});

document.getElementById("vfDashEditSave")?.addEventListener("click", async () => {
  if (!editingId) return;

  const overlay = document.getElementById("vfDashEditOverlay");
  const baseWord = (overlay?.dataset.baseWord || "").trim();
  const baseMeaning = (overlay?.dataset.baseMeaning || "").trim();

  const tags = (document.getElementById("vfDashEditTags").value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const patch = {
    word: document.getElementById("vfDashEditWord").value.trim(),
    meaning: document.getElementById("vfDashEditMeaning").value.trim(),
    example: document.getElementById("vfDashEditExample").value.trim(),
    note: document.getElementById("vfDashEditNote").value.trim(),
    tags
  };

  // ✅ Prompt reset SRS when meaning/word changed
  const changedCore = patch.word !== baseWord || patch.meaning !== baseMeaning;
  if (changedCore) {
    const ok = confirm("Bạn vừa sửa WORD/MEANING. Reset lịch ôn (SRS) về từ mới và due ngay hôm nay không?");
    if (ok) patch.resetSrs = true;
  }

  const r = await send({ type: "VF_UPDATE_WORD", id: editingId, patch });
  if (!r?.ok) return alert("Update failed: " + (r?.error || "Unknown"));

  closeDashEdit();
  await load();
});

document.getElementById("vfDashEditDelete")?.addEventListener("click", async () => {
  if (!editingId) return;
  const w = db?.words?.find(x => x.id === editingId);
  if (!confirm(`Delete "${w?.word || "this word"}"?`)) return;

  const r = await send({ type: "VF_DELETE_WORD", id: editingId });
  if (!r?.ok) return alert("Delete failed: " + (r?.error || "Unknown"));

  closeDashEdit();
  await load();
});


// ===== Gentle FX + scroll pixel animals (v4) =====
function makeAnimalDataUri(kind){
  const palette = {
    cat: {a:"#ffd6a5", b:"#1f2937"},
    bunny:{a:"#c7d2fe", b:"#111827"},
    fox: {a:"#fdba74", b:"#111827"},
    dog: {a:"#fde68a", b:"#111827"},
    owl: {a:"#a7f3d0", b:"#111827"}
  };
  const k = palette[kind] ? kind : "cat";
  const {a,b} = palette[k];
  const px = (x,y,w,h,c)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" shape-rendering="crispEdges">
    ${px(4,5,8,7,a)}
    ${px(3,4,3,3,a)}${px(10,4,3,3,a)}
    ${px(5,8,2,2,b)}${px(9,8,2,2,b)}
    ${px(7,10,2,1,b)}
    ${k==="bunny"? px(5,1,2,4,a)+px(9,1,2,4,a):""}
    ${k==="owl"? px(6,6,1,1,b)+px(9,6,1,1,b):""}
    ${k==="fox"? px(4,6,1,1,b)+px(11,6,1,1,b):""}
  </svg>`;
  const encoded = encodeURIComponent(svg).replace(/'/g,"%27").replace(/"/g,"%22");
  return `data:image/svg+xml,${encoded}`;
}

function setupScrollAnimals(){
  const layer = document.getElementById("vfAnimalLayer");
  if (!layer) return;
  const kinds = ["cat","bunny","fox","dog","owl"];
  let last = 0;

  window.addEventListener("wheel", (e)=>{
    const now = Date.now();
    if (now - last < 120) return;
    last = now;

    const el = document.createElement("div");
    el.className = "vfAnimal";
    const kind = kinds[Math.floor(Math.random()*kinds.length)];
    el.style.backgroundImage = `url("${makeAnimalDataUri(kind)}")`;

    const x = Math.max(12, Math.min(window.innerWidth - 40, (e.clientX || window.innerWidth/2)));
    const y = Math.max(12, Math.min(window.innerHeight - 40, (e.clientY || window.innerHeight/2)));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    layer.appendChild(el);
    setTimeout(()=> el.remove(), 1300);
  }, { passive:true });
}

function setupFX(){
  const canvas = document.getElementById("vfFxCanvas");
  const toggle = document.getElementById("fxToggle");
  const modeSel = document.getElementById("fxMode");
  if (!canvas || !toggle || !modeSel) return;

  const ctx = canvas.getContext("2d");
  let w=0,h=0, raf=0;
  let parts=[];
  const keyOn="vf_fx_dash_on";
  const keyMode="vf_fx_dash_mode";

  const resize=()=>{
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  };
  window.addEventListener("resize", resize);
  resize();

  const spawn=()=>{
    const mode = modeSel.value;
    const count = mode === "snow"
      ? Math.max(26, Math.min(60, Math.round((w*h)/26000)))
      : Math.max(18, Math.min(42, Math.round((w*h)/36000)));
    parts = Array.from({length:count}, ()=>({
      x: Math.random()*w,
      y: Math.random()*h,
      r: mode==="snow" ? (1+Math.random()*2.4) : (2+Math.random()*4.2),
      vx: mode==="snow" ? (-0.18+Math.random()*0.36) : (-0.35+Math.random()*0.7),
      vy: mode==="snow" ? (0.42+Math.random()*0.9) : (0.75+Math.random()*1.25),
      a: mode==="snow" ? (0.35+Math.random()*0.35) : (0.30+Math.random()*0.30),
      rot: Math.random()*Math.PI*2,
      vr: -0.02+Math.random()*0.04
    }));
  };

  function draw(){
    ctx.clearRect(0,0,w,h);
    const mode = modeSel.value;

    for (const p of parts){
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.y > h+10){ p.y=-10; p.x=Math.random()*w; }
      if (p.x < -10) p.x = w+10;
      if (p.x > w+10) p.x = -10;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);

      if (mode === "snow"){
        ctx.beginPath();
        ctx.arc(0,0,p.r,0,Math.PI*2);
        ctx.fillStyle = `rgba(255,255,255,${p.a})`;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(0,0,p.r*1.2,p.r*0.7,0,0,Math.PI*2);
        ctx.fillStyle = `rgba(255,210,140,${p.a})`;
        ctx.fill();
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(draw);
  }

  function start(){
    canvas.style.display="block";
    spawn();
    cancelAnimationFrame(raf);
    draw();
    localStorage.setItem(keyOn,"1");
  }
  function stop(){
    canvas.style.display="none";
    cancelAnimationFrame(raf);
    ctx.clearRect(0,0,w,h);
    localStorage.setItem(keyOn,"0");
  }

  toggle.addEventListener("change", ()=> toggle.checked ? start() : stop());
  modeSel.addEventListener("change", ()=>{
    localStorage.setItem(keyMode, modeSel.value);
    if (toggle.checked) spawn();
  });

  // restore
  const savedOn = localStorage.getItem(keyOn);
  toggle.checked = savedOn !== "0";
  const savedMode = localStorage.getItem(keyMode);
  if (savedMode) modeSel.value = savedMode;
  if (toggle.checked) start(); else stop();
}

document.addEventListener("DOMContentLoaded", () => {
  ensureTagDatalist();
  document.getElementById("refreshBtn")?.addEventListener("click", ()=> load());
  setupFX();
  setupScrollAnimals();
});

// Auto refresh when DB changes (add from popup)
chrome.storage.onChanged.addListener((changes, area)=>{
  if (area !== "local") return;
  if (changes.vf_db_v1){
    load();
  }
});