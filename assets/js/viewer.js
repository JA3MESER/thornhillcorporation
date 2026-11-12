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

  if (!match) {
    // On the staff Link Hub, anything that isn't a document link goes to the sign-in page
    if (document.body.dataset.site === "hub") return location.replace("/");
    return showNotFound(false);
  }

  // Document links now live on the staff Link Hub — forward any old main-site links there
  if (document.body.dataset.site !== "hub") {
    location.replace(window.ThornhillSites.hub() + "/d/" + match[1].toLowerCase());
    return;
  }

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

  /** Show a PDF in the browser's own PDF viewer, filling the window */
  function showPdf(blob, fileName) {
    clearTimeout(watchdog);
    const url = URL.createObjectURL(new File([blob], fileName, { type: "application/pdf" }));
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.pdfViewerEnabled === false;
    if (isMobile) {
      // Phones can't show a PDF inside a page, so hand it straight to the phone's PDF viewer
      location.replace(url);
      fail("Opening PDF…");
      const a = document.createElement("a"); a.href = url; a.textContent = "Tap here if it doesn't open"; stage.appendChild(a);
      return;
    }
    fill(url, document.title);
  }

  /** Ask the Supabase "google-pdf" function for a Google file as a PDF. Returns a Blob, or null. */
  async function fetchGooglePdf(code) {
    const cfg = window.THORNHILL_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
    const base = cfg.supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
    const key = cfg.supabaseAnonKey.trim();
    const headers = { apikey: key };
    if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(base + "/functions/v1/google-pdf?code=" + encodeURIComponent(code), { headers, signal: ctrl.signal });
      if (!res.ok || !(res.headers.get("content-type") || "").includes("pdf")) return null;
      const blob = await res.blob();
      return blob.size > 0 ? blob : null;
    } catch (e) {
      return null; // helper not deployed, Google refused, or timed out → fall back to preview
    } finally {
      clearTimeout(t);
    }
  }

  // Safety net: never leave someone on an endless loading screen
  const watchdog = setTimeout(() => {
    if (!viewer.querySelector("iframe")) {
      fail("This is taking longer than expected.");
      const a = document.createElement("a"); a.href = location.href; a.textContent = "Reload the page"; stage.appendChild(a);
    }
  }, 20000);

  (async function () {
    let doc;
    try {
      doc = await window.ThornhillStore.getDocument(slug);
    } catch (e) {
      console.error(e);
      document.title = "Couldn't open document";
      return fail("Couldn't reach the server. Please check your connection and reload the page.");
    }
    clearTimeout(watchdog);
    if (!doc) return showNotFound(true);

    // The tab shows the document's name, like a PDF's file name
    document.title = doc.title;

    if (doc.kind === "google") {
      const g = Docs.parseGoogle(doc.url);
      // Best: ask the google-pdf helper on Supabase for a real PDF, so it opens in
      // the browser's normal PDF viewer. If that isn't set up, use Google's preview.
      const pdf = await fetchGooglePdf(doc.slug);
      if (pdf) return showPdf(pdf, doc.title + ".pdf");
      if (!g) return fail("This document can't be shown here.", doc.url);
      return fill(g.embed, doc.title);
    }

    // PDF stored in the database
    let blob;
    try {
      const bin = atob(doc.pdf_data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: "application/pdf" });
    } catch (e) {
      return fail("This PDF couldn't be opened.");
    }
    showPdf(blob, doc.file_name || doc.title + ".pdf");
  })().catch(e => {
    console.error(e);
    clearTimeout(watchdog);
    fail("Sorry, this document couldn't be opened. Please reload the page.");
  });
})();
