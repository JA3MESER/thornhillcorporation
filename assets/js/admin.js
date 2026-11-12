/* ==========================================================================
   Thornhill Corporation — Admin panel
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const cfg = window.THORNHILL_CONFIG || {};
  const SESSION_KEY = "thornhill.admin.session";
  const IDLE_LIMIT = 30 * 60 * 1000; // auto log-out after 30 minutes of inactivity

  const $ = s => document.querySelector(s);
  const loginView = $("#loginView"), dashView = $("#dashView");
  const listEl = $("#list"), detailEl = $("#detail");

  let session = null;     // { name, code, display }
  let items = [];
  let filter = "all";
  let query = "";
  let selectedId = null;
  let pendingDeleteId = null;
  let idleTimer = null;

  const STATUS_LABEL = { new: "New", in_progress: "In progress", resolved: "Resolved" };

  /* ---------- helpers ---------- */
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = n => String(n || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase();
  function fmtDate(iso, long) {
    const d = new Date(iso);
    if (long) return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  /* ---------- session ---------- */
  function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
  function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (session) idleTimer = setTimeout(() => { logout(); window.toast("Logged out after 30 minutes of inactivity"); }, IDLE_LIMIT);
  }
  ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));

  /* ---------- login ---------- */
  if (!Store.live) $("#demoNote").hidden = false;

  $("#toggleCode").addEventListener("click", () => {
    const i = $("#adminCode");
    i.type = i.type === "password" ? "text" : "password";
    $("#toggleCode").setAttribute("aria-label", i.type === "password" ? "Show code" : "Hide code");
  });

  let failures = 0, lockedUntil = 0;
  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#loginError");
    const name = $("#adminName").value.trim();
    const code = $("#adminCode").value;
    err.classList.remove("show");

    if (Date.now() < lockedUntil) {
      showLoginError("Too many attempts. Please wait " + Math.ceil((lockedUntil - Date.now()) / 1000) + " seconds.");
      return;
    }
    if (!name || !code) { showLoginError("Please enter your full name and special code."); return; }

    const btn = $("#loginBtn");
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const display = await Store.login(name, code);
      failures = 0;
      session = { name, code, display };
      saveSession(session);
      $("#adminCode").value = "";
      enterDashboard();
    } catch (ex) {
      failures++;
      if (failures >= 5) { lockedUntil = Date.now() + 60000; failures = 0; }
      showLoginError(ex.message && !/fetch/i.test(ex.message) ? ex.message : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });

  function showLoginError(msg) {
    const err = $("#loginError");
    err.textContent = msg;
    err.classList.add("show");
    const card = document.querySelector(".login-card");
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
  }

  function logout() {
    session = null; items = []; selectedId = null;
    clearSession(); clearTimeout(idleTimer);
    document.dispatchEvent(new Event("thornhill:logout"));
    dashView.classList.remove("show");
    loginView.style.display = "";
    document.title = "Administrator Panel — Thornhill Corporation";
  }
  $("#logoutBtn").addEventListener("click", logout);

  /* ---------- dashboard ---------- */
  async function enterDashboard() {
    loginView.style.display = "none";
    dashView.classList.add("show");
    $("#demoBanner").hidden = Store.live;
    $("#meName").textContent = session.display;
    $("#meAvatar").textContent = initials(session.display);
    const h = new Date().getHours();
    $("#greeting").textContent = (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") + ", " + session.display.split(" ")[0];
    resetIdle();
    document.dispatchEvent(new CustomEvent("thornhill:login", { detail: session }));
    await refresh();
  }

  async function refresh(quiet) {
    if (!quiet) listEl.innerHTML = '<div class="empty"><strong>Loading enquiries…</strong></div>';
    try {
      items = (await Store.list(session.name, session.code)) || [];
      items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      render();
      const newCount = items.filter(i => i.status === "new").length;
      document.title = (newCount ? "(" + newCount + ") " : "") + "Administrator Panel — Thornhill Corporation";
      const badge = $("#newBadge");
      badge.textContent = newCount; badge.hidden = !newCount;
    } catch (ex) {
      if (ex.status === 401 || ex.status === 403 || /session|credential|not authori/i.test(ex.message)) {
        logout(); window.toast("Please sign in again", "error"); return;
      }
      listEl.innerHTML = '<div class="empty"><strong>Couldn\'t load enquiries</strong>' + esc(ex.message) + "</div>";
    }
  }
  /* ---------- section switcher (Enquiries / Documents) ---------- */
  function showView(name) {
    document.querySelectorAll(".view-switch [data-view]").forEach(b => {
      const on = b.dataset.view === name;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on);
    });
    $("#enquiriesView").hidden = name !== "enquiries";
    $("#documentsView").hidden = name !== "documents";
    try { sessionStorage.setItem("thornhill.admin.view", name); } catch (e) {}
    document.dispatchEvent(new CustomEvent("thornhill:view", { detail: name }));
  }
  document.querySelectorAll(".view-switch [data-view]").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  try { const v = sessionStorage.getItem("thornhill.admin.view"); if (v === "documents") showView(v); } catch (e) {}

  // Let other admin modules (documents) use the session and sign out on expiry
  window.ThornhillAdmin = {
    session: () => session,
    expire: () => { logout(); window.toast("Please sign in again", "error"); }
  };

  $("#refreshBtn").addEventListener("click", async () => { await refresh(); window.toast("Inbox refreshed"); });

  // Auto-refresh every 60s while the tab is visible
  setInterval(() => { if (session && document.visibilityState === "visible") refresh(true); }, 60000);

  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    renderList();
  });
  $("#search").addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); renderList(); });

  function render() {
    const c = { all: items.length, new: 0, in_progress: 0, resolved: 0 };
    items.forEach(i => { c[i.status] = (c[i.status] || 0) + 1; });
    $("#statTotal").textContent = c.all;
    $("#statNew").textContent = c.new;
    $("#statProgress").textContent = c.in_progress;
    $("#statResolved").textContent = c.resolved;
    document.querySelectorAll("[data-count]").forEach(el => { el.textContent = c[el.dataset.count] || 0; });
    renderList();
    if (selectedId && items.some(i => i.id === selectedId)) renderDetail(selectedId, true);
    else if (selectedId) closeDetail();
  }

  function visible() {
    return items.filter(i => {
      if (filter !== "all" && i.status !== filter) return false;
      if (!query) return true;
      return [i.full_name, i.email, i.subject, i.reference, i.category, i.message].join(" ").toLowerCase().includes(query);
    });
  }

  function renderList() {
    const rows = visible();
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/></svg><strong>' +
        (items.length ? "No matching enquiries" : "No enquiries yet") + "</strong>" +
        (items.length ? "Try a different filter or search." : "New support enquiries will appear here.") + "</div>";
      return;
    }
    listEl.innerHTML = rows.map(i => `
      <button type="button" class="item ${i.status === "new" ? "unread" : ""} ${i.id === selectedId ? "selected" : ""}" data-id="${esc(i.id)}">
        <div class="avatar">${esc(initials(i.full_name))}</div>
        <div>
          <h4>${esc(i.full_name)}</h4>
          <p class="subj">${esc(i.subject)}</p>
          <p class="prev">${esc(i.category)} · ${esc(i.message.slice(0, 120))}</p>
        </div>
        <div class="meta">
          <span>${esc(fmtDate(i.created_at))}</span>
          <span class="status ${esc(i.status)}">${esc(STATUS_LABEL[i.status] || i.status)}</span>
        </div>
      </button>`).join("");
  }

  listEl.addEventListener("click", e => {
    const row = e.target.closest(".item");
    if (row) renderDetail(row.dataset.id);
  });

  function buildReply(i) {
    const first = String(i.full_name).trim().split(/\s+/)[0];
    const subject = "Re: " + i.subject + " [" + i.reference + "]";
    const quoted = i.message.length > 900 ? i.message.slice(0, 900) + "…" : i.message;
    const body =
      "Hi " + first + ",\n\n" +
      "Thank you for contacting Thornhill Corporation about \"" + i.subject + "\" (reference " + i.reference + ").\n\n\n\n" +
      "Kind regards,\n" + session.display + "\nThornhill Corporation\n\n" +
      "----- Your original enquiry -----\n" + quoted;
    return { subject, body };
  }

  function renderDetail(id, keepFocus) {
    const i = items.find(x => x.id === id);
    if (!i) return;
    selectedId = id;
    document.querySelectorAll(".item").forEach(r => r.classList.toggle("selected", r.dataset.id === id));
    detailEl.classList.remove("placeholder");

    const notesDraft = keepFocus ? detailEl.querySelector("#notes")?.value : null;
    const { subject, body } = buildReply(i);
    const mailto = "mailto:" + encodeURI(i.email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    const gmail = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(i.email) + "&su=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);

    detailEl.innerHTML = `
      <div class="detail-head">
        <button class="btn btn-ghost btn-sm close-detail" type="button" id="closeDetail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg> Back to inbox
        </button>
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap;">
          <span class="ref">${esc(i.reference)}</span>
          <span class="status ${esc(i.status)}">${esc(STATUS_LABEL[i.status])}</span>
        </div>
        <h2>${esc(i.subject)}</h2>
        <div class="who">
          <div class="avatar">${esc(initials(i.full_name))}</div>
          <div><strong>${esc(i.full_name)}</strong><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></div>
        </div>
      </div>
      <div class="facts">
        <div><span>Enquiry type</span><strong>${esc(i.category)}</strong></div>
        <div><span>Received</span><strong>${esc(fmtDate(i.created_at, true))}</strong></div>
        <div><span>Phone</span><strong>${esc(i.phone || "—")}</strong></div>
      </div>
      <div class="detail-body">
        <h5>Message</h5>
        <div class="message-box">${esc(i.message)}</div>
        <div class="manage">
          <div class="field">
            <label for="statusSel">Status</label>
            <select id="statusSel">
              <option value="new" ${i.status === "new" ? "selected" : ""}>New</option>
              <option value="in_progress" ${i.status === "in_progress" ? "selected" : ""}>In progress</option>
              <option value="resolved" ${i.status === "resolved" ? "selected" : ""}>Resolved</option>
            </select>
          </div>
          <div class="field">
            <label for="notes">Internal notes <span class="opt">(only admins can see these)</span></label>
            <textarea id="notes" maxlength="2000" placeholder="e.g. Replied on Tuesday, waiting for their response.">${esc(notesDraft != null ? notesDraft : (i.admin_notes || ""))}</textarea>
          </div>
        </div>
      </div>
      <div class="actions">
        <a class="btn btn-primary" id="replyBtn" href="${esc(mailto)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
          Reply via email
        </a>
        <a class="btn btn-ghost" id="gmailBtn" href="${esc(gmail)}" target="_blank" rel="noopener">Reply in Gmail</a>
        <button class="btn btn-ghost" type="button" id="copyBtn">Copy email</button>
        <span class="spacer"></span>
        <button class="btn btn-dark" type="button" id="saveBtn">Save changes</button>
        <button class="btn btn-danger" type="button" id="deleteBtn" aria-label="Delete enquiry">Delete</button>
      </div>`;

    detailEl.classList.add("open");
    if (!keepFocus && window.innerWidth > 1020) detailEl.scrollTop = 0;

    $("#closeDetail").addEventListener("click", closeDetail);
    $("#copyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(i.email); window.toast("Email address copied"); }
      catch (e) { window.toast(i.email); }
    });
    // Replying moves a "new" enquiry to "in progress" automatically
    const markReplied = () => { if (i.status === "new") save(i.id, "in_progress", $("#notes").value, true); };
    $("#replyBtn").addEventListener("click", markReplied);
    $("#gmailBtn").addEventListener("click", markReplied);
    $("#saveBtn").addEventListener("click", () => save(i.id, $("#statusSel").value, $("#notes").value));
    $("#deleteBtn").addEventListener("click", () => { pendingDeleteId = i.id; $("#confirmModal").classList.add("open"); $("#cancelDelete").focus(); });
  }

  function closeDetail() {
    selectedId = null;
    detailEl.classList.remove("open");
    detailEl.classList.add("placeholder");
    detailEl.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg><strong>Select an enquiry</strong>Choose an enquiry from the list to read it and reply.</div>';
    document.querySelectorAll(".item").forEach(r => r.classList.remove("selected"));
  }

  async function save(id, status, notes, silent) {
    try {
      await Store.update(session.name, session.code, id, status, notes || null);
      const i = items.find(x => x.id === id);
      if (i) { i.status = status; i.admin_notes = notes || null; }
      render();
      window.toast(silent ? "Marked as in progress" : "Changes saved");
    } catch (ex) {
      window.toast("Couldn't save: " + ex.message, "error");
    }
  }

  /* ---------- delete ---------- */
  $("#cancelDelete").addEventListener("click", () => { $("#confirmModal").classList.remove("open"); pendingDeleteId = null; });
  $("#confirmModal").addEventListener("click", e => { if (e.target.id === "confirmModal") $("#cancelDelete").click(); });
  $("#confirmDelete").addEventListener("click", async () => {
    const id = pendingDeleteId;
    $("#confirmModal").classList.remove("open");
    if (!id) return;
    try {
      await Store.remove(session.name, session.code, id);
      items = items.filter(x => x.id !== id);
      closeDetail(); render();
      window.toast("Enquiry deleted");
    } catch (ex) { window.toast("Couldn't delete: " + ex.message, "error"); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if ($("#confirmModal").classList.contains("open")) $("#cancelDelete").click();
      else if (detailEl.classList.contains("open") && window.innerWidth <= 1020) closeDetail();
    }
  });

  /* ---------- export ---------- */
  $("#exportBtn").addEventListener("click", () => {
    const rows = visible();
    if (!rows.length) { window.toast("Nothing to export"); return; }
    const cols = ["reference", "created_at", "status", "full_name", "email", "phone", "category", "subject", "message", "admin_notes"];
    const cell = v => { let s = String(v == null ? "" : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => cell(r[c])).join(","))).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = "thornhill-enquiries-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  });

  /* ---------- resume session in this tab ---------- */
  const saved = loadSession();
  if (saved && saved.name && saved.code) {
    session = saved;
    enterDashboard();
  } else {
    $("#adminName").focus();
  }
})();
