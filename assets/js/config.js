/* ==========================================================================
   Thornhill Corporation — Site configuration
   This is the only file you normally need to edit.
   ========================================================================== */
window.THORNHILL_CONFIG = {
  // Company details shown around the site
  companyName: "Thornhill Corporation",
  supportEmail: "support@thornhill.example",   // <- change to your real support email

  /* ------------------------------------------------------------------------
     BACKEND (Supabase — free)
     Leave these blank to run in DEMO MODE (enquiries are saved only in the
     browser that submitted them — fine for testing, NOT for real customers).
     Fill them in after following README.md → "Connect the backend" so that
     enquiries from every visitor reach every admin.
     ------------------------------------------------------------------------ */
  supabaseUrl: "",       // e.g. "https://abcdxyz.supabase.co"
  supabaseAnonKey: "",   // the "anon public" key from Supabase → Project Settings → API

  // DEMO MODE ONLY — admin logins used when Supabase isn't connected yet.
  // Once Supabase is connected these are ignored and admins are managed in the database.
  demoAdmins: [
    { fullName: "Demo Admin", code: "THORN-2026" }
  ]
};
