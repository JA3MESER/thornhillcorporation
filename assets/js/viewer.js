/* ==========================================================================
   Thornhill Corporation — Document links (/d/<code>)
   GitHub Pages serves 404.html for any address it doesn't have, so this page
   checks whether the address is a document link. If it is, the document fills
   the whole window — just like opening a PDF in the browser — while the
   address bar keeps the Thornhill link.
   ========================================================================== */
(function () {
  const $ = s => document.querySelector(s);
  const Docs = window.ThornhillDocs;
  const match = location.pathname.match(/^\/d\/([a-z0-9-]{1,60})\/?$/i);

  if (!match) return showNotFound(false);

  const slug = match[1].toLowerCase();
  const viewer = $("#viewer"), stage = $("#stage");
  viewer.hidden = false;
  document.body.classList.add("viewing");
  document.title = "Loading…";

  function showNotFound(isDoc) {
    $("#viewer").hidden = true;
    document.body.classList.remove("viewing");
    $("#notFound").hidden = false;
    if (isDoc) {
      $("#nfEyebrow").textContent = "Document not found";
      $("#nfTitle").textContent = "This document link isn't available.";
      $("#nfText").textContent = "It may have been removed, or the link may be mistyped. Check the link you were sent, or contact us and we'll help.";
      $("#nfDocs").hidden = false;
      document.title = "Document not found — Thornhill Corporation";
    } else {
      document.title = "Page not found — Thornhill Corporation";
    }
  }

  function fill(src, title) {
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = title;
    frame.allow = "fullscreen";
    frame.setAttribute("allowfullscreen", "");
    viewer.innerHTML = "";
    viewer.appendChild(frame);
  }

  function fail(msg, href) {
    stage.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = msg;
    stage.appendChild(p);
    if (href) {
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open document";
      stage.appendChild(a);
    }
  }

  (async function () {
    let doc;
    try {
      doc = await window.ThornhillStore.getDocument(slug);
    } catch (e) {
      console.error(e);
      document.title = "Couldn't open document";
      return fail("Couldn't reach the server. Please check your connection and reload the page.");
    }
    if (!doc) return showNotFound(true);

    // The tab shows the document's name, like a PDF's file name
    document.title = doc.title;

    if (doc.kind === "google") {
      const g = Docs.parseGoogle(doc.url);
      if (!g) return fail("This document can't be shown here.", doc.url);
      return fill(g.embed, doc.title);
    }

    // PDF stored in the database → the browser's own PDF viewer
    let url;
    try {
      const bin = atob(doc.pdf_data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new File([bytes], doc.file_name || doc.title + ".pdf", { type: "application/pdf" }));
    } catch (e) {
      return fail("This PDF couldn't be opened.");
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.pdfViewerEnabled === false;
    if (isMobile) {
      // Phones can't show a PDF inside a page, so hand it straight to the phone's PDF viewer
      location.replace(url);
      fail("Opening PDF…");
      const a = document.createElement("a"); a.href = url; a.textContent = "Tap here if it doesn't open"; stage.appendChild(a);
      return;
    }
    fill(url, doc.title);
  })();
})();
