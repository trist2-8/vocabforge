// vf_rpc.js
// Robust sendMessage wrapper with timeout + consistent errors.
// Usage: const r = await VF.rpc({type:'VF_GET_DB'})
(() => {
  function withTimeout(promise, ms, label) {
    let to;
    const t = new Promise((_, rej) => to = setTimeout(() => rej(new Error(label || "Timeout")), ms));
    return Promise.race([promise.finally(() => clearTimeout(to)), t]);
  }

  async function rpc(msg, { timeoutMs = 2500 } = {}) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      const res = await withTimeout(p, timeoutMs, `RPC timeout: ${msg?.type || "unknown"}`);
      if (!res) return { ok: false, error: "Empty response" };
      return res;
    } catch (e) {
      try { window.VF?.log?.('error','rpc',`sendMessage failed: ${msg?.type}`, { error: String(e) }); } catch {}
      return { ok: false, error: String(e?.message || e) };
    }
  }

  window.VF = window.VF || {};
  window.VF.rpc = rpc;
})();
