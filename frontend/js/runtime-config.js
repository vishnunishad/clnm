// ── CLN Runtime Configuration ──────────────────────────────────────
// This file sets the API base URL depending on the environment.
// UPDATE the production URL below to your actual Render backend URL.
// ──────────────────────────────────────────────────────────────────

window.__CLN_API_BASE__ = window.__CLN_API_BASE__ || (() => {
  const { protocol, hostname } = window.location;

  // Local development
  if (protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:5000';
  }

  // ✅ REPLACE THIS WITH YOUR ACTUAL RENDER BACKEND URL
  return 'https://clnm-backend.onrender.com';
})();
