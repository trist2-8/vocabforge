// vf_ui.js
// Small UI helpers: capitalize + short tag display
(() => {
  function capFirst(s) {
    const x = String(s || "");
    if (!x) return x;
    return x.charAt(0).toUpperCase() + x.slice(1);
  }

  function capWords(s) {
    return String(s || "").replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  }

  function shortTag(tag) {
    const t = String(tag || "");
    if (!t) return "";
    if (t.startsWith("src:")) {
      let host = t.slice(4);
      host = host.replace(/^www\./i, "");
      host = host.split("/")[0];
      const parts = host.split(".");
      // instagram.com -> instagram
      return parts.length >= 2 ? parts[0] : host;
    }
    if (t.startsWith("pos:")) return t.slice(4);
    if (t.startsWith("type:")) return t.slice(5);
    if (t.startsWith("lvl:")) return t.slice(4);
    return t.length > 14 ? t.slice(0, 12) + "…" : t;
  }

  window.VF = window.VF || {};
  window.VF.ui = { capFirst, capWords, shortTag };
})();
