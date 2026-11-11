/* ==========================================================================
   Thornhill Corporation — Shared UI behaviour
   Theme toggle, mobile nav, scroll effects, reveal animations, toasts
   ========================================================================== */
(function () {
  const cfg = window.THORNHILL_CONFIG || {};
  const root = document.documentElement;

  /* ---------- Theme ---------- */
  function setTheme(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("thornhill.theme", t); } catch (e) {}
    document.querySelectorAll(".theme-toggle").forEach(b =>
      b.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode"));
  }
  document.querySelectorAll(".theme-toggle").forEach(btn => {
    btn.addEventListener("click", () => setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));
  });
  setTheme(root.getAttribute("data-theme") || "light");

  /* ---------- Config text ---------- */
  document.querySelectorAll("[data-support-email]").forEach(el => {
    if (!cfg.supportEmail) return;
    el.textContent = cfg.supportEmail;
    if (el.tagName === "A") el.href = "mailto:" + cfg.supportEmail;
  });
  document.querySelectorAll("[data-year]").forEach(el => el.textContent = new Date().getFullYear());

  /* ---------- Nav ---------- */
  const nav = document.querySelector(".nav");
  const menuBtn = document.querySelector(".menu-toggle");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open);
    });
    nav.querySelectorAll(".nav-links a").forEach(a => a.addEventListener("click", () => {
      nav.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false");
    }));
  }
  const toTop = document.querySelector(".to-top");
  const onScroll = () => {
    const y = window.scrollY;
    if (nav) nav.classList.toggle("scrolled", y > 8);
    if (toTop) toTop.classList.toggle("show", y > 600);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  if (toTop) toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  /* Highlight current section in nav on the home page */
  const sectionLinks = [...document.querySelectorAll('.nav-links a[href^="#"], .nav-links a[href^="index.html#"]')];
  if (sectionLinks.length && "IntersectionObserver" in window) {
    const map = new Map();
    sectionLinks.forEach(a => {
      const id = a.getAttribute("href").split("#")[1];
      const sec = id && document.getElementById(id);
      if (sec) map.set(sec, a);
    });
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          sectionLinks.forEach(l => l.classList.remove("active"));
          map.get(en.target).classList.add("active");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    map.forEach((_, sec) => io.observe(sec));
  }

  /* ---------- Reveal ---------- */
  const reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const rio = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); rio.unobserve(en.target); } });
    }, { threshold: 0.12 });
    reveals.forEach(el => rio.observe(el));
  } else {
    reveals.forEach(el => el.classList.add("in"));
  }

  /* ---------- Gallery lightbox ---------- */
  const lb = document.querySelector(".lightbox");
  if (lb) {
    const lbImg = lb.querySelector("img");
    document.querySelectorAll(".gallery figure").forEach(fig => {
      fig.addEventListener("click", () => {
        const img = fig.querySelector("img");
        if (!img) return; // placeholder slot — no photo yet
        lbImg.src = img.src; lbImg.alt = img.alt;
        lb.classList.add("open");
      });
    });
    lb.addEventListener("click", () => lb.classList.remove("open"));
    document.addEventListener("keydown", e => { if (e.key === "Escape") lb.classList.remove("open"); });
  }

  /* ---------- Toast ---------- */
  window.toast = function (msg, type) {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; wrap.setAttribute("role", "status"); document.body.appendChild(wrap); }
    const t = document.createElement("div");
    t.className = "toast" + (type === "error" ? " error" : "");
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2800);
    setTimeout(() => t.remove(), 3200);
  };
})();
