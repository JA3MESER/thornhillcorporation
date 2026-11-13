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
  if (btn) {
    if (!supported) {
      btn.disabled = true;
      help.textContent = "This browser doesn't support Thornhill Quick. Use an up-to-date Chrome, Edge, Safari or Firefox.";
    } else if (!Store.live) {
      btn.disabled = true;
      help.textContent = "Thornhill Quick will be available once the website is connected to Supabase.";
    }
    btn.addEventListener("click", signIn);
  }

  async function signIn() {
    const err = $("#loginError");
    err.classList.remove("show");
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
      try { localStorage.setItem("thornhill.quick.last", done.name); } catch (e) {}
      admin().startSession({ name: done.name, code: done.token, display: done.name, via: "quick" });
      window.toast("Signed in with Thornhill Quick");
    } catch (e) {
      err.textContent = friendlyError(e);
      err.classList.add("show");
    } finally {
      btn.innerHTML = label;
      btn.disabled = false;
    }
  }

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
