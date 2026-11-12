/* ==========================================================================
   Thornhill Corporation — Admin: Document hub
   Admins add a Google Docs/Drive link or upload a PDF, give it a name and
   description, and get a short Thornhill link: <your-domain>/d/<short-name>
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const Docs = window.ThornhillDocs;
  const Admin = window.ThornhillAdmin;
  const MAX_BYTES = 5 * 1024 * 1024;

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const listEl = $("#docList");
  const modal = $("#docModal"), form = $("#docForm"), success = $("#docSuccess");
  const err = $("#docError");

  let docs = [];
  let loaded = false;
  let query = "";
  let editing = null;        // document being edited, or null for new
  let pdf = null;            // { name, size, data } for a newly chosen file
  let pendingDelete = null;

  $("#slugPrefix").textContent = location.host + "/d/";

  /* ---------- loading ---------- */
  function session() { return Admin && Admin.session(); }

  async function load() {
    const s = session();
    if (!s) return;
    listEl.innerHTML = '<div class="empty"><strong>Loading documents…</strong></div>';
    try {
      docs = await Store.listDocuments(s.name, s.code);
      loaded = true;
      render();
    } catch (e) {
      if (e.status === 401) return Admin.expire();
      listEl.innerHTML = '<div class="empty"><strong>Couldn\'t load documents</strong>' + esc(friendly(e)) + "</div>";
    }
  }

  function friendly(e) {
    const m = (e && e.message) || "";
    if (/admin_list_documents|admin_save_document|function .* does not exist|schema cache/i.test(m))
      return "The document hub isn't set up in Supabase yet. Run supabase/documents.sql in the SQL Editor (see README).";
    if (/fetch/i.test(m)) return "Couldn't reach the server. Check your connection and try again.";
    return m || "Something went wrong.";
  }

  document.addEventListener("thornhill:view", e => { if (e.detail === "documents" && !loaded) load(); });
  document.addEventListener("thornhill:login", () => { loaded = false; if (!$("#documentsView").hidden) load(); });
  document.addEventListener("thornhill:logout", () => { docs = []; loaded = false; listEl.innerHTML = ""; closeModal(); });
  // The session may already have been restored before this script loaded
  if (session() && !$("#documentsView").hidden) load();

  $("#docSearch").addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); render(); });

  /* ---------- list ---------- */
  function render() {
    $("#docStatTotal").textContent = docs.length;
    $("#docStatPublic").textContent = docs.filter(d => d.is_public).length;
    $("#docStatPdf").textContent = docs.filter(d => d.kind === "pdf").length;
    $("#docStatViews").textContent = docs.reduce((n, d) => n + (d.views || 0), 0);

    const rows = docs.filter(d => !query || [d.title, d.description, d.slug, d.file_name].join(" ").toLowerCase().includes(query));
    if (!rows.length) {
      listEl.innerHTML = docs.length
        ? '<div class="empty"><strong>No matching documents</strong>Try a different search.</div>'
        : '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><strong>No documents yet</strong>Click <b>New document</b> to share your first Google Doc or PDF.</div>';
      return;
    }
    listEl.innerHTML = rows.map(d => {
      const g = d.kind === "google" ? Docs.parseGoogle(d.url) : null;
      const typeLabel = d.kind === "pdf" ? "PDF" + (d.file_size ? " · " + Docs.formatSize(d.file_size) : "") : (g ? g.label : "Google link");
      const link = Docs.linkFor(d.slug);
      return `
      <article class="doc-card" data-id="${esc(d.id)}">
        <div class="doc-top">
          <div class="doc-icon ${d.kind}">${d.kind === "pdf" ? "PDF" : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>'}</div>
          <div class="doc-meta">
            <h3>${esc(d.title)}</h3>
            <span>${esc(typeLabel)}</span>
          </div>
          <span class="vis ${d.is_public ? "public" : ""}">${d.is_public ? "Public" : "Link only"}</span>
        </div>
        ${d.description ? `<p class="doc-desc">${esc(d.description)}</p>` : ""}
        <div class="link-box small"><span title="${esc(link)}">${esc(link.replace(/^https?:\/\//, ""))}</span><button class="btn btn-ghost btn-sm" type="button" data-act="copy">Copy</button></div>
        <div class="doc-foot">
          <small>${d.views || 0} view${d.views === 1 ? "" : "s"} · Added ${esc(new Date(d.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}${d.created_by ? " by " + esc(d.created_by) : ""}</small>
          <div class="doc-actions">
            <a class="btn btn-ghost btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Open</a>
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">Edit</button>
            <button class="btn btn-danger btn-sm" type="button" data-act="delete" aria-label="Delete ${esc(d.title)}">Delete</button>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  listEl.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const d = docs.find(x => x.id === btn.closest(".doc-card").dataset.id);
    if (!d) return;
    if (btn.dataset.act === "copy") copy(Docs.linkFor(d.slug));
    if (btn.dataset.act === "edit") openModal(d);
    if (btn.dataset.act === "delete") { pendingDelete = d; $("#docConfirmModal").classList.add("open"); $("#docCancelDelete").focus(); }
  });

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); window.toast("Link copied"); }
    catch (e) { window.prompt("Copy this link:", text); }
  }

  /* ---------- delete ---------- */
  $("#docCancelDelete").addEventListener("click", () => { $("#docConfirmModal").classList.remove("open"); pendingDelete = null; });
  $("#docConfirmModal").addEventListener("click", e => { if (e.target.id === "docConfirmModal") $("#docCancelDelete").click(); });
  $("#docConfirmDelete").addEventListener("click", async () => {
    const d = pendingDelete, s = session();
    $("#docConfirmModal").classList.remove("open");
    if (!d || !s) return;
    try {
      await Store.deleteDocument(s.name, s.code, d.id);
      docs = docs.filter(x => x.id !== d.id);
      render();
      window.toast("Document deleted");
    } catch (e) {
      if (e.status === 401) return Admin.expire();
      window.toast("Couldn't delete: " + friendly(e), "error");
    }
  });

  /* ---------- modal: new / edit ---------- */
  $("#newDocBtn").addEventListener("click", () => openModal(null));
  modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-close]")) closeModal(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("#docConfirmModal").classList.contains("open")) $("#docCancelDelete").click();
    else if (modal.classList.contains("open")) closeModal();
  });

  function setKind(kind) {
    form.querySelector(`input[name="kind"][value="${kind}"]`).checked = true;
    $("#googleField").hidden = kind !== "google";
    $("#pdfField").hidden = kind !== "pdf";
  }
  form.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener("change", () => setKind(r.value)));

  function openModal(doc) {
    editing = doc;
    pdf = null;
    form.reset();
    form.hidden = false; success.hidden = true;
    err.classList.remove("show");
    $("#docModalTitle").textContent = doc ? "Edit document" : "New document";
    $("#docSaveBtn").textContent = doc ? "Save changes" : "Create link";
    setKind(doc ? doc.kind : "google");
    $("#docUrl").value = doc && doc.kind === "google" ? doc.url : "";
    $("#docTitle").value = doc ? doc.title : "";
    $("#docDesc").value = doc && doc.description ? doc.description : "";
    $("#docSlug").value = doc ? doc.slug : newCode();
    $("#slugHint").textContent = doc ? "The link stays the same when you edit a document." : "A random code is created for every new document.";
    $("#docPublic").checked = !!(doc && doc.is_public);
    updateUrlHint();
    resetDrop(doc && doc.kind === "pdf" ? doc : null);
    modal.classList.add("open");
    setTimeout(() => (doc ? $("#docTitle") : form.querySelector('input[name="kind"]:checked')).focus(), 50);
  }

  function closeModal() { modal.classList.remove("open"); }

  /** Random link code, e.g. "k7m2x9qa" (no look-alike characters such as 0/o or 1/l) */
  function newCode() {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789", out = new Uint32Array(8);
    crypto.getRandomValues(out);
    return Array.from(out, n => chars[n % chars.length]).join("");
  }

  /* Google link feedback */
  function updateUrlHint() {
    const v = $("#docUrl").value.trim(), hint = $("#docUrlHint");
    if (!v) { hint.textContent = "Set sharing to “Anyone with the link can view” in Google first."; hint.className = ""; return; }
    const g = Docs.parseGoogle(v);
    hint.textContent = g ? "✓ " + g.label + " recognised. Make sure it's shared as “Anyone with the link”." : "That doesn't look like a Google Docs, Sheets, Slides, Forms or Drive link.";
    hint.className = g ? "ok" : "bad";
  }
  $("#docUrl").addEventListener("input", updateUrlHint);

  /* PDF picking (click or drag and drop) */
  const drop = $("#dropzone"), fileInput = $("#docFile");
  function resetDrop(existing) {
    drop.classList.remove("has-file", "dragging");
    fileInput.value = "";
    $("#dropTitle").textContent = existing ? "Current file: " + (existing.file_name || "document.pdf") : "Drop a PDF here or click to choose";
    $("#dropSub").textContent = existing ? Docs.formatSize(existing.file_size) + " · choose a new file to replace it" : "PDF only, maximum 5 MB";
    if (existing) drop.classList.add("has-file");
  }
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("dragging"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) pickFile(f); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); });

  function pickFile(f) {
    err.classList.remove("show");
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") return showErr("Please choose a PDF file.");
    if (f.size > MAX_BYTES) return showErr("That PDF is " + Docs.formatSize(f.size) + ". The maximum is 5 MB. Try compressing it, or share it as a Google Drive link instead.");
    const reader = new FileReader();
    $("#dropTitle").textContent = "Reading " + f.name + "…";
    reader.onload = () => {
      const data = String(reader.result).split(",")[1] || "";
      if (!data.startsWith("JVBER")) { resetDrop(editing && editing.kind === "pdf" ? editing : null); return showErr("That file isn't a valid PDF."); }
      pdf = { name: f.name, size: f.size, data };
      drop.classList.add("has-file");
      $("#dropTitle").textContent = f.name;
      $("#dropSub").textContent = Docs.formatSize(f.size) + " · click to choose a different file";
      if (!$("#docTitle").value.trim()) {
        $("#docTitle").value = f.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
        $("#docTitle").dispatchEvent(new Event("input"));
      }
    };
    reader.onerror = () => showErr("Couldn't read that file. Please try again.");
    reader.readAsDataURL(f);
  }

  function showErr(msg) {
    err.textContent = msg;
    err.classList.add("show");
    err.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /* ---------- save ---------- */
  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.classList.remove("show");
    const s = session();
    if (!s) return Admin.expire();

    const kind = form.querySelector('input[name="kind"]:checked').value;
    const title = $("#docTitle").value.trim();
    let slug = editing ? editing.slug : $("#docSlug").value;
    const url = $("#docUrl").value.trim();

    if (kind === "google" && !Docs.parseGoogle(url)) return showErr("Please paste a Google Docs, Sheets, Slides, Forms or Drive link (starting with https://).");
    if (kind === "pdf" && !pdf && !(editing && editing.kind === "pdf")) return showErr("Please choose a PDF to upload.");
    if (title.length < 2) return showErr("Please give the document a name.");

    const btn = $("#docSaveBtn"), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = pdf ? "Uploading…" : "Saving…";

    // Open the new tab now (while the click still counts) so pop-up blockers allow it,
    // then point it at the document once it's saved.
    const tab = editing ? null : window.open("", "_blank");
    if (tab) { try { tab.document.title = "Opening document…"; tab.document.body.style.cssText = "margin:0;background:#525659"; } catch (e) {} }

    try {
      let res, attempts = 0;
      while (true) {
        try {
          res = await Store.saveDocument(s.name, s.code, {
            id: editing ? editing.id : null, slug, title, description: $("#docDesc").value.trim(), kind,
            url: kind === "google" ? url : null,
            fileName: pdf ? pdf.name : null, fileSize: pdf ? pdf.size : null, pdfData: pdf ? pdf.data : null,
            isPublic: $("#docPublic").checked
          }, s.display);
          break;
        } catch (ex) {
          // In the rare case a random code is already taken, pick another and retry
          if (!editing && /already in use/i.test(ex.message) && ++attempts < 5) { slug = newCode(); continue; }
          throw ex;
        }
      }
      await load();
      showSuccess(res.slug, !!editing);
      if (tab) tab.location.href = Docs.linkFor(res.slug);
    } catch (ex) {
      if (tab) tab.close();
      if (ex.status === 401) { closeModal(); return Admin.expire(); }
      showErr(friendly(ex));
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

  function showSuccess(slug, wasEdit) {
    const link = Docs.linkFor(slug);
    form.hidden = true;
    success.hidden = false;
    success.querySelector("h3").textContent = wasEdit ? "Changes saved" : "Your link is ready";
    $("#docSuccessText").textContent = $("#docPublic").checked
      ? "It's opened in a new tab. Anyone with this link can view it, and it's listed on your public Documents page."
      : "It's opened in a new tab. Anyone with this link can view it.";
    if (wasEdit) $("#docSuccessText").textContent = "The link stays the same, so anyone you've already shared it with will see the update.";
    $("#docSuccessLink").textContent = link.replace(/^https?:\/\//, "");
    $("#docSuccessOpen").href = link;
    $("#docSuccessCopy").onclick = () => copy(link);
  }
})();
