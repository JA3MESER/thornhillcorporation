/* ==========================================================================
   Thornhill Corporation — Emailing Centre (admin panel)
   Send and receive email from Thornhill addresses (shared, like support@,
   or personal, like john@). Sending and receiving go through the "email"
   Supabase Edge Function, which uses Resend.
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const UNDO_SECONDS = 5;
  const MAX_ATTACH = 7 * 1024 * 1024;

  const state = {
    overview: null, ready: false, setupError: null,
    folder: "inbox", mailbox: null, search: "",
    threads: [], total: 0, offset: 0,
    current: null,        // { threadId, messages, enquiry }
    compose: null,        // composer context
    attachments: [],
    pendingSend: null,
    recipientView: (() => { try { return localStorage.getItem("thornhill.email.recipientView") === "1"; } catch (e) { return false; } })()
  };

  const admin = () => window.ThornhillAdmin;
  const session = () => admin() && admin().session();
  const expired = () => admin() && admin().expire();
  const isAuth = e => e && e.status === 401;

  /* ======================================================================
     Formatting (same rules as the email function, for previews)
     ====================================================================== */
  function formatBody(src) {
    const inline = t => {
      let h = esc(t);
      h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => `<a href="${u}" style="color:#2563eb">${a}</a>`);
      h = h.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m, p, u) => `${p}<a href="${u}" style="color:#2563eb">${u}</a>`);
      h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      return h;
    };
    return String(src || "").replace(/\r\n/g, "\n").split(/\n{2,}/).map(b => {
      const lines = b.split("\n");
      if (lines.every(l => /^\s*>/.test(l))) {
        return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 14px;border-left:3px solid #d0d7e2;color:#5b6475">${formatBody(lines.map(l => l.replace(/^\s*>\s?/, "")).join("\n"))}</blockquote>`;
      }
      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) {
        return `<ul style="margin:0 0 16px;padding-left:22px">${lines.map(l => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p style="margin:0 0 16px">${lines.map(inline).join("<br>")}</p>`;
    }).join("");
  }

  function brandedHtml(body, signature, siteUrl, reference) {
    const site = String(siteUrl || location.origin).replace(/\/+$/, "");
    const sig = signature ? `<div style="margin-top:8px;padding-top:16px;border-top:1px solid #e6eaf0;color:#4a5263;font-size:14px">${formatBody(signature)}</div>` : "";
    const ref = reference ? `<p style="margin:0 0 6px;color:#7a8396;font-size:12px">Reference: <strong>${esc(reference)}</strong> — please keep this in the subject line when you reply.</p>` : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f1f4f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0b0d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="background:#07090e;border-radius:16px 16px 0 0;padding:22px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px"><img src="${esc(site)}/assets/img/icon-dark-96.png" width="40" height="40" alt="" style="display:block;border-radius:10px"></td>
<td style="color:#ffffff;font-size:17px;font-weight:700">Thornhill<br><span style="color:#7a8396;font-size:10px;font-weight:600;letter-spacing:0.18em">CORPORATION</span></td></tr></table></td></tr>
<tr><td style="background:#2563eb;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td style="background:#ffffff;padding:32px 28px 24px;font-size:15px;line-height:1.65;color:#1f2430">${formatBody(body)}${sig}</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:0 28px 26px">${ref}</td></tr>
<tr><td style="padding:18px 28px;text-align:center;color:#7a8396;font-size:12px;line-height:1.6"><span style="color:#2563eb;font-weight:600">${esc(site.replace(/^https?:\/\//, ""))}</span><br>Copyright © 2026 Thornhill Corporation. All Rights Reserved. Thornhill owns the right to this material.</td></tr>
</table></td></tr></table></body></html>`;
  }

  const fill = (text, vars) => String(text || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m));
  const initials = n => String(n || "?").replace(/@.*/, "").trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(p => p[0]).join("").toUpperCase() || "?";
  const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";
  const fmtSize = b => !b ? "" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  function when(iso, long) {
    const d = new Date(iso);
    if (long) return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (today - d < 6 * 86400000) return d.toLocaleDateString("en-GB", { weekday: "short" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
  const STATUS = {
    sent: ["Sent", "s-sent"], delivered: ["Delivered", "s-ok"], delivery_delayed: ["Delayed", "s-warn"],
    bounced: ["Bounced", "s-bad"], complained: ["Marked as spam", "s-bad"], failed: ["Failed", "s-bad"], received: ["Received", "s-sent"]
  };
  function statusPill(m) {
    if (m.direction !== "out") return "";
    if (m.opened_at && !["bounced", "complained", "failed"].includes(m.status)) return `<span class="mstatus s-ok" title="Opened ${esc(when(m.opened_at, true))}">✓✓ Opened</span>`;
    const [label, cls] = STATUS[m.status] || [m.status, "s-sent"];
    return `<span class="mstatus ${cls}">${esc(label)}</span>`;
  }

  const myMailboxes = () => (state.overview ? state.overview.mailboxes.filter(m => m.can_use) : []);
  const defaultMailbox = () => { const mine = myMailboxes(); return mine.find(m => m.is_default) || mine.find(m => m.kind === "shared") || mine[0] || null; };
  const ourAddresses = () => new Set((state.overview ? state.overview.mailboxes : []).map(m => m.address.toLowerCase()));

  function friendly(e) {
    const m = (e && e.message) || "";
    if (/admin_email_overview|admin_list_threads|function .* does not exist|schema cache/i.test(m)) return "SETUP_SQL";
    return m || "Something went wrong.";
  }

  /* ======================================================================
     Loading
     ====================================================================== */
  async function loadOverview() {
    const s = session();
    if (!s) return;
    try {
      state.overview = await Store.emailOverview(s.name, s.code);
      state.ready = true; state.setupError = null;
    } catch (e) {
      if (isAuth(e)) return expired();
      state.ready = false; state.setupError = friendly(e);
    }
    renderShell();
  }

  function renderShell() {
    const setup = $("#mailSetup"), shell = $("#mailShell");
    const badge = $("#mailBadge");
    if (!state.ready) {
      shell.hidden = true; setup.hidden = false; badge.hidden = true;
      setup.innerHTML = state.setupError === "SETUP_SQL"
        ? setupCard("Finish setting up the Emailing Centre", "The email tables aren't in your database yet. In Supabase → SQL Editor, run <code>supabase/email.sql</code> (the README has the full steps), then refresh this page.")
        : setupCard("The Emailing Centre isn't available", esc(state.setupError || "Connect Supabase to use email."));
      return;
    }
    const o = state.overview;
    if (!o.mailboxes.length) {
      shell.hidden = true; setup.hidden = false;
      setup.innerHTML = setupCard("Create your first email address",
        `Start with a shared address like <b>support@${esc(o.settings.domain)}</b> for answering enquiries. You can add personal addresses (like <b>${esc(suggestLocal(o.me))}@${esc(o.settings.domain)}</b>) too.`,
        `<button class="btn btn-primary" type="button" data-first-mailbox>Create support@${esc(o.settings.domain)}</button>
         <button class="btn btn-ghost" type="button" data-open-settings>Settings &amp; setup</button>`);
      setup.querySelector("[data-first-mailbox]").addEventListener("click", () => openManage("mailboxes", { address: "support", display_name: "Thornhill Support", kind: "shared", is_default: true, signature: "The Support Team\n**Thornhill Corporation**" }));
      setup.querySelector("[data-open-settings]").addEventListener("click", () => openManage("settings"));
      return;
    }
    shell.hidden = false; setup.hidden = true;
    updateRvButton();
    const n = o.unread_total || 0;
    badge.textContent = n; badge.hidden = !n;
    $("#cntInbox").textContent = n || "";
    renderMailboxNav();
  }

  function setupCard(title, text, actions) {
    return `<div class="setup-card"><div class="setup-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg></div>
      <h2>${title}</h2><p>${text}</p><div class="row">${actions || ""}</div></div>`;
  }
  const suggestLocal = name => String(name || "me").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "").trim().replace(/\s+/g, "") || "me";

  function renderMailboxNav() {
    const o = state.overview, nav = $("#mbNav");
    const rows = [`<button type="button" data-mb="" class="${!state.mailbox ? "active" : ""}"><span class="dot all"></span>All mailboxes</button>`];
    o.mailboxes.filter(m => m.can_use).forEach(m => {
      rows.push(`<button type="button" data-mb="${esc(m.id)}" class="${state.mailbox === m.id ? "active" : ""}" title="${esc(m.address)}">
        <span class="dot ${m.kind}"></span><span class="mb-name">${esc(m.address.split("@")[0])}@</span>${m.unread ? `<span class="n">${m.unread}</span>` : ""}</button>`);
    });
    rows.push(`<button type="button" data-mb="unrouted" class="${state.mailbox === "unrouted" ? "active" : ""}" title="Email sent to an address that isn't set up"><span class="dot other"></span>Other addresses${o.unrouted_unread ? `<span class="n">${o.unrouted_unread}</span>` : ""}</button>`);
    nav.innerHTML = rows.join("");
  }

  async function loadThreads(append) {
    const s = session();
    if (!s || !state.ready) return;
    const list = $("#threadList");
    if (!append) { state.offset = 0; list.innerHTML = '<div class="empty small"><div class="spinner-sm"></div>Loading…</div>'; }
    try {
      const r = await Store.listThreads(s.name, s.code, { folder: state.folder, mailbox: state.mailbox, search: state.search, limit: 50, offset: state.offset });
      state.threads = append ? state.threads.concat(r.items) : r.items;
      state.total = r.total;
      state.offset = state.threads.length;
      renderThreads();
    } catch (e) {
      if (isAuth(e)) return expired();
      list.innerHTML = `<div class="empty small"><strong>Couldn't load email</strong>${esc(friendly(e))}</div>`;
    }
  }

  function renderThreads() {
    const list = $("#threadList");
    $("#mailMore").hidden = state.threads.length >= state.total;
    if (!state.threads.length) {
      const msg = state.search ? "No email matches your search." : { inbox: "Your inbox is empty.", sent: "Nothing sent yet.", starred: "No starred conversations.", archive: "Nothing archived." }[state.folder] || "Nothing here.";
      list.innerHTML = `<div class="empty small"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/></svg>${msg}</div>`;
      return;
    }
    list.innerHTML = state.threads.map(t => {
      const outgoing = t.last_direction === "out";
      const who = outgoing ? "To: " + (t.to_addresses || []).join(", ") : (t.from_name || t.from_address);
      return `<button type="button" class="thread ${t.unread ? "unread" : ""} ${state.current && state.current.threadId === t.thread_id ? "selected" : ""}" data-thread="${esc(t.thread_id)}">
        <div class="t-top"><span class="t-who">${esc(who)}</span>${t.message_count > 1 ? `<span class="t-count">${t.message_count}</span>` : ""}<span class="t-time">${esc(when(t.last_at))}</span></div>
        <div class="t-subj">${t.starred ? '<span class="t-star">★</span>' : ""}${esc(t.subject || "(no subject)")}</div>
        <div class="t-snip">${esc(t.snippet || "")}</div>
        <div class="t-tags">${t.enquiry_reference ? `<span class="tag-ref">${esc(t.enquiry_reference)}</span>` : ""}${outgoing ? statusPill({ direction: "out", status: t.last_status, opened_at: t.last_opened }) : ""}</div>
      </button>`;
    }).join("");
  }

  /* ======================================================================
     Reading a conversation
     ====================================================================== */
  async function openThread(threadId) {
    const s = session();
    if (!s) return;
    const pane = $("#mailRead");
    pane.classList.add("open");
    pane.innerHTML = '<div class="empty"><div class="spinner-sm"></div>Opening…</div>';
    try {
      const r = await Store.getThread(s.name, s.code, threadId);
      state.current = { threadId, messages: r.messages || [], enquiry: r.enquiry };
      renderThreadPane();
      const t = state.threads.find(x => x.thread_id === threadId);
      if (t && t.unread) { t.unread = 0; renderThreads(); loadOverview(); }
      else document.querySelectorAll(".thread").forEach(el => el.classList.toggle("selected", el.dataset.thread === threadId));
    } catch (e) {
      if (isAuth(e)) return expired();
      pane.innerHTML = `<div class="empty"><strong>Couldn't open this conversation</strong>${esc(friendly(e))}</div>`;
    }
  }

  function renderThreadPane() {
    const c = state.current, pane = $("#mailRead");
    if (!c || !c.messages.length) {
      pane.innerHTML = '<div class="empty"><strong>This conversation is empty</strong>It may have been deleted.</div>';
      return;
    }
    const last = c.messages[c.messages.length - 1];
    const starred = c.messages.some(m => m.is_starred), archived = c.messages.every(m => m.is_archived);
    const mbName = id => { const m = state.overview.mailboxes.find(x => x.id === id); return m ? m.address : "an address that isn't set up"; };

    pane.innerHTML = `
      <div class="read-head">
        <button class="btn btn-ghost btn-sm read-back" type="button" data-act="back">← Back</button>
        <h2>${esc(last.subject || "(no subject)")}</h2>
        <div class="read-meta">
          ${c.enquiry ? `<button type="button" class="tag-ref big" data-act="enquiry" title="Open enquiry">Enquiry ${esc(c.enquiry.reference)} · ${esc(c.enquiry.status.replace("_", " "))}</button>` : ""}
          <span class="read-box">via ${esc(mbName(last.mailbox_id))}</span>
        </div>
        <div class="read-actions">
          <button class="btn btn-primary btn-sm" type="button" data-act="reply">Reply</button>
          <button class="btn btn-ghost btn-sm" type="button" data-act="replyall">Reply all</button>
          <button class="btn btn-ghost btn-sm" type="button" data-act="forward">Forward</button>
          <span class="spacer"></span>
          <button class="icon-btn" type="button" data-act="${starred ? "unstar" : "star"}" title="${starred ? "Unstar" : "Star"}" aria-label="${starred ? "Unstar" : "Star"}"><span class="${starred ? "star-on" : ""}">★</span></button>
          <button class="icon-btn" type="button" data-act="${archived ? "unarchive" : "archive"}" title="${archived ? "Move to inbox" : "Archive"}" aria-label="${archived ? "Move to inbox" : "Archive"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/></svg></button>
          <button class="icon-btn" type="button" data-act="unread" title="Mark as unread" aria-label="Mark as unread"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg></button>
          <button class="icon-btn danger" type="button" data-act="delete" title="Delete conversation" aria-label="Delete conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
        </div>
      </div>
      <div class="msgs">${c.messages.map((m, i) => messageHtml(m, i === c.messages.length - 1 || (m.direction === "in" && !m.is_read))).join("")}</div>
      <div class="quick-reply"><button type="button" data-act="reply">Reply to ${esc(last.direction === "in" ? (last.from_name || last.from_address) : (last.to_addresses || []).join(", "))}…</button></div>`;

    pane.querySelectorAll(".msg-html").forEach(f => {
      const m = c.messages.find(x => x.id === f.dataset.id);
      // Received email is shown in a locked-down frame: no scripts, links open in a new tab
      if (m.direction === "out") {
        f.srcdoc = m.body_html.replace("<head>", '<head><base target="_blank">') + "<!-- " + Date.now() + " -->";
        f.addEventListener("load", () => { try { f.style.height = Math.min(4000, f.contentDocument.documentElement.scrollHeight + 4) + "px"; } catch (e) { f.style.height = "640px"; } });
        return;
      }
      f.srcdoc = `<!DOCTYPE html><html><head><base target="_blank"><meta charset="utf-8"><style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1f2430;word-wrap:break-word}img{max-width:100%;height:auto}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:3px solid #d0d7e2;color:#5b6475}</style></head><body>${m.body_html}</body></html>`;
      f.addEventListener("load", () => {
        try {
          const b = f.contentDocument.body;
          f.style.height = Math.min(4000, Math.ceil(b.getBoundingClientRect().height) + 16) + "px";
          // Re-measure once images have loaded
          [...b.querySelectorAll("img")].forEach(img => img.addEventListener("load", () => { f.style.height = Math.min(4000, Math.ceil(b.getBoundingClientRect().height) + 16) + "px"; }));
        } catch (e) { f.style.height = "480px"; }
      });
    });
    pane.scrollTop = 0;
  }

  function messageHtml(m, expanded) {
    const name = m.direction === "out" ? (m.from_name || m.from_address) : (m.from_name || m.from_address);
    const to = (m.to_addresses || []).join(", ");
    const cc = (m.cc_addresses || []).join(", ");
    const by = m.direction === "out" && m.sent_by ? ` · sent by ${esc(m.sent_by)}` : "";
    let body;
    if (m.direction === "in" && m.body_html) body = `<iframe class="msg-html" data-id="${esc(m.id)}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Email from ${esc(name)}"></iframe>`;
    else if (m.direction === "out" && state.recipientView && m.body_html) body = `<div class="rv-note">As ${esc((m.to_addresses || [])[0] || "the recipient")} received it</div><iframe class="msg-html out" data-id="${esc(m.id)}" sandbox="allow-same-origin" title="Email as received"></iframe>`;
    else if (m.direction === "out") body = `<div class="msg-text fmt">${formatBody(m.body_text || "")}</div>`;
    else body = `<div class="msg-text plain">${esc(m.body_text || "")}</div>`;
    const atts = (m.attachments || []).length ? `<div class="msg-atts">${m.attachments.map(a => `<span class="att">📎 ${esc(a.filename)}${a.size ? " · " + fmtSize(a.size) : ""}</span>`).join("")}</div>` : "";
    return `<article class="msg ${m.direction} ${expanded ? "open" : ""}" data-msg="${esc(m.id)}">
      <header class="msg-head" data-act="toggle">
        <div class="avatar ${m.direction}">${esc(initials(name))}</div>
        <div class="msg-from">
          <strong>${esc(name)}</strong> <span class="addr">&lt;${esc(m.from_address)}&gt;</span>${m.kind === "ack" ? ' <span class="mini-tag">Automatic</span>' : ""}
          <div class="msg-to">to ${esc(to)}${cc ? ", cc " + esc(cc) : ""}${by}</div>
          <div class="msg-snip">${esc((m.body_text || "").replace(/\s+/g, " ").slice(0, 120))}</div>
        </div>
        <div class="msg-right">${statusPill(m)}<time>${esc(when(m.created_at, true))}</time></div>
      </header>
      <div class="msg-body">${m.error ? `<div class="form-error show">${esc(m.error)}</div>` : ""}${body}${atts}</div>
    </article>`;
  }

  $("#mailRead").addEventListener("click", async e => {
    const el = e.target.closest("[data-act]");
    if (!el || !state.current) return;
    const act = el.dataset.act, c = state.current;
    const last = c.messages[c.messages.length - 1];
    if (act === "toggle") { el.closest(".msg").classList.toggle("open"); return; }
    if (act === "back") { $("#mailRead").classList.remove("open"); return; }
    if (act === "enquiry" && c.enquiry) { admin().openEnquiry(c.enquiry.id); return; }
    if (act === "reply" || act === "replyall") return openComposer(replyContext(last, act === "replyall"));
    if (act === "forward") return openComposer(forwardContext(last));
    if (act === "delete") return confirmBox("Delete this conversation?", "Every message in it is deleted for every admin. This can't be undone.", () => threadAction("delete"));
    threadAction(act);
  });

  async function threadAction(action) {
    const s = session(), c = state.current;
    if (!s || !c) return;
    try {
      await Store.threadAction(s.name, s.code, [c.threadId], action);
      const msg = { star: "Starred", unstar: "Star removed", archive: "Archived", unarchive: "Moved to inbox", unread: "Marked as unread", delete: "Conversation deleted" }[action];
      if (msg) window.toast(msg);
      if (["archive", "unarchive", "unread", "delete"].includes(action)) {
        state.current = null;
        $("#mailRead").classList.remove("open");
        $("#mailRead").innerHTML = '<div class="empty"><strong>No conversation selected</strong>Choose an email from the list, or click Compose.</div>';
      } else {
        await openThread(c.threadId);
      }
      loadThreads(); loadOverview();
    } catch (e) {
      if (isAuth(e)) return expired();
      window.toast(friendly(e), "error");
    }
  }

  /* ======================================================================
     Composer
     ====================================================================== */
  function quoteOf(m) {
    const who = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
    const text = String(m.body_text || "").split("\n").slice(0, 40).map(l => "> " + l).join("\n");
    return `\n\n> On ${when(m.created_at, true)}, ${who} wrote:\n${text}`;
  }
  // "Re: Re: RE: Subject" → "Re: Subject"
  const reSubject = s => "Re: " + String(s || "").replace(/^\s*((re|aw|sv)\s*:\s*)+/i, "");

  function replyContext(m, all) {
    const ours = ourAddresses();
    let to, cc = [];
    if (m.direction === "in") {
      to = [m.from_address];
      if (all) cc = [...(m.to_addresses || []), ...(m.cc_addresses || [])].filter(a => !ours.has(a.toLowerCase()) && a !== m.from_address);
    } else {
      to = m.to_addresses || [];
      if (all) cc = (m.cc_addresses || []).filter(a => !ours.has(a.toLowerCase()));
    }
    const mb = myMailboxes().find(x => x.id === m.mailbox_id) || defaultMailbox();
    return {
      title: all ? "Reply all" : "Reply", mailboxId: mb && mb.id, to, cc, subject: reSubject(m.subject),
      body: "", quote: quoteOf(m), threadId: m.thread_id, replyToId: m.id,
      enquiry: state.current && state.current.enquiry, recipientName: m.direction === "in" ? m.from_name : ""
    };
  }

  function forwardContext(m) {
    const mb = myMailboxes().find(x => x.id === m.mailbox_id) || defaultMailbox();
    const head = `\n\n---------- Forwarded message ----------\nFrom: ${m.from_name ? m.from_name + " <" + m.from_address + ">" : m.from_address}\nDate: ${when(m.created_at, true)}\nSubject: ${m.subject || ""}\nTo: ${(m.to_addresses || []).join(", ")}\n\n`;
    return { title: "Forward", mailboxId: mb && mb.id, to: [], subject: /^\s*fwd?\s*:/i.test(m.subject || "") ? m.subject : "Fwd: " + (m.subject || ""), body: head + (m.body_text || "") };
  }

  function composeForEnquiry(q) {
    const mb = defaultMailbox();
    const tpl = state.overview && state.overview.templates.find(t => /enquiry reply/i.test(t.name));
    const subj = `Re: ${q.subject} [${q.reference}]`;
    const ctx = {
      title: "Reply to " + q.full_name, mailboxId: mb && mb.id, to: [q.email], subject: subj,
      enquiry: { id: q.id, reference: q.reference, full_name: q.full_name, email: q.email, subject: q.subject, status: q.status },
      body: "", recipientName: q.full_name,
      quote: `\n\n> ${q.full_name} wrote on ${when(q.created_at, true)}:\n` + String(q.message).split("\n").map(l => "> " + l).join("\n")
    };
    open();
    async function open() {
      if (!state.ready) await loadOverview();
      if (!state.ready || !myMailboxes().length) {
        admin().showView("email");
        window.toast(state.ready ? "Create an email address first, e.g. support@." : "Finish setting up the Emailing Centre first.", "error");
        return;
      }
      const mb2 = defaultMailbox();
      ctx.mailboxId = mb2.id;
      ctx.body = tpl ? fill(tpl.body, varsFor(ctx, mb2)) : `Hi ${firstName(q.full_name)},\n\n`;
      // Continue the existing conversation for this enquiry, if there is one
      try {
        const s = session();
        const h = await Store.enquiryEmails(s.name, s.code, q.id);
        const lastMsg = (h.items || []).slice(-1)[0];
        if (lastMsg) { ctx.threadId = lastMsg.thread_id; if (lastMsg.direction === "in") ctx.replyToId = lastMsg.id; }
      } catch (e) {}
      openComposer(ctx);
    }
  }

  function varsFor(ctx, mb) {
    const s = session() || {};
    const q = ctx.enquiry || {};
    const recip = ctx.recipientName || q.full_name || "";
    return {
      first_name: firstName(recip) || "there", name: recip || "there", reference: q.reference || "",
      enquiry_subject: q.subject || "", subject: q.subject || "", email: (ctx.to || [])[0] || "",
      admin_name: s.display || "", admin_first_name: firstName(s.display), mailbox: mb ? mb.address : ""
    };
  }

  function openComposer(ctx) {
    if (!state.ready) { window.toast("The Emailing Centre isn't set up yet.", "error"); return; }
    const mine = myMailboxes();
    if (!mine.length) { openManage("mailboxes"); window.toast("Create an email address to send from first."); return; }
    state.compose = Object.assign({ title: "New email", to: [], cc: [], bcc: [], subject: "", body: "" }, ctx || {});
    state.attachments = [];
    const c = state.compose;
    $("#composerTitle").textContent = c.title;
    $("#cFrom").innerHTML = mine.map(m => `<option value="${esc(m.id)}">${esc(m.display_name)} &lt;${esc(m.address)}&gt;${m.kind === "personal" ? " — personal" : ""}</option>`).join("");
    $("#cFrom").value = c.mailboxId && mine.some(m => m.id === c.mailboxId) ? c.mailboxId : defaultMailbox().id;
    $("#cTo").value = (c.to || []).join(", ");
    $("#cCc").value = (c.cc || []).join(", ");
    $("#cBcc").value = (c.bcc || []).join(", ");
    $("#cCcRow").hidden = $("#cBccRow").hidden = !(c.cc && c.cc.length) && !(c.bcc && c.bcc.length);
    $("#cSubject").value = c.subject || "";
    $("#cBody").value = c.body || "";
    // Replies start fresh; tick "Include previous messages" to quote the conversation underneath
    const hasQuote = !!(c.quote && c.quote.trim());
    $("#cQuoteRow").hidden = !hasQuote;
    $("#cQuote").checked = hasQuote && (c.includeQuote != null ? c.includeQuote : quotePref());
    $("#cQuoteText").textContent = hasQuote ? c.quote.trim().split("\n").map(l => l.replace(/^> ?/, "")).join("\n") : "";
    $("#cQuoteBox").hidden = !$("#cQuote").checked;
    $("#cSig").checked = true;
    $("#cTemplate").innerHTML = '<option value="">Insert template…</option>' + state.overview.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    const enq = $("#composerEnquiry"), st = $("#cStatus");
    if (c.enquiry) {
      enq.hidden = false;
      enq.innerHTML = `<span class="tag-ref">${esc(c.enquiry.reference)}</span> Replying to <b>${esc(c.enquiry.full_name)}</b>'s enquiry “${esc(c.enquiry.subject)}”. This email will be saved with the enquiry.`;
      st.hidden = false; st.value = "in_progress";
    } else { enq.hidden = true; st.hidden = true; }
    $("#composerError").classList.remove("show");
    renderAttachments();
    $("#composerWrap").hidden = false;
    document.body.classList.add("composing");
    applyRecipientView(); updateRvButton();
    setTimeout(() => {
      const to = $("#cTo");
      if (!to.value) to.focus();
      else { const b = $("#cBody"); b.focus(); b.setSelectionRange(0, 0); b.scrollTop = 0; }
    }, 30);
  }

  function composerDirty() {
    return !$("#composerWrap").hidden && ($("#cBody").value.trim() || state.attachments.length) &&
      ($("#cBody").value !== (state.compose && state.compose.body) || state.attachments.length);
  }
  function closeComposer(force) {
    if (!force && composerDirty() && !window.confirm("Discard this email?")) return;
    $("#composerWrap").hidden = true;
    document.body.classList.remove("composing");
    state.compose = null; state.attachments = [];
    updateRvButton();
  }
  $("#composerClose").addEventListener("click", () => closeComposer());
  $("#composerDiscard").addEventListener("click", () => closeComposer());
  $("#cCcToggle").addEventListener("click", () => { $("#cCcRow").hidden = $("#cBccRow").hidden = false; $("#cCc").focus(); });
  $("#composeBtn").addEventListener("click", () => openComposer({}));

  // Formatting buttons (they add simple markers that become bold/italic/links in the sent email)
  function wrapSel(before, after, placeholder) {
    const t = $("#cBody"), a = t.selectionStart, b = t.selectionEnd;
    const sel = t.value.slice(a, b) || placeholder;
    t.setRangeText(before + sel + after, a, b, "end");
    t.setSelectionRange(a + before.length, a + before.length + sel.length);
    t.focus();
  }
  document.querySelectorAll(".composer-toolbar [data-fmt]").forEach(btn => btn.addEventListener("click", () => {
    const f = btn.dataset.fmt, t = $("#cBody");
    if (f === "bold") wrapSel("**", "**", "bold text");
    if (f === "italic") wrapSel("*", "*", "italic text");
    if (f === "link") {
      const url = window.prompt("Link address (https://…)", "https://");
      if (url && /^https?:\/\/\S+$/i.test(url)) wrapSel("[", "](" + url + ")", "link text");
    }
    if (f === "list") {
      const a = t.selectionStart, b = t.selectionEnd;
      const start = t.value.lastIndexOf("\n", a - 1) + 1;
      const block = t.value.slice(start, b) || "";
      const out = (block || "List item").split("\n").map(l => /^\s*[-*•]\s+/.test(l) ? l : "- " + l).join("\n");
      t.setRangeText(out, start, Math.max(b, start), "end"); t.focus();
    }
  }));
  $("#cBody").addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); wrapSel("**", "**", "bold text"); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") { e.preventDefault(); wrapSel("*", "*", "italic text"); }
  });
  document.addEventListener("keydown", e => {
    if ($("#composerWrap").hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.key === "Escape" && !$("#mailConfirm").classList.contains("open")) closeComposer();
  });

  // Templates
  $("#cTemplate").addEventListener("change", () => {
    const t = state.overview.templates.find(x => x.id === $("#cTemplate").value);
    $("#cTemplate").value = "";
    if (!t) return;
    const mb = state.overview.mailboxes.find(m => m.id === $("#cFrom").value);
    const vars = varsFor(Object.assign({}, state.compose, { to: splitAddrs($("#cTo").value) }), mb);
    const text = fill(t.body, vars);
    const body = $("#cBody");
    const quoteAt = body.value.search(/\n\n> /);
    if (quoteAt >= 0 && !body.value.slice(0, quoteAt).trim()) body.value = text + body.value.slice(quoteAt);
    else if (!body.value.trim()) body.value = text;
    else body.setRangeText(text, body.selectionStart, body.selectionEnd, "end");
    if (t.subject && !$("#cSubject").value.trim()) $("#cSubject").value = fill(t.subject, vars);
    body.focus(); schedulePreview();
  });

  // Attachments
  $("#cFiles").addEventListener("change", async () => {
    const files = [...$("#cFiles").files];
    $("#cFiles").value = "";
    for (const f of files) {
      const total = state.attachments.reduce((n, a) => n + a.size, 0) + f.size;
      if (total > MAX_ATTACH) { window.toast("Attachments can be up to 7 MB in total.", "error"); break; }
      const content = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
      state.attachments.push({ filename: f.name, size: f.size, content });
    }
    renderAttachments();
  });
  function renderAttachments() {
    $("#cAttachList").innerHTML = state.attachments.map((a, i) => `<span class="att">📎 ${esc(a.filename)} · ${fmtSize(a.size)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(a.filename)}">×</button></span>`).join("");
  }
  $("#cAttachList").addEventListener("click", e => {
    const b = e.target.closest("[data-rm]");
    if (b) { state.attachments.splice(+b.dataset.rm, 1); renderAttachments(); }
  });

  /* ---------- Recipient view (live preview beside the editor) ---------- */
  let previewTimer = null;
  function renderPreview() {
    if (!state.recipientView || $("#composerWrap").hidden || !state.overview) return;
    const f = $("#cPreview");
    const mb = state.overview.mailboxes.find(m => m.id === $("#cFrom").value);
    const ref = ($("#cSubject").value.match(/TH-[A-Z0-9]{6}/i) || [])[0];
    let y = 0;
    try { y = f.contentWindow.scrollY; } catch (e) {}
    // A unique marker forces the frame to redraw every time (fixes the blank preview when toggled)
    f.srcdoc = brandedHtml(fullBody(), $("#cSig").checked && mb ? mb.signature : null, state.overview.settings.site_url, ref ? ref.toUpperCase() : null) + "<!-- " + Date.now() + " -->";
    f.onload = () => { try { f.contentWindow.scrollTo(0, y); } catch (e) {} };
  }
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 200); };
  ["#cBody", "#cSubject"].forEach(sel => $(sel).addEventListener("input", schedulePreview));
  ["#cFrom", "#cSig"].forEach(sel => $(sel).addEventListener("change", schedulePreview));

  function applyRecipientView() {
    const on = state.recipientView;
    document.body.classList.toggle("rv-on", on);
    $("#rvState").textContent = on ? "On" : "Off";
    $("#rvToggle").setAttribute("aria-pressed", on);
    $("#composerPreviewBtn").classList.toggle("on", on);
    $("#composerPreviewBtn").setAttribute("aria-pressed", on);
    document.querySelector(".composer").classList.toggle("split", on);
    $("#cPreviewWrap").hidden = !on;
    if (on) renderPreview();
    if (state.current) renderThreadPane();
  }
  function setRecipientView(on) {
    state.recipientView = on;
    try { localStorage.setItem("thornhill.email.recipientView", on ? "1" : "0"); } catch (e) {}
    applyRecipientView();
    window.toast(on ? "Recipient view on — you'll see emails exactly as they arrive" : "Recipient view off");
  }
  $("#rvToggle").addEventListener("click", () => setRecipientView(!state.recipientView));
  $("#composerPreviewBtn").addEventListener("click", () => setRecipientView(!state.recipientView));
  // The side button shows whenever the Emailing Centre or the composer is open
  function updateRvButton() {
    const show = (!$("#emailView").hidden && state.ready) || !$("#composerWrap").hidden;
    $("#rvToggle").hidden = !show;
  }
  document.addEventListener("thornhill:view", () => setTimeout(updateRvButton, 0));
  applyRecipientView();

  /* ---------- Previous messages: include or start fresh ---------- */
  const QUOTE_KEY = "thornhill.email.includeQuote";
  function quotePref() { try { return localStorage.getItem(QUOTE_KEY) === "1"; } catch (e) { return false; } }
  function fullBody() {
    const typed = $("#cBody").value.replace(/\s+$/, "");
    const c = state.compose;
    return c && c.quote && $("#cQuote").checked ? typed + "\n\n" + c.quote.trim() : typed;
  }
  $("#cQuote").addEventListener("change", () => {
    $("#cQuoteBox").hidden = !$("#cQuote").checked;
    try { localStorage.setItem(QUOTE_KEY, $("#cQuote").checked ? "1" : "0"); } catch (e) {}
    schedulePreview();
  });

  const splitAddrs = v => String(v || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
  const bare = a => a.replace(/^.*<([^>]+)>$/, "$1").trim();

  // Send — with a short "Undo" window
  function send() {
    const err = $("#composerError");
    err.classList.remove("show");
    const to = splitAddrs($("#cTo").value), cc = splitAddrs($("#cCc").value), bcc = splitAddrs($("#cBcc").value);
    const bad = [...to, ...cc, ...bcc].filter(a => !EMAIL_RE.test(bare(a)));
    const showErr = m => { err.textContent = m; err.classList.add("show"); };
    if (!to.length) return showErr("Add at least one recipient.");
    if (bad.length) return showErr("Check these addresses: " + bad.join(", "));
    if (!$("#cSubject").value.trim()) return showErr("Add a subject.");
    if (!$("#cBody").value.trim()) return showErr("Write a message before sending.");

    const c = state.compose;
    const payload = {
      action: "send", mailbox_id: $("#cFrom").value, to, cc, bcc,
      subject: $("#cSubject").value.trim(), body: fullBody(), include_signature: $("#cSig").checked,
      attachments: state.attachments.slice(), thread_id: c.threadId || null, reply_to_id: c.replyToId || null,
      enquiry_id: c.enquiry ? c.enquiry.id : null, set_enquiry_status: c.enquiry ? ($("#cStatus").value || null) : null
    };
    const snapshot = Object.assign({}, c, { to, cc, bcc, subject: payload.subject, body: $("#cBody").value, includeQuote: $("#cQuote").checked, mailboxId: payload.mailbox_id });
    const attSnap = state.attachments.slice();
    closeComposer(true);
    undoToast(payload, snapshot, attSnap);
  }
  $("#composerSend").addEventListener("click", send);

  function undoToast(payload, snapshot, attSnap) {
    let left = UNDO_SECONDS, cancelled = false;
    const bar = document.createElement("div");
    bar.className = "send-bar";
    bar.innerHTML = `<span>Sending in <b>${left}</b>s…</span><button type="button">Undo</button>`;
    document.body.appendChild(bar);
    const tick = setInterval(() => { left--; bar.querySelector("b").textContent = left; if (left <= 0) go(); }, 1000);
    bar.querySelector("button").addEventListener("click", () => {
      cancelled = true; clearInterval(tick); bar.remove();
      openComposer(snapshot); state.attachments = attSnap; renderAttachments();
    });
    async function go() {
      clearInterval(tick);
      if (cancelled) return;
      bar.innerHTML = "<span>Sending…</span>";
      const s = session();
      try {
        const r = await Store.emailFunction(Object.assign({ name: s.name, code: s.code }, payload));
        bar.remove();
        window.toast("Email sent");
        if (payload.enquiry_id && admin().refreshEnquiries) admin().refreshEnquiries();
        loadOverview().then(() => loadThreads());
        if (r.email && state.current && state.current.threadId === r.email.thread_id) openThread(r.email.thread_id);
        document.dispatchEvent(new CustomEvent("thornhill:email-sent", { detail: r.email }));
      } catch (e) {
        bar.remove();
        if (isAuth(e)) return expired();
        openComposer(snapshot); state.attachments = attSnap; renderAttachments();
        const err = $("#composerError"); err.textContent = "Not sent: " + friendly(e); err.classList.add("show");
      }
    }
  }

  /* ======================================================================
     Navigation
     ====================================================================== */
  const FOLDER_TITLES = { inbox: "Inbox", sent: "Sent", starred: "Starred", archive: "Archive" };
  document.querySelectorAll(".mail-folders [data-folder]").forEach(b => b.addEventListener("click", () => {
    state.folder = b.dataset.folder;
    document.querySelectorAll(".mail-folders [data-folder]").forEach(x => x.classList.toggle("active", x === b));
    updateTitle(); loadThreads();
  }));
  $("#mbNav").addEventListener("click", e => {
    const b = e.target.closest("[data-mb]");
    if (!b) return;
    state.mailbox = b.dataset.mb || null;
    renderMailboxNav(); updateTitle(); loadThreads();
  });
  function updateTitle() {
    let t = FOLDER_TITLES[state.folder];
    if (state.mailbox === "unrouted") t += " · other addresses";
    else if (state.mailbox) { const m = state.overview.mailboxes.find(x => x.id === state.mailbox); if (m) t += " · " + m.address.split("@")[0] + "@"; }
    $("#mailFolderTitle").textContent = t;
  }
  let searchTimer;
  $("#mailSearch").addEventListener("input", e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadThreads(); }, 300); });
  $("#mailRefresh").addEventListener("click", async () => { await loadOverview(); await loadThreads(); window.toast("Up to date"); });
  $("#mailMore").addEventListener("click", () => loadThreads(true));
  $("#threadList").addEventListener("click", e => { const t = e.target.closest("[data-thread]"); if (t) openThread(t.dataset.thread); });
  document.querySelectorAll(".mail-manage [data-manage]").forEach(b => b.addEventListener("click", () => openManage(b.dataset.manage)));

  let loadedOnce = false;
  document.addEventListener("thornhill:view", e => {
    if (e.detail === "email") { loadOverview().then(() => { if (state.ready) loadThreads(); }); loadedOnce = true; }
  });
  document.addEventListener("thornhill:login", () => { loadOverview().then(() => { if (!$("#emailView").hidden && state.ready) loadThreads(); }); });
  document.addEventListener("thornhill:logout", () => {
    Object.assign(state, { overview: null, ready: false, threads: [], current: null });
    closeComposer(true); $("#mailBadge").hidden = true;
  });
  // Check for new email every minute while the page is open
  setInterval(() => {
    if (!session() || document.visibilityState !== "visible") return;
    loadOverview().then(() => { if (!$("#emailView").hidden && state.ready && !state.search) loadThreads(); });
  }, 60000);

  /* ======================================================================
     Enquiry email history (shown inside an enquiry)
     ====================================================================== */
  async function renderEnquiryHistory(q, box, list) {
    const s = session();
    if (!s || !box) return;
    try {
      const r = await Store.enquiryEmails(s.name, s.code, q.id);
      const items = r.items || [];
      if (!items.length) { box.hidden = true; return; }
      box.hidden = false;
      list.innerHTML = items.map(m => `
        <button type="button" class="em-row ${m.direction}" data-thread="${esc(m.thread_id)}">
          <span class="em-dir">${m.direction === "in" ? "↙" : "↗"}</span>
          <span class="em-main"><b>${esc(m.direction === "in" ? (m.from_name || m.from_address) : (m.kind === "ack" ? "Automatic reply" : (m.sent_by || m.from_address)))}</b>
            <span class="em-snip">${esc(m.snippet || "")}</span></span>
          <span class="em-side">${statusPill(m)}<time>${esc(when(m.created_at))}</time></span>
        </button>`).join("");
      list.querySelectorAll("[data-thread]").forEach(b => b.addEventListener("click", () => {
        admin().showView("email"); openThread(b.dataset.thread);
      }));
    } catch (e) { box.hidden = true; }
  }

  /* ======================================================================
     Management: addresses, templates, settings
     ====================================================================== */
  const manage = $("#mailManage");
  let mtab = "mailboxes", mPrefill = null;
  manage.addEventListener("click", e => { if (e.target === manage || e.target.closest("[data-close]")) closeManage(); });
  document.querySelectorAll(".manage-tabs [data-mtab]").forEach(b => b.addEventListener("click", () => { mtab = b.dataset.mtab; mPrefill = null; renderManage(); }));
  function openManage(tab, prefill) {
    if (!state.ready) { if (state.setupError) window.toast("Run supabase/email.sql first.", "error"); return; }
    mtab = tab || "mailboxes"; mPrefill = prefill || null;
    manage.classList.add("open"); renderManage();
  }
  function closeManage() { manage.classList.remove("open"); }
  const manageErr = m => { const e = $("#manageError"); e.textContent = m || ""; e.classList.toggle("show", !!m); };

  function renderManage() {
    manageErr("");
    document.querySelectorAll(".manage-tabs [data-mtab]").forEach(b => b.classList.toggle("active", b.dataset.mtab === mtab));
    const body = $("#manageBody");
    if (mtab === "mailboxes") renderMailboxes(body);
    if (mtab === "templates") renderTemplates(body);
    if (mtab === "settings") renderSettings(body);
  }

  async function refreshAfterManage() { await loadOverview(); renderManage(); if (!$("#emailView").hidden && state.ready) loadThreads(); }

  function renderMailboxes(body, editing) {
    const o = state.overview, me = o.me, d = o.settings.domain;
    const hasPersonal = o.mailboxes.some(m => m.kind === "personal" && (m.owner_name || "").toLowerCase() === me.toLowerCase());
    const form = editing || mPrefill;
    body.innerHTML = `
      <div class="m-grid">
        <div>
          <div class="m-list">${o.mailboxes.map(m => `
            <div class="m-item">
              <div class="avatar ${m.kind}">${esc(initials(m.display_name))}</div>
              <div class="m-info"><strong>${esc(m.address)}</strong><span>${esc(m.display_name)} · ${m.kind === "shared" ? "Shared — every admin can use it" : "Personal — only " + esc(m.owner_name)}${m.is_default ? " · <b>Default</b>" : ""}</span></div>
              ${m.can_use ? `<button class="btn btn-ghost btn-sm" type="button" data-edit-mb="${esc(m.id)}">Edit</button>` : ""}
            </div>`).join("") || '<p class="muted">No addresses yet.</p>'}
          </div>
          <div class="row" style="justify-content:flex-start;margin-top:14px">
            <button class="btn btn-ghost btn-sm" type="button" data-new-mb="shared">+ Shared address</button>
            ${hasPersonal ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-new-mb="personal">+ My personal address</button>`}
          </div>
        </div>
        <form class="m-form" id="mbForm" ${form ? "" : "hidden"} novalidate>
          <h4>${form && form.id ? "Edit address" : "New address"}</h4>
          <div class="field"><label>Email address</label>
            <div class="slug-input"><input id="mbLocal" type="text" maxlength="60" autocomplete="off" spellcheck="false" placeholder="support"><span>@${esc(d)}</span></div></div>
          <div class="field"><label for="mbName">Name people see</label><input id="mbName" type="text" maxlength="80" placeholder="Thornhill Support"></div>
          <div class="field"><label>Type</label>
            <div class="source-switch">
              <label class="source-opt"><input type="radio" name="mbKind" value="shared"><span><strong>Shared</strong><small>Every admin can send and read</small></span></label>
              <label class="source-opt"><input type="radio" name="mbKind" value="personal"><span><strong>Personal</strong><small>Only you, ${esc(me)}</small></span></label>
            </div></div>
          <div class="field"><label for="mbSig">Signature <span class="opt">(added to the end of emails)</span></label>
            <textarea id="mbSig" maxlength="2000" placeholder="Kind regards,&#10;**Thornhill Support**&#10;Thornhill Corporation"></textarea>
            <div class="hint"><span>Use **double stars** for bold.</span></div></div>
          <label class="check" id="mbDefaultRow"><input type="checkbox" id="mbDefault"> Default address for replying to enquiries</label>
          <div class="row">
            ${form && form.id ? `<button class="btn btn-danger btn-sm" type="button" data-del-mb="${esc(form.id)}" style="margin-right:auto">Delete</button>` : ""}
            <button class="btn btn-ghost btn-sm" type="button" data-cancel-mb>Cancel</button>
            <button class="btn btn-primary btn-sm" type="submit">Save address</button>
          </div>
        </form>
      </div>
      <p class="m-note">Addresses must end in <b>@${esc(d)}</b>, which must be verified in Resend. Email sent to any address on this list arrives in the Emailing Centre. Mail to addresses that aren't set up appears under <b>Other addresses</b>.</p>`;

    const f = $("#mbForm");
    const setKind = k => { f.querySelector(`input[name="mbKind"][value="${k}"]`).checked = true; $("#mbDefaultRow").hidden = k !== "shared"; };
    f.querySelectorAll('input[name="mbKind"]').forEach(r => r.addEventListener("change", () => setKind(r.value)));
    if (form) {
      $("#mbLocal").value = (form.address || "").split("@")[0];
      $("#mbName").value = form.display_name || "";
      $("#mbSig").value = form.signature || "";
      $("#mbDefault").checked = !!form.is_default;
      setKind(form.kind || "shared");
      if (form.id && form.kind === "personal") f.querySelector('input[value="shared"]').disabled = false;
    }
    body.querySelectorAll("[data-new-mb]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.newMb;
      mPrefill = k === "personal" ? { kind: "personal", address: suggestLocal(me), display_name: me, signature: `Kind regards,\n**${me}**\nThornhill Corporation` } : { kind: "shared", address: "", display_name: "", signature: "" };
      renderMailboxes(body);
    }));
    body.querySelectorAll("[data-edit-mb]").forEach(b => b.addEventListener("click", () => {
      mPrefill = null; renderMailboxes(body, o.mailboxes.find(m => m.id === b.dataset.editMb));
    }));
    const cancel = body.querySelector("[data-cancel-mb]");
    if (cancel) cancel.addEventListener("click", () => { mPrefill = null; renderMailboxes(body); });
    const del = body.querySelector("[data-del-mb]");
    if (del) del.addEventListener("click", () => {
      const m = o.mailboxes.find(x => x.id === del.dataset.delMb);
      confirmBox("Delete " + m.address + "?", m.kind === "personal" ? "Your personal email in this mailbox is deleted too. This can't be undone." : "Its email stays in the Emailing Centre under “Other addresses”. You won't be able to send from it any more.", async () => {
        const s = session();
        try { await Store.deleteMailbox(s.name, s.code, m.id); window.toast("Address deleted"); mPrefill = null; refreshAfterManage(); }
        catch (e) { if (isAuth(e)) return expired(); manageErr(friendly(e)); }
      });
    });
    f.addEventListener("submit", async e => {
      e.preventDefault();
      const local = $("#mbLocal").value.trim().toLowerCase().replace(/@.*$/, "");
      if (!/^[a-z0-9._%+-]+$/.test(local)) return manageErr("The part before the @ can use letters, numbers, dots, dashes and underscores.");
      if (!$("#mbName").value.trim()) return manageErr("Add the name people will see, e.g. Thornhill Support.");
      const s = session();
      try {
        await Store.saveMailbox(s.name, s.code, {
          id: form && form.id, address: local + "@" + d, display_name: $("#mbName").value.trim(),
          kind: f.querySelector('input[name="mbKind"]:checked').value, signature: $("#mbSig").value, is_default: $("#mbDefault").checked
        });
        window.toast("Address saved"); mPrefill = null; refreshAfterManage();
      } catch (ex) { if (isAuth(ex)) return expired(); manageErr(friendly(ex)); }
    });
  }

  function renderTemplates(body, editing) {
    const o = state.overview;
    const form = editing;
    body.innerHTML = `
      <div class="m-grid">
        <div>
          <div class="m-list">${o.templates.map(t => `
            <div class="m-item"><div class="avatar tpl">T</div>
              <div class="m-info"><strong>${esc(t.name)}</strong><span>${esc((t.body || "").replace(/\s+/g, " ").slice(0, 90))}</span></div>
              <button class="btn btn-ghost btn-sm" type="button" data-edit-tpl="${esc(t.id)}">Edit</button></div>`).join("") || '<p class="muted">No templates yet.</p>'}
          </div>
          <div class="row" style="justify-content:flex-start;margin-top:14px"><button class="btn btn-ghost btn-sm" type="button" data-new-tpl>+ New template</button></div>
        </div>
        <form class="m-form" id="tplForm" ${form ? "" : "hidden"} novalidate>
          <h4>${form && form.id ? "Edit template" : "New template"}</h4>
          <div class="field"><label for="tplName">Template name</label><input id="tplName" type="text" maxlength="80" placeholder="e.g. Password reset"></div>
          <div class="field"><label for="tplSubject">Subject <span class="opt">(optional)</span></label><input id="tplSubject" type="text" maxlength="200"></div>
          <div class="field"><label for="tplBody">Message</label><textarea id="tplBody" maxlength="10000" style="min-height:180px"></textarea>
            <div class="ph-chips">${["first_name", "name", "reference", "enquiry_subject", "admin_name", "admin_first_name", "mailbox"].map(p => `<button type="button" data-ph="${p}">{{${p}}}</button>`).join("")}</div>
            <div class="hint"><span>Click a placeholder to insert it. It's filled in automatically when you use the template.</span></div></div>
          <div class="row">
            ${form && form.id ? `<button class="btn btn-danger btn-sm" type="button" data-del-tpl="${esc(form.id)}" style="margin-right:auto">Delete</button>` : ""}
            <button class="btn btn-ghost btn-sm" type="button" data-cancel-tpl>Cancel</button>
            <button class="btn btn-primary btn-sm" type="submit">Save template</button>
          </div>
        </form>
      </div>`;
    const f = $("#tplForm");
    if (form) { $("#tplName").value = form.name || ""; $("#tplSubject").value = form.subject || ""; $("#tplBody").value = form.body || ""; }
    body.querySelector("[data-new-tpl]").addEventListener("click", () => renderTemplates(body, {}));
    body.querySelectorAll("[data-edit-tpl]").forEach(b => b.addEventListener("click", () => renderTemplates(body, o.templates.find(t => t.id === b.dataset.editTpl))));
    const cancel = body.querySelector("[data-cancel-tpl]"); if (cancel) cancel.addEventListener("click", () => renderTemplates(body));
    body.querySelectorAll("[data-ph]").forEach(b => b.addEventListener("click", () => { const t = $("#tplBody"); t.setRangeText("{{" + b.dataset.ph + "}}", t.selectionStart, t.selectionEnd, "end"); t.focus(); }));
    const del = body.querySelector("[data-del-tpl]");
    if (del) del.addEventListener("click", () => confirmBox("Delete this template?", "This can't be undone.", async () => {
      const s = session();
      try { await Store.deleteTemplate(s.name, s.code, del.dataset.delTpl); window.toast("Template deleted"); refreshAfterManage(); }
      catch (e) { if (isAuth(e)) return expired(); manageErr(friendly(e)); }
    }));
    f.addEventListener("submit", async e => {
      e.preventDefault();
      if (!$("#tplName").value.trim() || !$("#tplBody").value.trim()) return manageErr("Templates need a name and a message.");
      const s = session();
      try {
        await Store.saveTemplate(s.name, s.code, { id: form && form.id, name: $("#tplName").value.trim(), subject: $("#tplSubject").value.trim(), body: $("#tplBody").value });
        window.toast("Template saved"); refreshAfterManage();
      } catch (ex) { if (isAuth(ex)) return expired(); manageErr(friendly(ex)); }
    });
  }

  function renderSettings(body) {
    const o = state.overview, st = o.settings;
    const shared = o.mailboxes.filter(m => m.kind === "shared");
    body.innerHTML = `
      <div class="m-grid settings">
        <form class="m-form" id="setForm" novalidate>
          <h4>General</h4>
          <div class="field"><label for="setDomain">Email domain</label><input id="setDomain" type="text" value="${esc(st.domain)}"><div class="hint"><span>All addresses end in @ this domain. It must be verified in Resend.</span></div></div>
          <div class="field"><label for="setSite">Website address</label><input id="setSite" type="url" value="${esc(st.site_url)}"><div class="hint"><span>Used for the logo and link in every email.</span></div></div>
          <h4 style="margin-top:22px">Automatic reply to new enquiries</h4>
          <label class="check"><input type="checkbox" id="setAck" ${st.auto_ack ? "checked" : ""}> When someone submits the Support form, email them straight away to confirm we received it, with their reference number.</label>
          <div class="field" style="margin-top:14px"><label for="setAckMb">Send from</label>
            <select id="setAckMb"><option value="">Choose a shared address…</option>${shared.map(m => `<option value="${esc(m.id)}" ${st.ack_mailbox_id === m.id ? "selected" : ""}>${esc(m.address)}</option>`).join("")}</select></div>
          <div class="field"><label for="setAckTpl">Using template</label>
            <select id="setAckTpl"><option value="">Choose a template…</option>${o.templates.map(t => `<option value="${esc(t.id)}" ${st.ack_template_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
          <div class="row"><button class="btn btn-primary btn-sm" type="submit">Save settings</button></div>
        </form>
        <div class="m-form checklist-box">
          <h4>Setup checklist</h4>
          <ul class="checklist-live" id="setupChecks"><li class="pending">Checking…</li></ul>
          <button class="btn btn-ghost btn-sm" type="button" id="recheck">Check again</button>
          <p class="m-note">Full setup steps are in the README under <b>Emailing Centre</b>.</p>
        </div>
      </div>`;
    $("#setForm").addEventListener("submit", async e => {
      e.preventDefault();
      const s = session();
      try {
        await Store.saveEmailSettings(s.name, s.code, { domain: $("#setDomain").value.trim(), site_url: $("#setSite").value.trim(), auto_ack: $("#setAck").checked, ack_mailbox_id: $("#setAckMb").value, ack_template_id: $("#setAckTpl").value });
        window.toast("Settings saved"); refreshAfterManage();
      } catch (ex) { if (isAuth(ex)) return expired(); manageErr(friendly(ex)); }
    });
    $("#recheck").addEventListener("click", runChecks);
    runChecks();
  }

  async function runChecks() {
    const ul = $("#setupChecks");
    if (!ul) return;
    const o = state.overview, d = o.settings.domain;
    const rows = [];
    const add = (ok, text, help) => rows.push(`<li class="${ok === true ? "ok" : ok === false ? "bad" : "warn"}"><span>${text}</span>${help ? `<small>${help}</small>` : ""}</li>`);
    add(true, "Database tables installed");
    add(o.mailboxes.length > 0, "At least one email address set up", o.mailboxes.length ? "" : "Add one under Addresses &amp; signatures.");
    ul.innerHTML = rows.join("") + '<li class="pending">Checking the email function…</li>';
    try {
      const s = session();
      const r = await Store.emailFunction({ action: "status", name: s.name, code: s.code });
      add(true, "Email function deployed");
      add(r.resend_key, "Resend API key added", r.resend_key ? "" : "Add the RESEND_API_KEY secret in Supabase → Edge Functions → Secrets.");
      if (r.key_problem) add(false, "Resend API key permissions", esc(r.key_problem));
      if (r.domains) {
        const dom = r.domains.find(x => x.name.toLowerCase() === d.toLowerCase());
        add(dom ? dom.status === "verified" : false, `Domain ${esc(d)} verified in Resend`, !dom ? "Add the domain in Resend → Domains and copy its DNS records to your domain provider." : dom.status === "verified" ? "" : `Resend says: ${esc(dom.status)}. DNS changes can take a few hours.`);
      }
      add(r.webhook_secret ? true : null, "Receiving email set up (webhook secret)", r.webhook_secret ? "" : "Optional: needed to receive replies in the inbox. Add RESEND_WEBHOOK_SECRET.");
    } catch (e) {
      add(false, "Email function deployed", esc(friendly(e)));
    }
    add(o.settings.auto_ack ? true : null, "Automatic reply to new enquiries", o.settings.auto_ack ? "" : "Optional: switch on above.");
    ul.innerHTML = rows.join("");
  }

  /* ---------- confirm ---------- */
  function confirmBox(title, text, onYes) {
    const m = $("#mailConfirm");
    $("#mailConfirmTitle").textContent = title; $("#mailConfirmText").textContent = text;
    m.classList.add("open");
    const yes = $("#mailConfirmYes"), no = $("#mailConfirmNo");
    const close = () => { m.classList.remove("open"); yes.onclick = no.onclick = null; };
    yes.onclick = () => { close(); onYes(); };
    no.onclick = close;
    no.focus();
  }

  window.ThornhillEmail = { composeForEnquiry, renderEnquiryHistory, openThread: id => { loadOverview().then(() => { loadThreads(); openThread(id); }); }, compose: openComposer };
})();
