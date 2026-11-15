/* Thornhill Corporation — Roblox Advice Request form (Form RA-1) */
(function () {
  const form = document.getElementById("adviceForm");
  if (!form) return;
  const success = document.getElementById("success");
  const btn = document.getElementById("submitBtn");
  const ackStop = document.getElementById("ackStop");
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const UK = ["England", "Wales", "Scotland", "Northern Ireland"];

  [["details", "detailsCount"], ["notes", "notesCount"]].forEach(([f, c]) => {
    const el = document.getElementById(f), out = document.getElementById(c);
    el.addEventListener("input", () => { out.textContent = el.value.length + " / 5000"; });
  });

  const radio = name => (form.querySelector(`input[name="${name}"]:checked`) || {}).value || "";
  const ticked = id => document.getElementById(id).checked;
  const checks = {
    fullName: () => form.fullName.value.trim().length >= 2,
    email: () => emailRe.test(form.email.value.trim()),
    subject: () => form.subject.value.trim().length >= 2,
    details: () => form.details.value.trim().length >= 10,
    priority: () => !!radio("priority"),
    region: () => UK.includes(form.region.value),
    acknowledged: () => radio("acknowledged") === "Yes",
    ukResident: () => ticked("ukResident"),
    ageConfirmed: () => ticked("ageConfirmed"),
    privacyRead: () => ticked("privacyRead")
  };
  const fieldOf = key => {
    const el = form.querySelector(`[name="${key}"]`);
    return { el, wrap: el.closest(".field") };
  };
  function validate(key) {
    const ok = checks[key]();
    const { el, wrap } = fieldOf(key);
    wrap.classList.toggle("invalid", !ok);
    el.setAttribute("aria-invalid", !ok);
    return ok;
  }

  // Answering "No" to the guidance question explains why we can't continue
  form.querySelectorAll('input[name="acknowledged"]').forEach(r => r.addEventListener("change", () => {
    ackStop.hidden = radio("acknowledged") !== "No";
    btn.disabled = radio("acknowledged") === "No";
  }));

  Object.keys(checks).forEach(key => {
    form.querySelectorAll(`[name="${key}"]`).forEach(el => {
      const evt = el.type === "radio" || el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "blur";
      el.addEventListener(evt, () => { if (el.value || el.type === "checkbox" || el.type === "radio") validate(key); });
      el.addEventListener("input", () => { if (fieldOf(key).wrap.classList.contains("invalid")) validate(key); });
    });
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const keys = Object.keys(checks);
    const results = keys.map(validate);
    const bad = results.indexOf(false);
    if (bad >= 0) {
      const { el, wrap } = fieldOf(keys[bad]);
      wrap.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
      return;
    }
    if (form.website.value) { showSuccess("TH-SPAM00"); return; }

    const data = {
      fullName: form.fullName.value.trim(),
      email: form.email.value.trim(),
      subject: form.subject.value.trim(),
      details: form.details.value.trim(),
      priority: radio("priority"),
      region: form.region.value,
      acknowledged: radio("acknowledged"),
      notes: form.notes.value.trim(),
      ukResident: ticked("ukResident"),
      ageConfirmed: ticked("ageConfirmed")
    };

    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "Sending…";
    try {
      const ref = await window.ThornhillStore.submitRobloxAdvice(data);
      window.ThornhillStore.requestAck(ref);
      document.getElementById("successName").textContent = data.fullName.split(" ")[0];
      document.getElementById("successEmail").textContent = data.email;
      showSuccess(ref);
    } catch (err) {
      console.error(err);
      const msg = String((err && err.message) || "");
      window.toast(/too many/i.test(msg) ? "You've sent a few requests already. Please try again later."
        : "Sorry, we couldn't send your request. Please try again in a moment.", "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });

  function showSuccess(ref) {
    document.getElementById("successRef").textContent = ref;
    form.style.display = "none";
    success.classList.add("show");
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  document.getElementById("newEnquiry").addEventListener("click", () => {
    form.reset();
    ["detailsCount", "notesCount"].forEach(id => { document.getElementById(id).textContent = "0 / 5000"; });
    form.querySelectorAll(".field.invalid").forEach(f => f.classList.remove("invalid"));
    ackStop.hidden = true;
    btn.disabled = false;
    success.classList.remove("show");
    form.style.display = "";
    form.fullName.focus();
  });
})();
