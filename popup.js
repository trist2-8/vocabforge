// popup.js (UI fix: selects always visible + POS placeholder)
async function send(msg){
  try {
    if (window.VF && VF.rpc) return await VF.rpc(msg);
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function isContextInvalidError(errText = "") {
  return /extension context invalidated/i.test(String(errText || ""));
}

function userHintFromError(errText = "") {
  if (isContextInvalidError(errText)) {
    return "Extension vừa cập nhật. Hãy reload tab rồi thử lại.";
  }
  return "Có lỗi xảy ra, vui lòng thử lại.";
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function humanIn(ts) {
  if (!ts) return "—";
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} hour(s)`;
  const days = Math.round(hours / 24);
  return `in ${days} day(s)`;
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
  // Simple flame silhouette with inner core – colors are CSS variables (so it matches theme)
  return `
    <svg class="vfFlameSvg ${animClass}" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M33 3c2 10-4 15-8 21-5 7-7 11-7 18 0 10 8 19 18 19s18-9 18-19c0-9-6-16-10-22-4-6-7-10-7-17-3 3-4 6-4 10 0 6 4 10 6 14 2 3 4 6 4 10 0 6-5 11-11 11S21 44 21 38c0-6 3-10 6-14 4-5 9-10 6-21Z"
        fill="${outerCss}"/>
      <path d="M33 24c0 5-3 8-5 11-2 3-3 5-3 8 0 5 4 9 9 9s9-4 9-9c0-5-4-8-6-11-1-2-3-4-4-8Z"
        fill="${coreCss}" opacity="0.95"/>
    </svg>`;
}

function vfStreakTierColors(streakDays) {
  // choose the "current" achieved tier color for the badge
  if (streakDays >= 100) return VF_STREAK_MILESTONES[3];
  if (streakDays >= 30)  return VF_STREAK_MILESTONES[2];
  if (streakDays >= 10)  return VF_STREAK_MILESTONES[1];
  if (streakDays >= 3)   return VF_STREAK_MILESTONES[0];
  // <3 days: use yellow but still looks like flame
  return VF_STREAK_MILESTONES[0];
}

function renderStreakUI(streakDays = 0) {
  const pill = document.getElementById("streakPill");
  const bar = document.getElementById("streakBar");

  const tier = vfStreakTierColors(streakDays);
  if (pill) {
    pill.innerHTML = `<span class="vfFlameBadge">${vfFlameSvg(tier.outer, tier.core, true)}<span class="vfFlameNum">${streakDays}</span></span>`;
  }

  if (bar) {
    bar.innerHTML = VF_STREAK_MILESTONES.map((m, idx) => {
      const achieved = streakDays >= m.days;
      const locked = !achieved;
      // milestone 200d stays grey until achieved (like reference)
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


async function refresh() {
  const res = await send({ type: "VF_GET_DB" });
  if (!res?.ok) return;

  const db = res.db;
  const now = Date.now();

  const dueCount = db.words.filter((w) => (w.srs?.dueAt ?? 0) <= now).length;
  const nextDueAt = db.words
    .map((w) => w.srs?.dueAt ?? Infinity)
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];

  setText("dueCount", String(dueCount));
  setText("nextDueAbs", Number.isFinite(nextDueAt) ? fmt(nextDueAt) : "No upcoming");
  setText("nextDueRel", Number.isFinite(nextDueAt) ? humanIn(nextDueAt) : "—");

  renderStreakUI(db.stats?.streak || 0);
  setText("subtitle", `${db.words.length} words • ${dueCount} due`);
  setText("totalWords", `${db.words.length} words`);
}

function setMsg(t) {
  const el = document.getElementById("qaMsg");
  if (el) el.textContent = t || "";
}

function debounce(fn, wait = 450) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function markPosUI() {
  const posEl = document.getElementById("posSelect");
  if (!posEl) return;
  posEl.classList.toggle("hasValue", !!posEl.value);
}


function setupQuickAddUX() {
  const wordEl = document.getElementById("word");
  const meaningEl = document.getElementById("meaning");
  const posEl = document.getElementById("posSelect");
  const swapBtn = document.getElementById("swapFocusBtn");
  const clearPosBtn = document.getElementById("clearPosBtn");
  const translateBtn = document.getElementById("translateBtn");
  const autoToggle = document.getElementById("autoTranslate");
  let translateReqSeq = 0;
  let lastAutoMeaning = "";
  let lastAutoPos = "";

  // Arrow up/down navigation (Word → POS → Meaning)
  const fields = [wordEl, posEl, meaningEl].filter(Boolean);
  fields.forEach((el, idx) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        fields[Math.min(fields.length - 1, idx + 1)].focus();
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        fields[Math.max(0, idx - 1)].focus();
      }
    });
  });

  swapBtn?.addEventListener("click", () => {
    if (document.activeElement === wordEl) meaningEl?.focus();
    else wordEl?.focus();
  });

  clearPosBtn?.addEventListener("click", () => {
    if (!posEl) return;
    posEl.value = "";
    markPosUI();
    wordEl?.focus();
  });

  posEl?.addEventListener("change", markPosUI);

  function shouldApplyAutoMeaning() {
    const current = (meaningEl?.value || "").trim();
    return !current || current === lastAutoMeaning;
  }

  function shouldApplyAutoPos() {
    const current = (posEl?.value || "").trim();
    return !current || current === lastAutoPos;
  }

  async function runTranslate(force = false) {
    const q = (wordEl?.value || "").trim();
    if (!q) return;
    const reqId = ++translateReqSeq;
    setMsg("Translating…");
    const r = await send({ type: "VF_TRANSLATE", payload: { q } });
    if (reqId !== translateReqSeq) return;

    if (r?.ok) {
      if (r.meaning && !meaningEl.value.trim()) meaningEl.value = r.meaning;
      if (r.pos && !posEl.value) {
        posEl.value = r.pos;
        markPosUI();
      }
      setMsg("");
    } else {
      setMsg(userHintFromError(r?.error || "Translate failed."));
    }
  }

  translateBtn?.addEventListener("click", () => runTranslate(true));

  const autoRun = debounce(async () => {
    if (!autoToggle?.checked) return;
    const q = (wordEl?.value || "").trim();
    if (!q) return;
    const r = await send({ type: "VF_TRANSLATE", payload: { q } });
    if (r?.ok) {
      if (r.meaning && !meaningEl.value.trim()) meaningEl.value = r.meaning;
      if (r.pos && !posEl.value) {
        posEl.value = r.pos;
        markPosUI();
      }
    } else if (r?.error) {
      setMsg(userHintFromError(r.error));
    }
  }, 450);

  wordEl?.addEventListener("input", autoRun);
  wordEl?.addEventListener("blur", autoRun);
  wordEl?.addEventListener("input", () => {
    if (!wordEl.value.trim()) {
      lastAutoMeaning = "";
      lastAutoPos = "";
    }
  });

  // Add
  document.getElementById("addBtn")?.addEventListener("click", async () => {
    const word = (wordEl?.value || "").trim();
    const meaning = (meaningEl?.value || "").trim();
    const pos = (posEl?.value || "").trim();
    if (!word) return;

    await send({ type: "VF_ADD_WORD", payload: { word, meaning, pos } });

    // clear + focus back to word
    if (wordEl) {
      wordEl.value = "";
      wordEl.focus();
      wordEl.select?.();
    }
    if (meaningEl) meaningEl.value = "";
    if (posEl) {
      posEl.value = "";
      markPosUI();
    }
    lastAutoMeaning = "";
    lastAutoPos = "";
    translateReqSeq += 1;

    setMsg("Đã thêm vào dashboard ✓");
    await refresh();
  });

  // Enter to add (Word/Meaning)
  const onEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("addBtn")?.click();
    }
  };
  wordEl?.addEventListener("keydown", onEnter);
  meaningEl?.addEventListener("keydown", onEnter);
}

function setupSessionButtons() {
  document.getElementById("reviewBtn")?.addEventListener("click", () => {
    const url = new URL(chrome.runtime.getURL("review.html"));
    url.searchParams.set("queue", "smart");
    url.searchParams.set("limit", "10");
    chrome.tabs.create({ url: url.toString() });
  });

  document.getElementById("startSessionBtn")?.addEventListener("click", () => {
    const size = document.getElementById("sessionSize")?.value || "10";
    const q = document.getElementById("queueMode")?.value || "smart";
    const url = new URL(chrome.runtime.getURL("review.html"));
    url.searchParams.set("limit", String(size));
    url.searchParams.set("queue", q);
    chrome.tabs.create({ url: url.toString() });
  });

  document.getElementById("openDashboard")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

function setupSelectClassToggles() {
  // For any selectLike: add/remove .hasValue so placeholder shows like input placeholders
  document.querySelectorAll("select.selectLike").forEach((sel) => {
    const sync = () => sel.classList.toggle("hasValue", !!sel.value);
    sel.addEventListener("change", sync);
    sync();
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "VF_DB_UPDATED") refresh();
});

document.addEventListener("DOMContentLoaded", () => {
  setupQuickAddUX();
  setupSessionButtons();
  setupSelectClassToggles();
  markPosUI();
  refresh();
});

// ===== Popup FX (snow/leaves) =====
(function setupPopupFX(){
  const canvas = document.getElementById("vfFxCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  let w=0,h=0, raf=0;
  let parts=[];
  const keyOn="vf_fx_popup_on";
  const keyMode="vf_fx_popup_mode";

  // default: snow (you can change)
  const modeSelValue = localStorage.getItem(keyMode) || "snow";
  const isOn = (localStorage.getItem(keyOn) ?? "1") !== "0";

  const resize=()=>{
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  };
  window.addEventListener("resize", resize);
  resize();

  const spawn=(mode)=>{
    const count = mode === "snow"
      ? Math.max(22, Math.min(52, Math.round((w*h)/26000)))
      : Math.max(16, Math.min(38, Math.round((w*h)/36000)));
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

  function draw(mode){
    ctx.clearRect(0,0,w,h);
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
    raf = requestAnimationFrame(()=>draw(mode));
  }

  function start(mode){
    canvas.style.display="block";
    spawn(mode);
    cancelAnimationFrame(raf);
    draw(mode);
    localStorage.setItem(keyOn,"1");
  }
  function stop(){
    canvas.style.display="none";
    cancelAnimationFrame(raf);
    ctx.clearRect(0,0,w,h);
    localStorage.setItem(keyOn,"0");
  }

  if (isOn) start(modeSelValue); else stop();
})();