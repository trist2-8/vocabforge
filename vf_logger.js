// vf_logger.js
// Simple ring-buffer logger stored in chrome.storage.local to help debug issues quickly.
// Usage: VF.log('info','tag','message',{meta})
(() => {
  const LOG_KEY = "vf_syslog_v1";
  const MAX = 200;

  function now() { return Date.now(); }

  async function readAll() {
    try {
      const r = await chrome.storage.local.get(LOG_KEY);
      return Array.isArray(r[LOG_KEY]) ? r[LOG_KEY] : [];
    } catch { return []; }
  }

  async function writeAll(arr) {
    try { await chrome.storage.local.set({ [LOG_KEY]: arr }); } catch {}
  }

  async function log(level, tag, message, meta) {
    const entry = { t: now(), level, tag, message, meta: meta ?? null };
    try {
      const arr = await readAll();
      arr.push(entry);
      if (arr.length > MAX) arr.splice(0, arr.length - MAX);
      await writeAll(arr);
    } catch {}
    // Also print to console for dev
    try {
      const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
      fn(`[VF][${tag}] ${message}`, meta ?? "");
    } catch {}
  }

  async function getLogs() { return await readAll(); }
  async function clear() { await writeAll([]); }

  window.VF = window.VF || {};
  window.VF.log = log;
  window.VF.getLogs = getLogs;
  window.VF.clearLogs = clear;
})();
