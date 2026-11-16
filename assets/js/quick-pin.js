/* ==========================================================================
   Thornhill Corporation — Thornhill Quick PIN (trusted PCs)
   After signing in properly once, staff can trust their own PC and choose a
   6-digit PIN. Signing in then needs both the secret stored on that PC and
   the PIN. 5 wrong PINs and the PC is forgotten.
   ========================================================================== */
(function () {
  const Store = window.ThornhillStore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const admin = () => window.ThornhillAdmin;
  const KEY = "thornhill.quick.pc";
  const DISMISS = "thornhill.pin.dismissed.";
  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  /* ---------- this PC's saved trust ---------- */
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } };
  const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  const forget = () => { try { localStorage.removeItem(KEY); } catch (e) {} };

  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux PC" : "Computer";
    const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return br ? `${os} · ${br}` : os;
  }
  const initials = n => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "TC";

  /* ---------- 6 PIN boxes ---------- */
  function pinBoxes(container, onComplete) {
    container.innerHTML = Array.from({ length: 6 }, (_, i) =>
      `<input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Digit ${i + 1}">`).join("");
    const boxes = [...container.querySelectorAll("input")];
    const value = () => boxes.map(b => b.value).join("");
    boxes.forEach((b, i) => {
      b.addEventListener("input", () => {
        const digits = b.value.replace(/\D/g, "");
        if (digits.length > 1) { fill(digits, i); return; }
        b.value = digits;
        if (digits && i < 5) boxes[i + 1].focus();
        if (value().length === 6 && onComplete) onComplete(value());
      });
      b.addEventListener("keydown", e => {
        if (e.key === "Backspace" && !b.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ""; e.preventDefault(); }
        if (e.key === "ArrowLeft" && i > 0) boxes[i - 1].focus();
        if (e.key === "ArrowRight" && i < 5) boxes[i + 1].focus();
      });
      b.addEventListener("paste", e => {
        e.preventDefault();
        fill((e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, ""), 0);
      });
      b.addEventListener("focus", () => b.select());
    });
    function fill(digits, from) {
      digits.slice(0, 6 - from).split("").forEach((d, k) => { boxes[from + k].value = d; });
      boxes[Math.min(5, from + digits.length)].focus();
      if (value().length === 6 && onComplete) onComplete(value());
    }
    return {
      value,
      clear() { boxes.forEach(b => { b.value = ""; }); boxes[0].focus(); },
      focus() { (boxes.find(b => !b.value) || boxes[5]).focus(); },
      shake() { container.classList.remove("shake"); void container.offsetWidth; container.classList.add("shake"); },
      disable(on) { boxes.forEach(b => { b.disabled = on; }); }
    };
  }

  /* ======================================================================
     Sign-in screen: "Welcome back, Jane — enter your PIN"
     ====================================================================== */
  const card = document.querySelector(".login-card");
  const pinView = $("#pinLogin");
  const pinErr = $("#pinError");
  const pinBtn = $("#pinBtn");
  let pin = null, busy = false;

  function showPinScreen(name) {
    card.classList.add("pin-mode");
    pinView.hidden = false;
    $("#pinAvatar").textContent = initials(name);
    $("#pinTitle").textContent = "Welcome back, " + String(name).split(" ")[0];
    pinErr.classList.remove("show");
    if (!pin) pin = pinBoxes($("#pinBoxes"), () => signIn());
    pin.clear();
  }
  function showStandard() {
    card.classList.remove("pin-mode");
    pinView.hidden = true;
  }
  const pinError = m => { pinErr.textContent = m; pinErr.classList.add("show"); };

  async function signIn() {
    const pc = load();
    if (busy || !pc || !pin || pin.value().length !== 6) {
      if (pin && pin.value().length !== 6) { pinError("Enter all 6 numbers of your PIN."); pin.focus(); }
      return;
    }
    busy = true; pinBtn.disabled = true; pinBtn.textContent = "Signing in…"; pin.disable(true);
    try {
      const r = await Store.pinSignIn(pc.id, pc.secret, pin.value());
      if (r && r.ok) {
        save(Object.assign(pc, { name: r.name }));
        showStandard();
        admin().startSession({ name: r.name, code: r.token, display: r.name, via: "pin" });
        return;
      }
      if (r && r.forgotten) {
        forget(); showStandard();
        const err = $("#loginError");
        err.textContent = r.locked ? "Too many wrong PINs, so this PC has been forgotten. Please sign in with your name and code, then set a new PIN."
                                   : "PIN sign-in has ended on this PC. Please sign in with your name and code.";
        err.classList.add("show");
        return;
      }
      pin.shake(); pin.disable(false); pin.clear();
      pinError(r && r.remaining != null
        ? `That PIN isn't right. ${r.remaining} ${r.remaining === 1 ? "try" : "tries"} left before this PC is forgotten.`
        : "That PIN isn't right.");
    } catch (e) {
      pin.disable(false); pin.focus();
      pinError(/fetch|network/i.test(e.message) ? "Can't reach Thornhill right now. Check your internet connection." : (e.message || "Something went wrong."));
    } finally {
      busy = false; pinBtn.disabled = false; pinBtn.textContent = "Sign in";
      if (pin) pin.disable(false);
    }
  }

  if (pinView) {
    $("#pinForm").addEventListener("submit", e => { e.preventDefault(); signIn(); });
    $("#pinOther").addEventListener("click", () => { showStandard(); $("#adminName").focus(); });
    $("#pinForget").addEventListener("click", () => {
      if (!window.confirm("Forget this PC? You'll need to sign in with your name and code next time.")) return;
      forget(); showStandard(); window.toast("This PC has been forgotten");
    });

    // On the sign-in screen: if this PC is trusted, go straight to the PIN
    async function checkTrusted() {
      const pc = load();
      if (!pc || !Store.live || (admin() && admin().session())) return;
      showPinScreen(pc.name || "");
      try {
        const r = await Store.pinDeviceInfo(pc.id, pc.secret);
        if (r && r.ok) { save(Object.assign(pc, { name: r.name })); $("#pinTitle").textContent = "Welcome back, " + r.name.split(" ")[0]; $("#pinAvatar").textContent = initials(r.name); }
        else { forget(); showStandard(); }
      } catch (e) { /* offline: keep the PIN screen, sign-in will explain */ }
    }
    checkTrusted();
    document.addEventListener("thornhill:logout", () => setTimeout(checkTrusted, 50));
  }

  /* ======================================================================
     Set up: banner after a normal sign-in on a PC, and the setup window
     ====================================================================== */
  const prompt = $("#pinPrompt");
  const modal = $("#pinModal");
  let pNew = null, pConfirm = null;

  async function maybePrompt() {
    const s = admin() && admin().session();
    if (!prompt) return;
    prompt.hidden = true;
    if (!s || !Store.live || isPhone || s.via === "pin") return;
    const pc = load();
    if (pc && pc.name && pc.name.toLowerCase() === s.name.toLowerCase()) return;
    try { if (localStorage.getItem(DISMISS + s.name.toLowerCase())) return; } catch (e) {}
    prompt.hidden = false;
  }

  function openSetup() {
    $("#pinSetupError").classList.remove("show");
    $("#pinLabel").value = deviceLabel();
    if (!pNew) pNew = pinBoxes($("#pinNew"), () => pConfirm.focus());
    if (!pConfirm) pConfirm = pinBoxes($("#pinConfirm"));
    modal.classList.add("open");
    pConfirm.clear(); pNew.clear();
  }
  const closeSetup = () => modal.classList.remove("open");
  const setupError = m => { const el = $("#pinSetupError"); el.textContent = m; el.classList.add("show"); };

  if (modal) {
    modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-close]")) closeSetup(); });
    $("#pinSetupForm").addEventListener("submit", async e => {
      e.preventDefault();
      const a = pNew.value(), b = pConfirm.value();
      if (a.length !== 6) { setupError("Choose a PIN with 6 numbers."); pNew.focus(); return; }
      if (a !== b) { setupError("The two PINs don't match. Please type them again."); pConfirm.clear(); pConfirm.shake(); return; }
      const s = admin().session();
      const btn = $("#pinSave"); btn.disabled = true; btn.textContent = "Saving…";
      try {
        const old = load();
        const r = await Store.pinSetup(s.name, s.code, a, $("#pinLabel").value.trim() || deviceLabel());
        save({ id: r.device, secret: r.secret, name: r.name });
        // Changing the PIN replaces this PC's old trust record
        if (old && old.id && old.name && old.name.toLowerCase() === r.name.toLowerCase()) Store.pinRemove(s.name, s.code, old.id).catch(() => {});
        closeSetup();
        if (prompt) prompt.hidden = true;
        window.toast("PIN sign-in is set up on this PC");
        document.dispatchEvent(new Event("thornhill:pin-changed"));
      } catch (ex) {
        if (ex.status === 401) { closeSetup(); return admin().expire(); }
        setupError(ex.message);
        pNew.clear(); pConfirm.clear();
      } finally { btn.disabled = false; btn.textContent = "Save PIN"; }
    });
  }
  if (prompt) {
    prompt.querySelector("[data-pin-setup]").addEventListener("click", openSetup);
    prompt.querySelector("[data-pin-later]").addEventListener("click", () => {
      prompt.hidden = true;
      try { localStorage.setItem(DISMISS + admin().session().name.toLowerCase(), "1"); } catch (e) {}
    });
  }
  document.addEventListener("thornhill:login", () => setTimeout(maybePrompt, 300));
  document.addEventListener("thornhill:logout", () => { if (prompt) prompt.hidden = true; closeSetup(); });

  /* ---------- "Trusted PCs" section in the Thornhill Quick window ---------- */
  async function renderManage() {
    const box = $("#pinManage");
    if (!box) return;
    const s = admin().session();
    let list = [];
    try { list = (await Store.pinDevices(s.name, s.code)).devices; } catch (e) { if (e.status === 401) return admin().expire(); }
    const mine = load();
    const fmt = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Never";
    box.innerHTML = `
      <h4>Trusted PCs <span class="muted" style="margin:0;font-weight:500">· sign in with a 6-digit PIN</span></h4>
      <div class="q-list">${list.length ? list.map(d => `
        <div class="q-item">
          <div class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M2 20h20"/></svg></div>
          <div class="q-info"><strong>${esc(d.label || "PC")}${mine && mine.id === d.id ? ' <span class="pin-this">This PC</span>' : ""}</strong><span>Added ${esc(fmt(d.created_at))} · Last used ${esc(fmt(d.last_used_at))}</span></div>
          <button class="btn btn-danger btn-sm" type="button" data-pin-remove="${esc(d.id)}">Remove</button>
        </div>`).join("") : '<p class="muted" style="margin-top:0">No trusted PCs yet.</p>'}</div>
      ${isPhone ? "" : `<div class="q-actions" style="margin-top:10px"><button class="btn btn-primary btn-sm" type="button" data-pin-add>${mine && list.some(d => d.id === mine.id) ? "Change this PC's PIN" : "Set up PIN on this PC"}</button></div>`}`;
    const add = box.querySelector("[data-pin-add]");
    if (add) add.addEventListener("click", () => { document.querySelector("#quickModal").classList.remove("open"); openSetup(); });
    box.querySelectorAll("[data-pin-remove]").forEach(b => b.addEventListener("click", async () => {
      if (!window.confirm("Remove this PC? It will need your name and code to sign in again.")) return;
      try {
        await Store.pinRemove(s.name, s.code, b.dataset.pinRemove);
        if (mine && mine.id === b.dataset.pinRemove) forget();
        window.toast("PC removed"); renderManage();
      } catch (e) { if (e.status === 401) return admin().expire(); window.toast(e.message, "error"); }
    }));
  }
  document.addEventListener("thornhill:quick-manage", renderManage);
})();
