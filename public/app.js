// =====================================================================
// Stories We Keep — Frontend
// =====================================================================

(async function () {
  "use strict";

  // -------------------------------------------------------------------
  // Load config from server
  // -------------------------------------------------------------------
  let config = {
    calendlyUrl: "https://calendly.com",
    stripePaymentLink: null,
  };

  try {
    const res = await fetch("/api/config");
    if (res.ok) config = await res.json();
  } catch {
    // Use defaults
  }

  // -------------------------------------------------------------------
  // Payment link — set checkout button URL
  // -------------------------------------------------------------------
  const checkoutBtn = document.getElementById("checkout-btn");
  if (checkoutBtn && config.stripePaymentLink) {
    checkoutBtn.href = config.stripePaymentLink;
  }

  // -------------------------------------------------------------------
  // Calendly embed
  // -------------------------------------------------------------------
  const calendlyContainer = document.getElementById("calendly-container");
  const calendlyPlaceholder = document.getElementById("calendly-placeholder");

  if (calendlyContainer && config.calendlyUrl) {
    function initCalendly() {
      if (typeof Calendly === "undefined") return false;

      if (calendlyPlaceholder) calendlyPlaceholder.remove();

      Calendly.initInlineWidget({
        url: config.calendlyUrl,
        parentElement: calendlyContainer,
        prefill: {},
        utm: {},
      });

      const iframe = calendlyContainer.querySelector("iframe");
      if (iframe) {
        iframe.style.minWidth = "100%";
        iframe.style.minHeight = "660px";
      }

      return true;
    }

    // Try immediately, then poll for Calendly script
    if (!initCalendly()) {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        if (initCalendly() || attempts > 40) clearInterval(poll);
      }, 250);
    }
  }

  // -------------------------------------------------------------------
  // Mobile nav toggle
  // -------------------------------------------------------------------
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("nav-links");

  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      navToggle.classList.toggle("nav__toggle--active");
      navLinks.classList.toggle("nav__links--open");
    });

    // Close menu on link click
    navLinks.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navToggle.classList.remove("nav__toggle--active");
        navLinks.classList.remove("nav__links--open");
      });
    });
  }

  // -------------------------------------------------------------------
  // Scroll-reveal animation
  // -------------------------------------------------------------------
  const revealTargets = document.querySelectorAll(
    ".step, .feature, .pricing-card, .faq, .interlude__title, .interlude__text"
  );

  revealTargets.forEach((el) => el.classList.add("reveal"));

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal--visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    revealTargets.forEach((el) => observer.observe(el));
  } else {
    // Fallback: just show everything
    revealTargets.forEach((el) => el.classList.add("reveal--visible"));
  }

  // -------------------------------------------------------------------
  // Smooth scroll for anchor links (fallback for older browsers)
  // -------------------------------------------------------------------
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (e) => {
      const targetId = anchor.getAttribute("href");
      if (targetId === "#") return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  });
})();
