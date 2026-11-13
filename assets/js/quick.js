/* ==========================================================================
   Thornhill Corporation — Thornhill Quick
   Staff sign in with their fingerprint, face or device PIN (a "passkey").
   The passkey is checked by the "quick" Supabase function, which only lets
   in devices that a signed-in staff member registered.
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const admin = () => window.ThornhillAdmin;
  const supported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const DISMISS_KEY = "thornhill.quick.dismissed.";

  /* ---------- helpers ---------- */
  const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const toB64url = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
    const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return br ? `${os} · ${br}` : os;
  }
  function friendlyError(e) {
    if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return "Thornhill Quick was cancelled or timed out.";
    if (e && e.name === "InvalidStateError") return "This device is already set up for Thornhill Quick.";
    if (e && e.name === "SecurityError") return "Thornhill Quick only works on the Thornhill website address.";
    return (e && e.message) || "Thornhill Quick didn't work. Please try again.";
  }

  /* ======================================================================
     Sign in with Thornhill Quick
     ====================================================================== */
  const btn = $("#quickBtn"), help = $("#quickHelp");
  const choice = $("#quickChoice"), linkBox = $("#quickLink");
  // Phones and tablets have fingerprint/face built in; computers often don't, so they get a choice
  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  if (btn) {
    if (!Store.live) {
      btn.disabled = true;
      help.textContent = "Thornhill Quick will be available once the website is connected to Supabase.";
    }
    btn.addEventListener("click", () => {
      $("#loginError").classList.remove("show");
      if (isPhone && supported) return signInWithDevice();
      const open = choice.hidden;
      choice.hidden = !open; linkBox.hidden = true; stopLink();
      btn.setAttribute("aria-expanded", open);
    });
    choice.addEventListener("click", e => {
      const b = e.target.closest("[data-qc]");
      if (!b) return;
      if (b.dataset.qc === "phone") startLink();
      else if (supported) signInWithDevice();
      else showErr("This browser doesn't support passkeys. Use “Use my phone” instead.");
    });
    $("#qlCancel").addEventListener("click", () => { stopLink(); linkBox.hidden = true; choice.hidden = false; });
    $("#qlRetry").addEventListener("click", startLink);
  }
  const showErr = m => { const err = $("#loginError"); err.textContent = m; err.classList.add("show"); };

  // ---- Sign in with this device's passkey ----
  async function signInWithDevice() {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.querySelector(".lbl").textContent = "Waiting for your device…";
    try {
      const begin = await Store.quickFunction({ action: "begin_login" });
      const o = begin.options;
      const cred = await navigator.credentials.get({
        publicKey: { challenge: fromB64url(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout }
      });
      btn.querySelector(".lbl").textContent = "Verifying…";
      const r = cred.response;
      const done = await Store.quickFunction({
        action: "finish_login", challenge_id: begin.challenge_id,
        credential: {
          id: toB64url(cred.rawId), clientDataJSON: toB64url(r.clientDataJSON),
          authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature),
          userHandle: r.userHandle ? toB64url(r.userHandle) : null
        }
      });
      choice.hidden = true;
      admin().startSession({ name: done.name, code: done.token, display: done.name, via: "quick" });
      window.toast("Signed in with Thornhill Quick");
    } catch (e) {
      showErr(friendlyError(e));
    } finally {
      btn.innerHTML = label;
      btn.disabled = false;
    }
  }

  // ---- Sign in by approving on your phone (Thornhill ID) ----
  let link = null, pollTimer = null, clockTimer = null;
  function stopLink() { clearInterval(pollTimer); clearInterval(clockTimer); pollTimer = clockTimer = null; link = null; }
  const idUrl = () => (window.ThornhillSites ? window.ThornhillSites.main() : location.origin) + "/id";

  async function startLink() {
    stopLink();
    choice.hidden = true; linkBox.hidden = false;
    $("#qlRetry").hidden = true; $("#qlCancel").hidden = false;
    $("#qlStatus").innerHTML = 'Getting a code… <span id="qlTime"></span>';
    $("#qlCode").textContent = "——— ———"; $("#qlQr").innerHTML = "";
    $("#qlUrl").textContent = idUrl().replace(/^https?:\/\//, "");
    try {
      link = await Store.quickLinkStart(deviceLabel());
    } catch (e) { $("#qlStatus").textContent = e.message; $("#qlRetry").hidden = false; return; }
    const pretty = link.code.slice(0, 3) + "-" + link.code.slice(3);
    $("#qlCode").textContent = pretty;
    if (window.ThornhillQR) $("#qlQr").innerHTML = window.ThornhillQR.svg(idUrl() + "?code=" + link.code, { size: 168 });
    $("#qlStatus").innerHTML = 'Waiting for your phone… <span id="qlTime"></span>';
    const ends = new Date(link.expires_at).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
      const t = $("#qlTime"); if (t) t.textContent = "(" + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + ")";
      if (left <= 0) expired();
    };
    tick(); clockTimer = setInterval(tick, 1000);
    const mine = link;
    pollTimer = setInterval(async () => {
      if (link !== mine) return;
      let r;
      try { r = await Store.quickLinkPoll(mine.id, mine.secret); } catch (e) { return; }
      if (link !== mine || !r) return;
      if (r.status === "approved" && r.token) {
        stopLink(); linkBox.hidden = true;
        admin().startSession({ name: r.name, code: r.token, display: r.name, via: "quick" });
        window.toast("Approved on your phone — welcome back");
      } else if (r.status === "denied") {
        stopLink();
        $("#qlStatus").textContent = "Sign-in was denied on your phone.";
        $("#qlRetry").hidden = false;
      } else if (r.status === "expired" || r.status === "used") expired();
    }, 2000);
  }
  function expired() {
    stopLink();
    $("#qlStatus").textContent = "This code has expired.";
    $("#qlCode").textContent = "——— ———"; $("#qlQr").innerHTML = "";
    $("#qlRetry").hidden = false;
  }
  document.addEventListener("thornhill:login", () => { stopLink(); if (linkBox) linkBox.hidden = true; if (choice) choice.hidden = true; });

  /* ======================================================================
     Set up / manage (after signing in)
     ====================================================================== */
  async function register() {
    const s = admin().session();
    if (!s) return;
    const begin = await Store.quickFunction({ action: "begin_register", name: s.name, code: s.code });
    const o = begin.options;
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(o.challenge), rp: o.rp,
        user: { id: fromB64url(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams, authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: o.excludeCredentials.map(x => ({ type: "public-key", id: fromB64url(x.id) })),
        attestation: "none", timeout: o.timeout
      }
    });
    const r = cred.response;
    const pk = r.getPublicKey && r.getPublicKey();
    if (!pk) throw new Error("This browser can't set up Thornhill Quick. Please update it, or try Chrome, Edge or Safari.");
    await Store.quickFunction({
      action: "finish_register", name: s.name, code: s.code, challenge_id: begin.challenge_id, label: deviceLabel(),
      credential: {
        id: toB64url(cred.rawId), clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.getAuthenticatorData()), publicKey: toB64url(pk),
        publicKeyAlgorithm: r.getPublicKeyAlgorithm(), transports: r.getTransports ? r.getTransports() : []
      }
    });
  }

  // Prompt to set up after a normal sign-in
  const prompt = $("#quickPrompt");
  async function maybePrompt() {
    const s = admin() && admin().session();
    if (!prompt || !s || !supported || !Store.live || s.via === "quick") { if (prompt) prompt.hidden = true; return; }
    try { if (localStorage.getItem(DISMISS_KEY + s.name.toLowerCase())) return; } catch (e) {}
    try {
      const o = await Store.quickOverview(s.name, s.code);
      prompt.hidden = o.devices.length > 0;
    } catch (e) { prompt.hidden = true; }
  }
  if (prompt) {
    prompt.querySelector("[data-quick-setup]").addEventListener("click", async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await register(); prompt.hidden = true; window.toast("Thornhill Quick is set up on this device"); }
      catch (ex) { if (ex.status === 401) return admin().expire(); window.toast(friendlyError(ex), "error"); }
      finally { b.disabled = false; }
    });
    prompt.querySelector("[data-quick-later]").addEventListener("click", () => {
      prompt.hidden = true;
      try { localStorage.setItem(DISMISS_KEY + admin().session().name.toLowerCase(), "1"); } catch (e) {}
    });
  }
  document.addEventListener("thornhill:login", () => setTimeout(maybePrompt, 400));
  document.addEventListener("thornhill:logout", () => { if (prompt) prompt.hidden = true; closeManage(); });

  // Manage window
  const modal = $("#quickModal");
  const manageBtn = $("#quickManageBtn");
  function closeManage() { if (modal) modal.classList.remove("open"); }
  async function openManage() {
    modal.classList.add("open");
    await renderManage();
  }
  async function renderManage() {
    const s = admin().session(), body = $("#quickBody");
    body.innerHTML = '<p class="muted">Loading…</p>';
    let o;
    try { o = await Store.quickOverview(s.name, s.code); }
    catch (e) { if (e.status === 401) return admin().expire(); body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const fmt = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never";
    body.innerHTML = `
      <p>Thornhill Quick lets you sign in with your fingerprint, face or device PIN instead of your special code. Your fingerprint or face never leaves your device.</p>
      <div class="q-status">${s.via === "quick" ? "✓ You signed in with Thornhill Quick" : "You signed in with your name and special code"}</div>
      <h4>Your devices</h4>
      <div class="q-list">${o.devices.length ? o.devices.map(d => `
        <div class="q-item">
          <div class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 11c0 3.5-1 6.5-2.5 9"/><path d="M8.5 8.5A4 4 0 0 1 16 11c0 1.6-.1 3.1-.4 4.5"/><path d="M5 11a7 7 0 0 1 12.6-4.2"/><path d="M19 13c0 1.7-.2 3.3-.6 4.8"/><path d="M12 15c0 2-.4 3.9-1 5.6"/></svg></div>
          <div class="q-info"><strong>${esc(d.label || "Device")}</strong><span>Added ${esc(fmt(d.created_at))} · Last used ${esc(fmt(d.last_used_at))}</span></div>
          <button class="btn btn-danger btn-sm" type="button" data-q-remove="${esc(d.id)}">Remove</button>
        </div>`).join("") : '<p class="muted">No devices yet.</p>'}</div>
      <div class="q-phone">
        <div class="q-phone-qr">${window.ThornhillQR ? window.ThornhillQR.svg((window.ThornhillSites ? window.ThornhillSites.main() : location.origin) + "/id", { size: 112 }) : ""}</div>
        <div><strong>Your Thornhill ID</strong><span>Scan this with your phone to open your Thornhill ID. Add it to your home screen, then use it to approve sign-ins on any computer. Your phone needs Thornhill Quick set up first: sign in to this panel on your phone and tap “Set up on this device”.</span></div>
      </div>
      <div class="q-actions">
        <button class="btn btn-primary btn-sm" type="button" data-q-add ${supported ? "" : "disabled"}>Set up this device</button>
        <button class="btn btn-ghost btn-sm" type="button" data-q-all ${o.sessions ? "" : "disabled"}>Sign out of all Thornhill Quick sessions (${o.sessions})</button>
      </div>
      <p class="muted">If a device is lost or stolen, remove it here straight away. Anyone signing in with Thornhill Quick must still unlock that device with its fingerprint, face or PIN.</p>`;
    body.querySelector("[data-q-add]").addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      try { await register(); window.toast("Thornhill Quick is set up on this device"); }
      catch (ex) { if (ex.status === 401) return admin().expire(); window.toast(friendlyError(ex), "error"); }
      renderManage();
    });
    body.querySelector("[data-q-all]").addEventListener("click", () => {
      if (window.confirm("Sign out every Thornhill Quick session, including this one if you used Thornhill Quick?")) { closeManage(); admin().signOutAll(); }
    });
    body.querySelectorAll("[data-q-remove]").forEach(b => b.addEventListener("click", async () => {
      if (!window.confirm("Remove this device from Thornhill Quick?")) return;
      try { await Store.quickRemoveDevice(s.name, s.code, b.dataset.qRemove); window.toast("Device removed"); renderManage(); }
      catch (e) { if (e.status === 401) return admin().expire(); window.toast(e.message, "error"); }
    }));
  }
  if (manageBtn && modal) {
    manageBtn.addEventListener("click", openManage);
    modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-close]")) closeManage(); });
  }
})();
