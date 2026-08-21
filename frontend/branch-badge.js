/**
 * branch-badge.js — Fetches current branch from backend and shows
 * a small floating badge in the bottom-left corner of the page.
 *
 * Include in any HTML page:
 *   <script src="./branch-badge.js"></script>
 */
(function () {
  const BACKEND = window.PERSONAFLOW_BACKEND || "http://127.0.0.1:5001";

  function createBadge(branch) {
    const el = document.createElement("div");
    el.id = "branch-badge";
    el.textContent = "\uD83D\uDD00 " + branch;           // 🔀
    Object.assign(el.style, {
      position: "fixed",
      bottom: "12px",
      left: "12px",
      padding: "5px 14px",
      background: "linear-gradient(135deg,#1f6feb,#388bfd)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      fontWeight: "700",
      borderRadius: "20px",
      zIndex: "99999",
      pointerEvents: "none",
      boxShadow: "0 2px 8px #0004",
      letterSpacing: "0.4px",
      opacity: "0.92",
    });
    document.body.appendChild(el);
  }

  function init() {
    fetch(BACKEND + "/api/branch")
      .then(function (r) { return r.json(); })
      .then(function (d) { createBadge(d.branch || "unknown"); })
      .catch(function () { createBadge("offline"); });
  }

  // Wait for body to exist
  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
