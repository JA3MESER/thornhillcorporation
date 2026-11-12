/* ==========================================================================
   Thornhill Corporation — Data layer
   Talks to Supabase when configured, otherwise falls back to demo mode
   (browser localStorage). Admin credentials are verified server-side by
   Postgres functions in supabase/setup.sql — the browser never sees the
   enquiries table directly.
   ========================================================================== */
(function () {
  const cfg = window.THORNHILL_CONFIG || {};
  const LIVE = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const DEMO_KEY = "thornhill.demo.enquiries";

  async function rpc(fn, args) {
    const key = cfg.supabaseAnonKey.trim();
    const headers = { "Content-Type": "application/json", apikey: key };
    // Legacy "anon" keys are JWTs (start with "eyJ") and also go in the Authorization header.
    // Newer "sb_publishable_..." keys must only be sent as the apikey header.
    if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
    // Accept the URL with or without a trailing "/rest/v1/" (Supabase's Data API page shows it both ways)
    const base = cfg.supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
    const res = await fetch(base + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers,
      body: JSON.stringify(args || {})
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (data && (data.message || data.hint)) || "Request failed (" + res.status + ")";
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- demo helpers ---------- */
  function demoRead() {
    try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || []; } catch (e) { return []; }
  }
  function demoWrite(list) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(list)); } catch (e) { /* storage blocked */ }
  }
  function makeRef() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return "TH-" + s;
  }
  function demoCheck(name, code) {
    const n = String(name || "").trim().toLowerCase();
    return (cfg.demoAdmins || []).find(a => a.fullName.trim().toLowerCase() === n && a.code === code);
  }
  function notAuthorised() {
    const e = new Error("Session expired — please sign in again");
    e.status = 401;
    return e;
  }
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }

  const Store = {
    live: LIVE,

    /** Customer: submit a support enquiry. Returns the reference code. */
    async submitEnquiry(e) {
      if (LIVE) {
        return await rpc("submit_enquiry", {
          p_full_name: e.fullName, p_email: e.email, p_phone: e.phone || null,
          p_category: e.category, p_subject: e.subject, p_message: e.message
        });
      }
      const list = demoRead();
      const now = new Date().toISOString();
      const item = {
        id: uuid(), reference: makeRef(), full_name: e.fullName, email: e.email, phone: e.phone || null,
        category: e.category, subject: e.subject, message: e.message, status: "new",
        admin_notes: null, created_at: now, updated_at: now
      };
      list.unshift(item);
      demoWrite(list);
      return item.reference;
    },

    /** Admin: verify full name + special code. Returns the admin's display name or throws. */
    async login(name, code) {
      if (LIVE) {
        const display = await rpc("admin_login", { p_name: name, p_code: code });
        if (!display) throw new Error("Those details don't match an administrator account.");
        return display;
      }
      const a = demoCheck(name, code);
      if (!a) throw new Error("Those details don't match an administrator account.");
      return a.fullName;
    },

    async list(name, code) {
      if (LIVE) {
        const r = await rpc("admin_list_enquiries", { p_name: name, p_code: code });
        if (!r || !r.ok) throw notAuthorised();
        return r.items || [];
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      return demoRead();
    },

    async update(name, code, id, status, notes) {
      if (LIVE) {
        const r = await rpc("admin_update_enquiry", { p_name: name, p_code: code, p_id: id, p_status: status, p_notes: notes });
        if (r === null) throw notAuthorised();
        return r;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      const list = demoRead();
      const item = list.find(x => x.id === id);
      if (item) { item.status = status; item.admin_notes = notes; item.updated_at = new Date().toISOString(); }
      demoWrite(list);
      return true;
    },

    async remove(name, code, id) {
      if (LIVE) {
        const r = await rpc("admin_delete_enquiry", { p_name: name, p_code: code, p_id: id });
        if (r === null) throw notAuthorised();
        return r;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      demoWrite(demoRead().filter(x => x.id !== id));
      return true;
    }
  };

  window.ThornhillStore = Store;
})();
