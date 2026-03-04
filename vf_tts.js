// vf_tts.js
// More reliable TTS for Chrome (speechSynthesis can get stuck without cancel+delay).
(() => {
  let cachedVoice = null;
  let voiceReady = false;

  function pickVoice() {
    try {
      const voices = speechSynthesis.getVoices() || [];
      const en = voices.filter(v => /en/i.test(v.lang || ""));
      // Prefer Google/English US voices if available
      const preferred = en.find(v => /google/i.test(v.name || "")) || en.find(v => /en-us/i.test(v.lang || "")) || en[0];
      cachedVoice = preferred || null;
      voiceReady = true;
    } catch { /* ignore */ }
  }

  try {
    speechSynthesis.onvoiceschanged = () => pickVoice();
    pickVoice();
  } catch {}

  async function speak(text, { rate = 1, pitch = 1, volume = 1 } = {}) {
    const t = (text || "").trim();
    if (!t) return;
    try {
      // cancel current speech first
      speechSynthesis.cancel();
    } catch {}
    // small delay makes Chrome much more consistent
    await new Promise(r => setTimeout(r, 60));
    try {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = "en-US";
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      if (!voiceReady) pickVoice();
      if (cachedVoice) u.voice = cachedVoice;
      speechSynthesis.speak(u);
    } catch (e) {
      try { window.VF?.log?.('warn','tts','speech failed', { error: String(e) }); } catch {}
    }
  }

  window.VF = window.VF || {};
  window.VF.speak = speak;
})();
