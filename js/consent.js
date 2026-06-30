/**
 * Cookie consent banner with Google Consent Mode v2 defaults.
 * Stores choice in localStorage; updates gtag consent before ads personalize.
 */
(function () {
  const STORAGE_KEY = "cookie-consent";

  function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
  }

  function setConsent(granted) {
    gtag("consent", "update", {
      ad_storage: granted ? "granted" : "denied",
      ad_user_data: granted ? "granted" : "denied",
      ad_personalization: granted ? "granted" : "denied",
      analytics_storage: granted ? "granted" : "denied",
    });
  }

  function hideBanner(banner) {
    banner.classList.add("hidden");
    banner.setAttribute("aria-hidden", "true");
  }

  function saveChoice(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (_) {
      /* private browsing */
    }
  }

  function readChoice() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function init() {
    const banner = document.getElementById("consent-banner");
    if (!banner) return;

    const acceptBtn = document.getElementById("consent-accept");
    const rejectBtn = document.getElementById("consent-reject");

    const saved = readChoice();
    if (saved === "accepted") {
      setConsent(true);
      hideBanner(banner);
      return;
    }
    if (saved === "rejected") {
      setConsent(false);
      hideBanner(banner);
      return;
    }

    banner.classList.remove("hidden");
    banner.setAttribute("aria-hidden", "false");

    acceptBtn?.addEventListener("click", () => {
      saveChoice("accepted");
      setConsent(true);
      hideBanner(banner);
    });

    rejectBtn?.addEventListener("click", () => {
      saveChoice("rejected");
      setConsent(false);
      hideBanner(banner);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
