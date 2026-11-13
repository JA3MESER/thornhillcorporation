/* ==========================================================================
   Thornhill Corporation — Thornhill ID (phone)
   Unlock with Thornhill Quick (passkey), show the staff ID card, and approve
   sign-ins on computers by entering or scanning their code.
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const $ = s => document.querySelector(s);
  const KEY = "thornhill.id.session";
  const LOCK_AFTER = 3 * 60 * 1000;
  let session = null, idleTimer = null, clock = null, pendingCode = null;

  const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const toB64url = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const cleanCode = v => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const initials = n => String(n || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase();
  const ago = iso => { const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000)); return s < 10 ? "just now" : s < 60 ? s + " seconds ago" : Math.round(s / 60) + " minute" + (s >= 90 ? "s" : "") + " ago"; };

  // A code in the address (from scanning the computer's QR code)
  const urlCode = cleanCode(new URLSearchParams(location.search).get("code"));
  if (urlCode) history.replaceState(null, "", location.pathname);

  /* ---------- unlock ---------- */
  const supported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  if (!supported) {
    $("#unlockBtn").disabled = true;
    showErr("#idError", "This browser doesn't support Thornhill Quick. Use Safari on iPhone or Chrome on Android.");
  } else if (!Store.live) {
    $("#unlockBtn").disabled = true;
    showErr("#idError", "Thornhill ID will work once the website is connected to Supabase.");
  }
  if (urlCode) $("#unlockBtn").textContent = "Unlock to approve code " + urlCode.slice(0, 3) + "-" + urlCode.slice(3);

  function showErr(sel, msg) { const e = $(sel); e.textContent = msg; e.classList.toggle("show", !!msg); }

  $("#unlockBtn").addEventListener("click", async () => {
    showErr("#idError", "");
    const b = $("#unlockBtn"), label = b.textContent;
    b.disabled = true; b.textContent = "Waiting for your fingerprint or face…";
    try {
      const begin = await Store.quickFunction({ action: "begin_login" });
      const o = begin.options;
      const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64url(o.challenge), rpId: o.rpId, userVerification: "required", timeout: o.timeout } });
      const r = cred.response;
      const done = await Store.quickFunction({
        action: "finish_login", challenge_id: begin.challenge_id,
        credential: { id: toB64url(cred.rawId), clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature) }
      });
      session = { name: done.name, code: done.token, unlockedAt: Date.now() };
      try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) {}
      await open();
    } catch (e) {
      showErr("#idError", e && (e.name === "NotAllowedError" || e.name === "AbortError") ? "Unlock was cancelled. Try again." : (e && e.message) || "Couldn't unlock your Thornhill ID.");
    } finally { b.disabled = false; b.textContent = label; }
  });

  /* ---------- the ID card ---------- */
  async function open() {
    let card;
    try { card = await Store.idCard(session.name, session.code); }
    catch (e) { return lock("Your Thornhill ID session ended. Unlock again."); }
    $("#lockedView").hidden = true; $("#openView").hidden = false; $("#lockBtn").hidden = false;
    $("#idName").textContent = card.full_name;
    $("#idAvatar").textContent = initials(card.full_name);
    $("#idRole").textContent = card.role;
    $("#idNumber").textContent = card.id_number;
    clearInterval(clock);
    const tick = () => { $("#idTime").textContent = new Date().toLocaleTimeString("en-GB"); };
    tick(); clock = setInterval(tick, 1000);
    renderRecent(card.recent || []);
    resetIdle();
    if (urlCode && !pendingCode) { $("#codeInput").value = urlCode.slice(0, 3) + "-" + urlCode.slice(3); lookup(urlCode); }
  }

  function renderRecent(list) {
    const label = v => ({ quick: "Thornhill Quick", "thornhill-id": "Approved with Thornhill ID" }[v] || v);
    $("#recentList").innerHTML = list.length ? list.map(s => `<li><span><b>${esc(s.device || "Device")}</b><small>${esc(label(s.via))}</small></span><span class="r-side">${s.active ? '<i class="on">Active</i>' : ""}<time>${esc(new Date(s.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</time></span></li>`).join("") : "<li><small>No sign-ins yet.</small></li>";
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function lock(msg) {
    if (session) Store.signOut(session.name, session.code, false);
    session = null; pendingCode = null;
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    clearInterval(clock); clearTimeout(idleTimer);
    $("#openView").hidden = true; $("#lockedView").hidden = false; $("#lockBtn").hidden = true;
    $("#confirmBox").hidden = true; $("#doneBox").hidden = true; $("#codeInput").value = "";
    showErr("#idError", msg || "");
  }
  $("#lockBtn").addEventListener("click", () => lock());
  function resetIdle() { clearTimeout(idleTimer); if (session) idleTimer = setTimeout(() => lock("Locked after 3 minutes. Unlock again to continue."), LOCK_AFTER); }
  ["click", "keydown", "touchstart"].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));

  /* ---------- approving a computer ---------- */
  const input = $("#codeInput");
  input.addEventListener("input", () => {
    const c = cleanCode(input.value);
    input.value = c.length > 3 ? c.slice(0, 3) + "-" + c.slice(3) : c;
  });
  $("#codeForm").addEventListener("submit", e => { e.preventDefault(); lookup(cleanCode(input.value)); });

  async function lookup(code) {
    showErr("#approveError", ""); $("#doneBox").hidden = true; $("#confirmBox").hidden = true;
    if (code.length !== 6) return showErr("#approveError", "Enter the 6-character code from the computer.");
    try {
      const r = await Store.quickLinkLookup(session.name, session.code, code);
      pendingCode = code;
      $("#cfComputer").textContent = r.computer;
      $("#cfWhen").textContent = "Code " + code.slice(0, 3) + "-" + code.slice(3) + " · requested " + ago(r.requested_at);
      $("#confirmBox").hidden = false;
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      if (e.status === 401) return lock("Your Thornhill ID session ended. Unlock again.");
      showErr("#approveError", e.message);
    }
  }

  async function decide(approve) {
    if (!pendingCode) return;
    const btns = [$("#approveBtn"), $("#denyBtn")]; btns.forEach(b => b.disabled = true);
    try {
      const r = await Store.quickLinkDecide(session.name, session.code, pendingCode, approve);
      $("#confirmBox").hidden = true;
      const d = $("#doneBox");
      d.hidden = false;
      d.className = "done " + (approve ? "ok" : "no");
      d.innerHTML = approve
        ? `<strong>✓ Approved</strong><span>${esc(r.computer || "The computer")} is now signed in as you.</span>`
        : "<strong>Sign-in denied</strong><span>The computer was not signed in. If you didn't request this, tell an administrator.</span>";
      input.value = ""; pendingCode = null;
      if (navigator.vibrate) navigator.vibrate(approve ? [20, 40, 20] : 80);
      try { renderRecent((await Store.idCard(session.name, session.code)).recent || []); } catch (e) {}
    } catch (e) {
      if (e.status === 401) return lock("Your Thornhill ID session ended. Unlock again.");
      showErr("#approveError", e.message);
    } finally { btns.forEach(b => b.disabled = false); }
  }
  $("#approveBtn").addEventListener("click", () => decide(true));
  $("#denyBtn").addEventListener("click", () => decide(false));

  /* ---------- add to home screen ---------- */
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; });
  $("#installHint").addEventListener("click", e => {
    e.preventDefault();
    if (installEvt) { installEvt.prompt(); installEvt = null; return; }
    window.toast(/iPhone|iPad/.test(navigator.userAgent) ? "Tap the Share button, then “Add to Home Screen”." : "Open your browser menu, then “Add to Home screen” or “Install app”.");
  });

  /* ---------- resume (same tab, still within the time limit) ---------- */
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY));
    if (saved && saved.code && Date.now() - saved.unlockedAt < LOCK_AFTER) { session = saved; open(); }
  } catch (e) {}
})();
