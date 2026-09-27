// ── Admin hitelesítés ─────────────────────────────────────
// Admin = belépett, isAdmin jelzésű fiók (e-mail + jelszó, session cookie). A régi, jelszót
// headerben/URL-ben küldő mód megszűnt. Az admin fiókot az ADMIN_EMAIL + ADMIN_PASSWORD
// környezeti változókból hozzuk létre induláskor (lásd server.js: „Admin fiók bootstrap”).
function requireAdmin(req, res) {
  if (req.user?.isAdmin) return true;
  res.status(403).json({ error: "Hozzáférés megtagadva — admin fiókkal kell belépni." });
  return false;
}

// Admin MINDEN tippet lát (jóváhagyásra várókat is)
function isAdminReq(req) {
  return !!req.user?.isAdmin;
}

module.exports = { requireAdmin, isAdminReq };
