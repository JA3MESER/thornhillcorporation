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
    },

    /* ======================= Document hub ======================= */

    /** Admin: list documents (without PDF contents). */
    async listDocuments(name, code) {
      if (LIVE) {
        const r = await rpc("admin_list_documents", { p_name: name, p_code: code });
        if (!r || !r.ok) throw notAuthorised();
        return r.items || [];
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      return demoDocs().map(({ pdf_data, ...rest }) => rest);
    },

    /**
     * Admin: create (doc.id empty) or update a document.
     * doc = { id, slug, title, description, kind: "google"|"pdf", url, fileName, fileSize, pdfData (base64, or null to keep), isPublic }
     * Returns { id, slug } or throws with a friendly message.
     */
    async saveDocument(name, code, doc, adminName) {
      if (LIVE) {
        const r = await rpc("admin_save_document", {
          p_name: name, p_code: code, p_id: doc.id || null,
          p_slug: doc.slug, p_title: doc.title, p_description: doc.description || null,
          p_kind: doc.kind, p_url: doc.url || null, p_file_name: doc.fileName || null,
          p_file_size: doc.fileSize || null, p_pdf_data: doc.pdfData || null, p_is_public: !!doc.isPublic
        });
        if (r && r.auth === false) throw notAuthorised();
        if (!r || !r.ok) throw new Error((r && r.error) || "Couldn't save the document.");
        return r;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      const docs = demoDocs();
      const slug = doc.slug.toLowerCase();
      if (docs.some(d => d.slug === slug && d.id !== doc.id)) throw new Error("That short link is already in use. Please choose another.");
      const now = new Date().toISOString();
      let d = doc.id && docs.find(x => x.id === doc.id);
      if (!d) { d = { id: uuid(), views: 0, created_at: now, created_by: adminName }; docs.unshift(d); }
      Object.assign(d, {
        slug, title: doc.title, description: doc.description || null, kind: doc.kind,
        url: doc.kind === "google" ? doc.url : null,
        file_name: doc.kind === "pdf" ? (doc.fileName || d.file_name) : null,
        file_size: doc.kind === "pdf" ? (doc.fileSize || d.file_size) : null,
        pdf_data: doc.kind === "pdf" ? (doc.pdfData || d.pdf_data) : null,
        is_public: !!doc.isPublic, updated_at: now
      });
      if (!demoDocsWrite(docs)) throw new Error("This browser ran out of storage for demo PDFs. Connect Supabase to store larger files.");
      return { id: d.id, slug };
    },

    async deleteDocument(name, code, id) {
      if (LIVE) {
        const r = await rpc("admin_delete_document", { p_name: name, p_code: code, p_id: id });
        if (r === null) throw notAuthorised();
        return r;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      demoDocsWrite(demoDocs().filter(d => d.id !== id));
      return true;
    },

    /** Public: fetch one document by its short link (counts a view). Returns null if not found. */
    async getDocument(slug) {
      if (LIVE) return await rpc("get_document", { p_slug: slug });
      const docs = demoDocs();
      const d = docs.find(x => x.slug === String(slug).toLowerCase());
      if (!d) return null;
      d.views = (d.views || 0) + 1;
      demoDocsWrite(docs);
      return d;
    },

    /* ======================= Thornhill Quick ======================= */

    /** Call the "quick" Edge Function (passkey sign-in) */
    async quickFunction(body) {
      if (!LIVE) throw new Error("Thornhill Quick needs Supabase to be connected.");
      const base = cfg.supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
      const key = cfg.supabaseAnonKey.trim();
      const headers = { "Content-Type": "application/json", apikey: key };
      if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
      let res;
      try { res = await fetch(base + "/functions/v1/quick", { method: "POST", headers, body: JSON.stringify(body) }); }
      catch (e) { throw new Error("Couldn't reach Thornhill Quick. Check your connection."); }
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.status === 401 && data && data.auth === false) throw notAuthorised();
      if (res.status === 404) throw new Error("Thornhill Quick isn't switched on yet (the \"quick\" function isn't deployed).");
      if (res.status === 401) throw new Error("Thornhill Quick is blocked. Turn off \"Verify JWT\" on the quick function.");
      if (!data) throw new Error("Thornhill Quick returned an unexpected response.");
      if (data.ok === false) throw new Error(data.error || "Thornhill Quick couldn't sign you in.");
      return data;
    },
    async quickOverview(n, c) {
      if (!LIVE) return { ok: true, devices: [], sessions: 0 };
      const r = await rpc("admin_quick_overview", { p_name: n, p_code: c });
      if (!r || !r.ok) throw notAuthorised();
      return r;
    },
    async quickRemoveDevice(n, c, id) {
      const r = await rpc("admin_quick_remove_device", { p_name: n, p_code: c, p_id: id });
      if (!r || !r.ok) throw notAuthorised();
      return r;
    },
    /** End this sign-in (and optionally every Thornhill Quick sign-in for this admin) */
    signOut(n, c, everywhere) {
      if (!LIVE) return Promise.resolve();
      return rpc("admin_sign_out", { p_name: n, p_code: c, p_everywhere: !!everywhere }).catch(() => null);
    },

    /* ======================= Emailing Centre ======================= */
    // Everything here needs Supabase (the "email" function sends through Resend).

    async emailRpc(fn, name, code, args) {
      if (!LIVE) throw new Error("Connect Supabase to use the Emailing Centre (see README).");
      const r = await rpc(fn, Object.assign({ p_name: name, p_code: code }, args || {}));
      if (r && (r.auth === false || r.ok === false && !r.error)) throw notAuthorised();
      if (r && r.ok === false) throw new Error(r.error || "Something went wrong.");
      return r;
    },
    emailOverview(n, c) { return this.emailRpc("admin_email_overview", n, c); },
    listThreads(n, c, o) {
      return this.emailRpc("admin_list_threads", n, c, {
        p_folder: o.folder, p_mailbox: o.mailbox && o.mailbox !== "unrouted" ? o.mailbox : null,
        p_unrouted: o.mailbox === "unrouted", p_search: o.search || null, p_limit: o.limit || 50, p_offset: o.offset || 0
      });
    },
    getThread(n, c, id) { return this.emailRpc("admin_get_thread", n, c, { p_thread: id }); },
    enquiryEmails(n, c, id) { return this.emailRpc("admin_enquiry_emails", n, c, { p_enquiry: id }); },
    threadAction(n, c, ids, action) { return this.emailRpc("admin_thread_action", n, c, { p_threads: ids, p_action: action }); },
    saveMailbox(n, c, m) {
      return this.emailRpc("admin_save_mailbox", n, c, { p_id: m.id || null, p_address: m.address, p_display_name: m.display_name,
        p_kind: m.kind, p_signature: m.signature || null, p_is_default: !!m.is_default });
    },
    deleteMailbox(n, c, id) { return this.emailRpc("admin_delete_mailbox", n, c, { p_id: id }); },
    saveTemplate(n, c, t) { return this.emailRpc("admin_save_template", n, c, { p_id: t.id || null, p_tname: t.name, p_subject: t.subject || null, p_body: t.body }); },
    deleteTemplate(n, c, id) { return this.emailRpc("admin_delete_template", n, c, { p_id: id }); },
    saveEmailSettings(n, c, s) {
      return this.emailRpc("admin_save_email_settings", n, c, { p_domain: s.domain, p_site_url: s.site_url,
        p_auto_ack: !!s.auto_ack, p_ack_mailbox: s.ack_mailbox_id || null, p_ack_template: s.ack_template_id || null });
    },

    /** Call the "email" Edge Function (send / status / ack) */
    async emailFunction(body) {
      if (!LIVE) throw new Error("Connect Supabase to use the Emailing Centre (see README).");
      const base = cfg.supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
      const key = cfg.supabaseAnonKey.trim();
      const headers = { "Content-Type": "application/json", apikey: key };
      if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
      let res;
      try {
        res = await fetch(base + "/functions/v1/email", { method: "POST", headers, body: JSON.stringify(body) });
      } catch (e) {
        throw new Error("Couldn't reach the email service. Check that the \"email\" function is deployed with Verify JWT turned off.");
      }
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.status === 401 && data && data.auth === false) throw notAuthorised();
      if (res.status === 404) throw new Error("The \"email\" function isn't deployed in Supabase yet.");
      if (res.status === 401) throw new Error("The email function is blocking requests. Turn off \"Verify JWT\" in its settings.");
      if (!data) throw new Error("The email service returned an unexpected response (" + res.status + ").");
      if (data.ok === false && data.error) throw new Error(data.error);
      return data;
    },

    /** Public: ask for the automatic "we've received your enquiry" email (only sends if switched on) */
    requestAck(reference) {
      if (!LIVE) return Promise.resolve(null);
      return this.emailFunction({ action: "ack", reference }).catch(() => null);
    },

    /* ======================= Redirects ======================= */

    async listRedirects(name, code) {
      if (LIVE) {
        const r = await rpc("admin_list_redirects", { p_name: name, p_code: code });
        if (!r || !r.ok) throw notAuthorised();
        return r.items || [];
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      return demoRedirects().sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    },

    /** r = { id, path, destination, label } → { id, path } */
    async saveRedirect(name, code, r, adminName) {
      const path = String(r.path || "").trim().replace(/^\/+|\/+$/g, "");
      if (LIVE) {
        const res = await rpc("admin_save_redirect", {
          p_name: name, p_code: code, p_id: r.id || null, p_path: path, p_destination: r.destination, p_label: r.label || null
        });
        if (res && res.auth === false) throw notAuthorised();
        if (!res || !res.ok) throw new Error((res && res.error) || "Couldn't save the redirect.");
        return res;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      const list = demoRedirects();
      if (["assets", "d", "index.html", "404.html", "cname"].includes(path.split("/")[0].toLowerCase()))
        throw new Error("That short link is reserved by the website. Please choose another.");
      if (list.some(x => x.path.toLowerCase() === path.toLowerCase() && x.id !== r.id))
        throw new Error("That short link is already in use. Please choose another.");
      const now = new Date().toISOString();
      let item = r.id && list.find(x => x.id === r.id);
      if (!item) { item = { id: uuid(), clicks: 0, created_at: now, created_by: adminName }; list.push(item); }
      Object.assign(item, { path, destination: r.destination.trim(), label: r.label || null, updated_at: now });
      demoRedirectsWrite(list);
      return { id: item.id, path };
    },

    async deleteRedirect(name, code, id) {
      if (LIVE) {
        const r = await rpc("admin_delete_redirect", { p_name: name, p_code: code, p_id: id });
        if (r === null) throw notAuthorised();
        return r;
      }
      if (!demoCheck(name, code)) throw notAuthorised();
      demoRedirectsWrite(demoRedirects().filter(x => x.id !== id));
      return true;
    },

    /** Public: destination for a short link (counts a click), or null. */
    async resolveRedirect(path) {
      const clean = String(path || "").replace(/^\/+|\/+$/g, "");
      if (LIVE) return await rpc("resolve_redirect", { p_path: clean });
      const list = demoRedirects();
      const item = list.find(x => x.path.toLowerCase() === clean.toLowerCase());
      if (!item) return null;
      item.clicks = (item.clicks || 0) + 1;
      demoRedirectsWrite(list);
      return item.destination;
    },

    /** Public: documents marked as public, for the /documents page. */
    async listPublicDocuments() {
      if (LIVE) return (await rpc("list_public_documents", {})) || [];
      return demoDocs().filter(d => d.is_public).map(({ pdf_data, ...rest }) => rest);
    }
  };

  const REDIRECTS_KEY = "thornhill.demo.redirects";
  function demoRedirects() {
    try { return JSON.parse(localStorage.getItem(REDIRECTS_KEY)) || []; } catch (e) { return []; }
  }
  function demoRedirectsWrite(list) {
    try { localStorage.setItem(REDIRECTS_KEY, JSON.stringify(list)); } catch (e) {}
  }

  /* ---------- The three Thornhill websites ----------
     Worked out from the current address, e.g. on link-hub.thornhillcorporation.co.uk
     the main site is thornhillcorporation.co.uk. Override any of them in config.js. */
  window.ThornhillSites = {
    root() { return cfg.mainDomain || location.hostname.replace(/^(www|link-hub|redirects)\./i, ""); },
    main() { return (cfg.mainUrl || "https://" + this.root()).replace(/\/+$/, ""); },
    hub() { return (cfg.linkHubUrl || "https://link-hub." + this.root()).replace(/\/+$/, ""); },
    redirects() { return (cfg.redirectsUrl || "https://redirects." + this.root()).replace(/\/+$/, ""); }
  };

  const DOCS_KEY = "thornhill.demo.documents";
  function demoDocs() {
    try { return JSON.parse(localStorage.getItem(DOCS_KEY)) || []; } catch (e) { return []; }
  }
  function demoDocsWrite(list) {
    try { localStorage.setItem(DOCS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  window.ThornhillStore = Store;

  /* ---------- Document helpers shared by the admin panel and the viewer ---------- */
  window.ThornhillDocs = {
    /** Turn a title into a short link, e.g. "Staff Handbook 2026" -> "staff-handbook-2026" */
    slugify(s) {
      return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
        .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    },
    validSlug(s) { return /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(s); },

    /** Recognise Google Docs / Sheets / Slides / Forms / Drive links. Returns { type, label, embed } or null. */
    parseGoogle(raw) {
      let u;
      try { u = new URL(String(raw).trim()); } catch (e) { return null; }
      if (u.protocol !== "https:") return null;
      const host = u.hostname.replace(/^www\./, "");
      const id = (u.pathname.match(/\/d\/(e\/)?([a-zA-Z0-9_-]{10,})/) || [])[0];
      if (host === "docs.google.com" && id) {
        const kinds = [
          ["/document/", "Google Doc", "document"], ["/spreadsheets/", "Google Sheet", "spreadsheets"],
          ["/presentation/", "Google Slides", "presentation"], ["/forms/", "Google Form", "forms"]
        ];
        for (const [path, label, seg] of kinds) {
          if (u.pathname.startsWith(path)) {
            const isPublished = id.startsWith("/d/e/");
            let embed;
            if (seg === "forms") embed = "https://docs.google.com/forms" + id + "/viewform?embedded=true";
            else if (seg === "presentation") embed = "https://docs.google.com/presentation" + id + (isPublished ? "/embed" : "/embed?start=false&loop=false");
            else embed = "https://docs.google.com/" + seg + id + (isPublished ? "/pub?embedded=true" : "/preview");
            return { type: seg, label, embed };
          }
        }
      }
      if (host === "drive.google.com") {
        const fid = (u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) || [])[1] || u.searchParams.get("id");
        if (fid && /^[a-zA-Z0-9_-]{10,}$/.test(fid)) return { type: "drive", label: "Google Drive file", embed: "https://drive.google.com/file/d/" + fid + "/preview" };
      }
      return null;
    },

    /** The public Thornhill address for a short link */
    linkFor(slug) { return location.origin + "/d/" + slug; },

    formatSize(bytes) {
      if (!bytes) return "";
      return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
    }
  };
})();
