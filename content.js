// content.js
// Highlight text -> show floating actions near selection (Save / Translate).
// ✅ Keyboard shortcuts: Alt+S (save), Alt+D (translate), Alt+A (legacy save)
// ✅ Enter to save in modal: Enter saves for inputs; in textarea use Shift+Enter for newline
// ✅ Smart capture for TOEIC: auto tag + source context
// ✅ UI polish: pop animations + nicer toast
// Auto lookup English definition + Vietnamese translation via background.

const VF_BTN_ID = "vf-float-actions";
const VF_MODAL_ID = "vf-quick-add";
const VF_STYLE_ID = "vf-style";

let lastSelectionText = "";
let hideTimer = null;
let isSelectingWithPointer = false;

// Some sites (or certain injection contexts) may not expose the extension API object.
// Keep the UI working anyway by falling back to an inline SVG.
function safeGetURL(path) {
  try {
    const rt = globalThis.chrome && globalThis.chrome.runtime;
    if (rt && typeof rt.getURL === "function") return rt.getURL(path);
  } catch (_) {}
  return null;
}

async function safeSendMessage(msg) {
  // IMPORTANT: In MV3, a content script can outlive an extension reload/update.
  // In that case, calling sendMessage may throw/reject with
  // "Extension context invalidated". We must capture BOTH throw + lastError.
  try {
    const rt = globalThis.chrome && globalThis.chrome.runtime;
    if (!rt || typeof rt.sendMessage !== "function") {
      return { ok: false, error: "Extension API unavailable" };
    }

    return await new Promise((resolve) => {
      try {
        rt.sendMessage(msg, (resp) => {
          const le = rt.lastError;
          if (le && le.message) {
            resolve({ ok: false, error: le.message });
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
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

async function fallbackLookupAll(word) {
  const normalized = (word || "").trim().toLowerCase();
  if (!normalized) return null;

  const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized)}`;
  const data = await fetchJSONWithTimeout(dictUrl, 6500);
  const first = data?.[0];
  if (!first) return null;

  const meanings = first?.meanings || [];
  const bestMeaning =
    meanings
      .slice()
      .sort((a, b) => (b?.definitions?.length || 0) - (a?.definitions?.length || 0))[0] ||
    meanings?.[0] ||
    null;

  const enMeaning = (bestMeaning?.definitions?.[0]?.definition || "").trim();
  const example = (bestMeaning?.definitions?.[0]?.example || "").trim();
  const ipa = (first?.phonetic || first?.phonetics?.find(p => p?.text)?.text || "").trim();
  const pos = (bestMeaning?.partOfSpeech || "").trim();

  let viMeaning = "";
  if (enMeaning) {
    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(enMeaning)}`;
    const gData = await fetchJSONWithTimeout(gUrl, 6000);
    viMeaning = (gData?.[0] || []).map(x => x?.[0] || "").join("").trim();
  }

  return {
    enMeaning,
    viMeaning,
    ipa,
    example,
    pos
  };
}

async function fallbackTranslate(word) {
  const q = (word || "").trim();
  if (!q) return { ok: false, error: "Empty q" };

  const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(q)}`;
  const gData = await fetchJSONWithTimeout(gUrl, 6000);
  const meaning = (gData?.[0] || []).map(x => x?.[0] || "").join("").trim();
  if (meaning) return { ok: true, meaning };

  // Secondary fallback (sometimes Google endpoint is blocked by network/CSP)
  const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=auto|vi`;
  const mmData = await fetchJSONWithTimeout(mmUrl, 6500);
  const mm = (mmData?.responseData?.translatedText || "").trim();
  if (mm) return { ok: true, meaning: mm };

  return { ok: false, error: "Translate failed" };
}

function userHintFromError(errText = "") {
  if (/extension context invalidated/i.test(String(errText || ""))) {
    return "Extension vừa cập nhật. Hãy reload tab rồi thử lại.";
  }
  return String(errText || "Có lỗi xảy ra");
}

const FALLBACK_ICON_SVG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".95"/>
          <stop offset="1" stop-color="#dbeafe" stop-opacity=".95"/>
        </linearGradient>
      </defs>
      <path fill="url(#g)" d="M12 2c3 3 4 6 4 8 0 1.7-.7 3.2-2 4.5-1.2 1.2-2 2.1-2 3.5 0-1.4-.8-2.3-2-3.5C6.7 17.2 6 15.7 6 14c0-2 1-5 6-12z"/>
      <path fill="#22d3ee" fill-opacity=".45" d="M7.4 14.1c.2 1 .8 2 1.7 2.9C10.4 18.2 11 19 11 20c0 0-2.7-.3-4.1-2C5.5 16.2 5.2 14.7 5.2 14c0-.3 0-.6.1-.9.5.5 1.3.8 2.1 1z"/>
    </svg>`
  );

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

function cleanSelection(s) {
  return (s || "")
    .trim()
    .replace(/^[\s"'“”‘’(\[{\-–—.,;:!?]+/, "")
    .replace(/[\s"'“”‘’)\]}\-–—.,;:!?]+$/, "")
    .replace(/\s+/g, " ");
}

function vfToast(text, isErr = false) {
  const id = "vf-toast";
  const old = document.getElementById(id);
  if (old) old.remove();

  const el = document.createElement("div");
  el.id = id;
  el.textContent = text;

  el.style.position = "fixed";
  el.style.right = "16px";
  el.style.bottom = "16px";
  el.style.zIndex = "2147483647";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "12px";
  el.style.font = '800 12px ui-sans-serif,system-ui';
  // Always high-contrast (works on both white & dark pages)
  el.style.color = isErr ? "#ffffff" : "#ffffff";
  el.style.background = isErr ? "rgba(190,18,60,.92)" : "rgba(15,23,42,.92)";
  el.style.border = isErr ? "1px solid rgba(251,113,133,.55)" : "1px solid rgba(45,212,191,.55)";
  el.style.boxShadow = "0 14px 40px rgba(0,0,0,.35)";
  el.style.backdropFilter = "blur(8px)";
  el.style.animation = isErr
    ? "vfToastIn .16s ease-out, vfShake .22s ease-in-out"
    : "vfToastIn .16s ease-out";

  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

function ensureStyle() {
  if (document.getElementById(VF_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VF_STYLE_ID;
  style.textContent = `
      /* Floating action bar */
    #${VF_BTN_ID}{
      position: fixed;
      z-index: 2147483647;
      display:none;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(15,23,42,.95);
      box-shadow: 0 12px 40px rgba(0,0,0,.35);
      backdrop-filter: blur(8px);
      user-select:none;
      transition: transform .12s ease, filter .12s ease, opacity .12s ease;
      align-items:center;
      gap: 6px;
      padding: 6px;
    }
    #${VF_BTN_ID}:hover{
      filter: brightness(1.06);
      transform: translateY(-1px);
    }
    #${VF_BTN_ID}.vf-show{ animation: vfPop .14s ease-out; }
    #${VF_BTN_ID} .vf-action{
      border: 1px solid rgba(255,255,255,.14);
      color: #e8eeff;
      background: rgba(255,255,255,.05);
      border-radius: 999px;
      font: 800 11px ui-sans-serif,system-ui;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 10px;
      cursor: pointer;
    }
    #${VF_BTN_ID} .vf-action:hover{ filter: brightness(1.08); }
    #${VF_BTN_ID} .vf-action.save{
      background: linear-gradient(135deg, rgba(79,70,229,.85), rgba(124,58,237,.85));
      border-color: rgba(167,139,250,.5);
    }
    #${VF_BTN_ID} .vf-action.translate{
      background: linear-gradient(135deg, rgba(16,185,129,.24), rgba(45,212,191,.24));
      border-color: rgba(45,212,191,.4);
    }
    /* Quick Add Modal */
    #${VF_MODAL_ID}{
      position: fixed;
      z-index: 2147483647;
      width: 380px;
      max-width: calc(100vw - 24px);
      background: rgba(17, 27, 46, 0.98) !important;
      color: #e8eeff !important;
      border: 1px solid rgba(255,255,255,.10) !important;
      border-radius: 16px;
      box-shadow: 0 18px 60px rgba(0,0,0,.45);
      backdrop-filter: blur(8px);
      overflow: hidden;
      font-family: ui-sans-serif,system-ui !important;
    }
    #${VF_MODAL_ID} .vf-head{
      display:flex; align-items:center; justify-content:space-between;
      padding: 10px 12px;
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      border-bottom: 1px solid rgba(255,255,255,.08);
      font: 800 13px ui-sans-serif,system-ui;
    }
    #${VF_MODAL_ID} .vf-close{
      cursor:pointer; user-select:none;
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.10);
      color: rgba(255,255,255,.85);
      background: rgba(255,255,255,.03);
      font-weight:800;
    }
    #${VF_MODAL_ID} .vf-body{padding: 12px; font: 13px ui-sans-serif,system-ui;}
    #${VF_MODAL_ID} .vf-label{font-size:11px; color: rgba(123,139,179,1); margin: 6px 0 4px;}
    #${VF_MODAL_ID} input, #${VF_MODAL_ID} textarea{
      width:100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      color: #e8eeff;
      outline: none;
      font-size: 13px;
      box-sizing:border-box;
    }
    #${VF_MODAL_ID} textarea{min-height:66px; resize:vertical;}
    #${VF_MODAL_ID} .vf-row{display:flex; gap:8px; align-items:center;}
    #${VF_MODAL_ID} .vf-actions{display:flex; gap:8px; margin-top:10px;}
    #${VF_MODAL_ID} .vf-nn{
      flex:1;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(45,212,191,.35) !important;
      background: rgba(45,212,191,.22) !important;
      color: #ffffff !important;
      cursor:pointer;
      font-weight:800;
      font-size: 13px;
    }
    #${VF_MODAL_ID} .vf-btn.secondary{
      border-color: rgba(96,165,250,.40) !important;
      background: rgba(96,165,250,.20) !important;
    }
    #${VF_MODAL_ID} .vf-btn:disabled{
      opacity: .92 !important;
      cursor: default !important;
      filter: saturate(.95) !important;
    }
    #${VF_MODAL_ID} .vf-btn.ghost{
      border-color: rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      font-weight:700;
    }
    #${VF_MODAL_ID} .vf-hint{
      margin-top:8px;
      font-size: 11px;
      color: rgba(123,139,179,1);
      line-height: 1.35;
    }
    #${VF_MODAL_ID} .vf-pill{
      display:inline-flex;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 999px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.03);
      color: rgba(123,139,179,1);
    }

    /* Motion */
    @keyframes vfPop {
      0% { transform: translateY(6px) scale(.96); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
    @keyframes vfToastIn {
      0% { transform: translateY(10px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }
    @keyframes vfShake{
      0%{ transform: translateX(0); }
      30%{ transform: translateX(-4px); }
      60%{ transform: translateX(4px); }
      100%{ transform: translateX(0); }
    }
  `;
  document.documentElement.appendChild(style);
}

// Inject styles early to avoid “icon exists but invisible” glitches.
ensureStyle();

function getSelectionText() {
  return cleanSelection(window.getSelection?.()?.toString() || "");
}

function getSelectionRect() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function ensureAddButton() {
  let btn = document.getElementById(VF_BTN_ID);
  if (btn) return btn;

  ensureStyle();

  btn = document.createElement("div");
  btn.id = VF_BTN_ID;
  const iconUrl = safeGetURL("icons/icon48.png") || FALLBACK_ICON_SVG;
  btn.innerHTML = `
    <button class="vf-action save" data-action="save" title="Save to VocabForge (Alt+S)">💾 Save</button>
    <button class="vf-action translate" data-action="translate" title="Quick translate (Alt+D)">✨ Dịch</button>
  `;
btn.addEventListener("click", async (e) => {
    const action = e.target?.closest?.("[data-action]")?.dataset?.action;
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();

    if (action === "save") {
      await quickAddFromSelection();
      return;
    }

    if (action === "translate") {
      await quickTranslateFromSelection();
      return;
    }
  });

  document.documentElement.appendChild(btn);
  return btn;
}

function showAddButton(rect, text) {
  const btn = ensureAddButton();
  lastSelectionText = text;

  const pad = 10;
  // Place a bit to the LEFT of the selection end to reduce collisions with other extensions
  // that also show an icon near selection.
  const preferLeftX = rect.right - 42;
  const x = clamp(preferLeftX, pad, window.innerWidth - btn.offsetWidth - pad);
  let y = rect.top - 6;
  if (y < pad) y = rect.bottom + 8;

  btn.style.left = `${Math.round(x)}px`;
  btn.style.top = `${Math.round(y)}px`;
  btn.style.display = "flex";

  btn.classList.remove("vf-show");
  requestAnimationFrame(() => btn.classList.add("vf-show"));

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideAddButton(), 4500);
}

function hideAddButton() {
  const btn = document.getElementById(VF_BTN_ID);
  if (btn) btn.style.display = "none";
}

function removeModal() {
  const m = document.getElementById(VF_MODAL_ID);
  if (m) m.remove();
}

function positionModal(modal, rect) {
  const pad = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = rect.left;
  let y = rect.bottom + 10;

  x = clamp(x, pad, vw - modal.offsetWidth - pad);
  if (y + modal.offsetHeight + pad > vh) {
    y = rect.top - modal.offsetHeight - 10;
  }
  y = clamp(y, pad, vh - modal.offsetHeight - pad);

  modal.style.left = `${Math.round(x)}px`;
  modal.style.top = `${Math.round(y)}px`;
}

async function lookupAll(word) {
  const res = await safeSendMessage({ type: "VF_LOOKUP_ALL", word });
  if (!res?.ok) {
    return await fallbackLookupAll(word);
  }
  return res.data || null; // {enMeaning, viMeaning, ipa, example}
}

function makeModalDraggable(modal) {
  const head = modal.querySelector(".vf-head");
  if (!head) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onMove = (ev) => {
    if (!dragging) return;
    const pad = 8;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const nextLeft = clamp(originLeft + dx, pad, window.innerWidth - modal.offsetWidth - pad);
    const nextTop = clamp(originTop + dy, pad, window.innerHeight - modal.offsetHeight - pad);
    modal.style.left = `${Math.round(nextLeft)}px`;
    modal.style.top = `${Math.round(nextTop)}px`;
  };

  const stopDrag = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", stopDrag, true);
  };

  head.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.target?.closest?.(".vf-close")) return;
    dragging = true;
    startX = ev.clientX;
    startY = ev.clientY;
    const rect = modal.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", stopDrag, true);
    ev.preventDefault();
  }, true);
}

function buildAutoTags() {
  const host = location.hostname;
  const tags = [];

  if (/dautoeic/i.test(host)) tags.push("TOEIC");
  if (/listening/i.test(location.pathname)) tags.push("Listening");
  if (/reading/i.test(location.pathname)) tags.push("Reading");
  if (/vocab/i.test(location.pathname)) tags.push("Vocab");

  return tags;
}

function buildContext() {
  return `${location.hostname}${location.pathname}`.slice(0, 120);
}

async function openModal(word, rect) {
  ensureStyle();
  removeModal();

  const modal = document.createElement("div");
  modal.id = VF_MODAL_ID;
  modal.innerHTML = `
    <div class="vf-head">
      <div>VocabForge • Quick Add</div>
      <div class="vf-close" title="Close (Esc)">✕</div>
    </div>
    <div class="vf-body">
      <div class="vf-label">Word</div>
      <input id="vf_word" />

      <div class="vf-label" style="margin-top:8px;">Part of speech</div>
      <select id="vf_pos" style="width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);color:#e8eeff;outline:none;font-size:13px;box-sizing:border-box;">
        <option value="">(auto)</option>
        <option value="noun">Noun</option>
        <option value="verb">Verb</option>
        <option value="adjective">Adjective</option>
        <option value="adverb">Adverb</option>
        <option value="phrase">Phrase</option>
        <option value="other">Other</option>
      </select>

      <div class="vf-row" style="margin-top:8px;">
        <div style="flex:1;">
          <div class="vf-label">Meaning (Vietnamese)</div>
        </div>
        <button class="vf-btn ghost" id="vf_auto" style="flex:0 0 110px;">Auto</button>
      </div>
      <textarea id="vf_meaning" placeholder="Tự dịch hoặc bạn tự sửa..."></textarea>

      <div class="vf-label">Example</div>
      <textarea id="vf_example" placeholder="Example sentence (optional)"></textarea>

      <div class="vf-label">Tags (comma)</div>
      <input id="vf_tags" placeholder="TOEIC, Reading..." />

      <div class="vf-actions">
        <button class="vf-btn secondary" id="vf_save">Save</button>
        <button class="vf-btn ghost" id="vf_cancel">Cancel</button>
      </div>

      <div class="vf-hint">
        <span class="vf-pill">Tip</span>
        Bôi đen từ → <b>Alt+S</b> để lưu nhanh • <b>Alt+D</b> để dịch nhanh • Enter để Save • Shift+Enter xuống dòng.
    </div>
  `;

  document.documentElement.appendChild(modal);

  const wordInput = modal.querySelector("#vf_word");
  const posSelect = modal.querySelector("#vf_pos");
  const meaningInput = modal.querySelector("#vf_meaning");
  const exInput = modal.querySelector("#vf_example");
  const tagsInput = modal.querySelector("#vf_tags");

  // ✅ Enter to save (textarea: Shift+Enter for newline)
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "textarea" && e.shiftKey) return; // newline
    if (tag === "textarea") e.preventDefault();
    else e.preventDefault();

    const btn = modal.querySelector("#vf_save");
    if (btn) btn.click();
  });

  wordInput.value = word;

  // Prefill tags based on page
  const baseTags = buildAutoTags();
  tagsInput.value = baseTags.join(", ");

  // load auto info
  const applyLookupResult = (data) => {
    if (!data) {
      if (!meaningInput.value || /đang tra/i.test(meaningInput.value)) meaningInput.value = "";
      if (!exInput.value || /đang tra/i.test(exInput.value)) exInput.value = "";
      modal.dataset.ipa = "";
      modal.dataset.enMeaning = "";
      if (posSelect) posSelect.value = "";
      return;
    }
    meaningInput.value = (data.viMeaning || data.enMeaning || "").trim();
    exInput.value = (data.example || "").trim();
    modal.dataset.ipa = data.ipa || "";
    modal.dataset.enMeaning = data.enMeaning || "";
    if (posSelect) posSelect.value = (data.pos || "").trim().toLowerCase();
  };

  const startLookup = (targetWord) => {
    meaningInput.value = "Đang tra nghĩa & dịch...";
    exInput.value = "";
    return lookupAll(targetWord).then((data) => {
      applyLookupResult(data);
      return data;
    });
  };

  let autoLookupPromise = startLookup(word);

  if (rect) positionModal(modal, rect);
  makeModalDraggable(modal);
  const close = () => removeModal();
  modal.querySelector(".vf-close").addEventListener("click", close);
  modal.querySelector("#vf_cancel").addEventListener("click", close);

  modal.querySelector("#vf_auto").addEventListener("click", async () => {
    const w = cleanSelection(wordInput.value);
    if (!w) return;
    autoLookupPromise = startLookup(w);
    await autoLookupPromise;
  });

  modal.querySelector("#vf_save").addEventListener("click", async () => {
    const w = cleanSelection(wordInput.value);
    if (!w) return;

    if (autoLookupPromise) {
      try { await autoLookupPromise; } catch (_) {}
    }

    if (!meaningInput.value.trim() || /đang tra nghĩa/i.test(meaningInput.value)) {
      autoLookupPromise = startLookup(w);
      try { await autoLookupPromise; } catch (_) {}
    }


    const tags = (tagsInput.value || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    const ipa = modal.dataset.ipa || "";
    const enMeaning = modal.dataset.enMeaning || "";

    const payload = {
      word: w,
      pos: (posSelect?.value || "").trim(),
      meaning: meaningInput.value.trim(),
      example: exInput.value.trim(),
      tags,
      note: [
        ipa ? `IPA: ${ipa}` : "",
        enMeaning ? `EN: ${enMeaning}` : "",
        `SRC: ${buildContext()}`
      ].filter(Boolean).join("\n")
    };

    const res = await safeSendMessage({ type: "VF_ADD_WORD", payload });
    if (res?.ok) {
      const b = modal.querySelector("#vf_save");
      if (b) b.textContent = "Saved ✓";
      setTimeout(close, 350);
    } else {
      vfToast(userHintFromError(res?.error || "Save failed ✗"), true);
    }
  });

  // esc to close
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey, true);
    }
  };
  window.addEventListener("keydown", onKey, true);

  // click outside close
  const onClickOutside = (e) => {
    if (!modal.contains(e.target)) {
      close();
      document.removeEventListener("mousedown", onClickOutside, true);
    }
  };
  document.addEventListener("mousedown", onClickOutside, true);

  meaningInput.focus();
}

function maybeShowButton() {
  const text = getSelectionText();
  if (!text) return hideAddButton();
  if (text.length > 60) return hideAddButton();
  if (text.split(" ").length > 4) return hideAddButton();

  const rect = getSelectionRect();
  if (!rect) return hideAddButton();

  showAddButton(rect, text);
}

// Debounced selection tracking for smoother UI across heavy sites (Facebook, etc.)
let selRAF = 0;
let isPointerSelecting = false;

function scheduleMaybeShow(delayMs = 0) {
  if (selRAF) cancelAnimationFrame(selRAF);
  const run = () => {
    selRAF = requestAnimationFrame(() => {
      selRAF = 0;
      maybeShowButton();
    });
  };
  if (delayMs > 0) {
    setTimeout(run, delayMs);
    return;
  }
  run();
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const btn = document.getElementById(VF_BTN_ID);
  if (btn && btn.contains(e.target)) return;
  isPointerSelecting = true;
  hideAddButton();
}, true);

document.addEventListener("selectionchange", () => {
  if (isPointerSelecting) return;
  scheduleMaybeShow();
}, true);

document.addEventListener("mouseup", () => {
  if (!isPointerSelecting) return;
  isPointerSelecting = false;
  // Let browser finish selection range first, then show action bar once.
  scheduleMaybeShow(60);
}, true);

document.addEventListener("keyup", scheduleMaybeShow, true);
document.addEventListener("dblclick", scheduleMaybeShow, true);

document.addEventListener("scroll", hideAddButton, true);
document.addEventListener("mousedown", (e) => {
  const btn = document.getElementById(VF_BTN_ID);
  if (btn && btn.contains(e.target)) return;
  setTimeout(() => {
    if (!getSelectionText()) hideAddButton();
  }, 50);
}, true);

async function quickAddFromSelection() {
  if (isTypingTarget(document.activeElement)) return;
  const word = cleanSelection(getSelectionText() || lastSelectionText || "");
  if (!word) return;
  if (word.length > 60) return;
  if (word.split(" ").length > 4) return;

  const rect = getSelectionRect() || { left: 16, top: 16, bottom: 40, right: 40, width: 24, height: 24 };
  await openModal(word, rect);
}

// Strategy:
// - Prefer Alt key *UP* (more reliable vs browser menu focus).
// - Also support Alt+A (most reliable on many websites).
async function quickTranslateFromSelection() {
  if (isTypingTarget(document.activeElement)) return;
  const word = cleanSelection(getSelectionText() || lastSelectionText || "");
  if (!word) return;
  if (word.length > 60) return;

  let res = await safeSendMessage({ type: "VF_TRANSLATE", payload: { q: word } });
  if (!res?.ok) {
    res = await fallbackTranslate(word);
  }
  if (!res?.ok) {
    vfToast(userHintFromError(res?.error || "Translate failed"), true);
    return;
  }

  const meaning = (res?.meaning || "").trim();
  if (!meaning) {
    vfToast("Không có kết quả dịch", true);
    return;
  }

  const shortMeaning = meaning.length > 110 ? `${meaning.slice(0, 107)}...` : meaning;
  vfToast(`${word} → ${shortMeaning}`);
  hideAddButton();
}
document.addEventListener(
  "keydown",
  async (e) => {
    // If the Quick Add modal is open, shortcuts should operate *inside* the modal.
    // - Alt+D: re-run Auto translate/lookup (restore the translated meaning)
    // - Alt+S / Alt+A: Save
    const modal = document.getElementById(VF_MODAL_ID);
    if (modal) {
      if (!e.altKey || e.repeat || e.ctrlKey || e.metaKey) return;
      const k = String(e.key || "").toLowerCase();

      if (k === "d") {
        e.preventDefault();
        e.stopPropagation();
        const autoBtn = modal.querySelector("#vf_auto");
        if (autoBtn) autoBtn.click();
        return;
      }

      if (k === "s" || k === "a") {
        e.preventDefault();
        e.stopPropagation();
        const saveBtn = modal.querySelector("#vf_save");
        if (saveBtn) saveBtn.click();
        return;
      }
      return;
    }

    // Normal (no modal): Alt+S / Alt+A = open modal; Alt+D = quick translate toast.
    if (isTypingTarget(document.activeElement)) return;
    if (!e.altKey || e.repeat || e.ctrlKey || e.metaKey) return;
    const k = String(e.key || "").toLowerCase();

    if (k === "s" || k === "a") {
      e.preventDefault();
      e.stopPropagation();
      await quickAddFromSelection();
      return;
    }

    if (k === "d") {
      e.preventDefault();
      e.stopPropagation();
      await quickTranslateFromSelection();
    }
  },
  true
);