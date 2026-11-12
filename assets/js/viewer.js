/* ==========================================================================
   Thornhill Corporation — Document viewer for short links (/d/<short-link>)
   GitHub Pages serves 404.html for any address it doesn't have, so this page
   checks whether the address is a document link and shows it if so.
   ========================================================================== */
(function () {
  const $ = s => document.querySelector(s);
  const Docs = window.ThornhillDocs;
  const match = location.pathname.match(/^\/d\/([a-z0-9-]{1,60})\/?$/i);

  if (!match) {
    $("#notFound").hidden = false;
    document.title = "Page not found — Thornhill Corporation";
    return;
  }

  const slug = match[1].toLowerCase();
  const viewer = $("#viewer"), stage = $("#stage");
  viewer.hidden = false;
  document.body.classList.add("viewing");

  function notFound() {
    viewer.hidden = true;
    document.body.classList.remove("viewing");
    $("#notFound").hidden = false;
    $("#nfEyebrow").textContent = "Document not found";
    $("#nfTitle").textContent = "This document link isn't available.";
    $("#nfText").textContent = "It may have been removed, or the link may be mistyped. Check the link you were sent, or contact us and we'll help.";
    $("#nfDocs").hidden = false;
    document.title = "Document not found — Thornhill Corporation";
  }

  function message(html) { stage.innerHTML = '<div class="viewer-msg">' + html + "</div>"; }

  function b64ToBlob(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "application/pdf" });
  }

  (async function () {
    let doc;
    try {
      doc = await window.ThornhillStore.getDocument(slug);
    } catch (e) {
      console.error(e);
      $("#docTitle").textContent = "Couldn't open this document";
      message('<p>We couldn\'t reach the server. Please check your connection and <a href="">try again</a>.</p>');
      return;
    }
    if (!doc) return notFound();

    document.title = doc.title + " — Thornhill Corporation";
    $("#docTitle").textContent = doc.title;
    const updated = new Date(doc.updated_at || doc.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    $("#docSub").textContent = "Thornhill Corporation · Updated " + updated;

    if (doc.description) {
      const info = $("#docInfo"), btn = $("#infoBtn");
      info.textContent = doc.description;
      btn.hidden = false;
      // Show the description by default on wide screens, tucked away on phones
      const open = v => { info.hidden = !v; btn.setAttribute("aria-expanded", v); };
      open(window.innerWidth > 760);
      btn.addEventListener("click", () => open(info.hidden));
    }

    const share = $("#shareBtn");
    share.hidden = false;
    share.addEventListener("click", async () => {
      const link = Docs.linkFor(doc.slug);
      if (navigator.share && window.innerWidth < 760) { try { await navigator.share({ title: doc.title, url: link }); return; } catch (e) {} }
      try { await navigator.clipboard.writeText(link); window.toast("Link copied"); } catch (e) { window.prompt("Copy this link:", link); }
    });

    const openBtn = $("#openBtn");

    if (doc.kind === "google") {
      const g = Docs.parseGoogle(doc.url);
      openBtn.href = doc.url;
      $("#openLbl").textContent = "Open in Google";
      openBtn.hidden = false;
      if (!g) { message('<p>This document can\'t be shown here.</p><a class="btn btn-primary" href="' + doc.url.replace(/"/g, "&quot;") + '" target="_blank" rel="noopener">Open document</a>'); return; }
      const frame = document.createElement("iframe");
      frame.src = g.embed;
      frame.title = doc.title;
      frame.allow = "fullscreen";
      frame.setAttribute("allowfullscreen", "");
      stage.innerHTML = "";
      stage.appendChild(frame);
      return;
    }

    // PDF stored in the database
    let url;
    try { url = URL.createObjectURL(b64ToBlob(doc.pdf_data)); }
    catch (e) { message("<p>This PDF couldn't be opened.</p>"); return; }
    const fileName = doc.file_name || doc.slug + ".pdf";
    openBtn.href = url;
    openBtn.setAttribute("download", fileName);
    openBtn.removeAttribute("target");
    $("#openLbl").textContent = "Download PDF";
    openBtn.hidden = false;

    // Phones and some browsers can't show PDFs inside a page — offer buttons instead
    const canEmbed = navigator.pdfViewerEnabled !== false && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (canEmbed) {
      const frame = document.createElement("iframe");
      frame.src = url + "#view=FitH";
      frame.title = doc.title;
      stage.innerHTML = "";
      stage.appendChild(frame);
    } else {
      stage.innerHTML = "";
      const box = document.createElement("div");
      box.className = "viewer-msg";
      box.innerHTML = '<div class="pdf-badge">PDF</div><h2></h2><p></p><div class="row"><a class="btn btn-primary" target="_blank" rel="noopener">View PDF</a><a class="btn btn-ghost">Download</a></div>';
      box.querySelector("h2").textContent = doc.title;
      box.querySelector("p").textContent = fileName;
      box.querySelector(".btn-primary").href = url;
      const dl = box.querySelector(".btn-ghost"); dl.href = url; dl.setAttribute("download", fileName);
      stage.appendChild(box);
    }
  })();
})();
