/* Thornhill Corporation — Support form */
(function () {
  const form = document.getElementById("supportForm");
  if (!form) return;
  const success = document.getElementById("success");
  const btn = document.getElementById("submitBtn");
  const msg = document.getElementById("message");
  const count = document.getElementById("count");
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  msg.addEventListener("input", () => { count.textContent = msg.value.length + " / 5000"; });

  const rules = {
    fullName: v => v.trim().length >= 2,
    email: v => emailRe.test(v.trim()),
    category: v => v !== "",
    subject: v => v.trim().length >= 2,
    message: v => v.trim().length >= 10
  };

  function validateField(el) {
    const ok = el.type === "checkbox" ? el.checked : (rules[el.name] ? rules[el.name](el.value) : true);
    el.closest(".field").classList.toggle("invalid", !ok);
    el.setAttribute("aria-invalid", !ok);
    return ok;
  }

  form.querySelectorAll("input, select, textarea").forEach(el => {
    if (el.name === "website") return;
    el.addEventListener("blur", () => { if (el.value || el.type === "checkbox") validateField(el); });
    el.addEventListener("input", () => { if (el.closest(".field")?.classList.contains("invalid")) validateField(el); });
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fields = [...form.querySelectorAll("#fullName, #email, #category, #subject, #message, #consent")];
    const results = fields.map(validateField);
    if (results.includes(false)) {
      fields[results.indexOf(false)].focus();
      return;
    }
    // Bot filled the hidden field — pretend success and drop it.
    if (form.website.value) { showSuccess("TH-SPAM00"); return; }

    const data = {
      fullName: form.fullName.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      category: form.category.value,
      subject: form.subject.value.trim(),
      message: form.message.value.trim()
    };

    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "Sending…";
    try {
      const ref = await window.ThornhillStore.submitEnquiry(data);
      document.getElementById("successName").textContent = data.fullName.split(" ")[0];
      document.getElementById("successEmail").textContent = data.email;
      showSuccess(ref);
    } catch (err) {
      console.error(err);
      window.toast("Sorry — we couldn't send that. Please try again in a moment.", "error");
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
    count.textContent = "0 / 5000";
    success.classList.remove("show");
    form.style.display = "";
    form.fullName.focus();
  });
})();
