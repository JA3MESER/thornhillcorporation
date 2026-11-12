# Thornhill Corporation — Website

A sleek, modern website for Thornhill Corporation with:

- **Customer side** — Home, About, Services, Values, Gallery and a **Support** page with an enquiry form
- **Administrator side** (`/admin-panel`) — log in with **full name + special code**, read every enquiry, reply by email, track status (New → In progress → Resolved), add internal notes, delete, search, filter and export to CSV
- **Light & dark mode** toggle (remembers each visitor's choice)
- White, black & blue theme, fully mobile-responsive

It's a static site, so it's free to host on **GitHub Pages**. Enquiries are stored in **Supabase** (free tier), so every customer's enquiry reaches every admin.

---

## 1. Put the site on GitHub Pages

1. Sign in at [github.com](https://github.com) and click **New repository**.
   Name it e.g. `thornhill-website`, set it to **Public**, and create it.
2. Click **uploading an existing file**, then drag in **everything inside this folder**
   (`index.html`, `support.html`, `admin.html`, `404.html`, the `assets` folder, the `supabase` folder and this README). Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. After a minute your site is live at `https://YOUR-USERNAME.github.io/thornhill-website/`.

> At this point the site runs in **demo mode**: the support form works, but enquiries are only saved in the browser that sent them. Do step 2 so real customers' enquiries reach your admin panel.

---

## 2. Connect the backend (so enquiries reach admins)

1. Create a free account at [supabase.com](https://supabase.com) and click **New project**.
2. In the project, open **SQL Editor → New query**, paste the whole of `supabase/setup.sql`, and click **Run**.
3. Add yourself (and any other admins). In a new SQL query run, changing the name and code:
   ```sql
   insert into public.admins (full_name, code_hash)
   values ('Your Full Name', extensions.crypt('PICK-A-LONG-SECRET-CODE', extensions.gen_salt('bf')));
   ```
   Repeat for each admin. Names aren't case-sensitive; codes are.
4. Open **Project Settings → API** and copy the **Project URL** and the **Publishable key** (or the legacy **anon public** key — either works).
5. In GitHub, open `assets/js/config.js`, click the ✏️ pencil, and fill in:
   ```js
   supabaseUrl: "https://xxxx.supabase.co",
   supabaseAnonKey: "eyJhbGciOi...",
   ```
   Commit. The demo login stops working and only the admins you added in step 3 can sign in.

The anon key is designed to be public. With the included SQL, it can **only** submit enquiries — reading, editing and deleting all require a valid admin name + code, which is checked on the server. Codes are stored hashed, and a name is locked for 15 minutes after 5 wrong codes.

---

## 3. Logos and images

All brand images live in `assets/img/`:

| File | Used for |
|---|---|
| `icon-light-96.png` / `icon-dark-96.png` | Navigation and footer logo (switches automatically with light/dark mode) |
| `icon-dark-96.png`, `apple-touch-icon.png` | Browser tab icon and phone home-screen icon |
| `tc-logo-swoosh.png` | Homepage hero and gallery |
| `tc-logo.png` | About section and gallery |
| `banner.png` | "Our Corporation" banner in the gallery |
| `icon-dark.png` / `icon-light.png` | Gallery |

To swap an image, upload a new file with the same name. To add photos to the gallery, copy one of the `<figure class="brand-tile ...">` lines in `index.html` and point it at your new image.

---

## 4. Other things to change

- **Support email**: `supportEmail` in `assets/js/config.js`
- **Company text**: all wording is in `index.html` — search for the section (About, Services, Values) and edit
- **Enquiry types**: the `<option>` list in `support.html`
- **Colours**: the variables at the top of `assets/css/styles.css`

## Document hub

In the admin panel, open the **Documents** tab and click **New document**. Paste a Google Docs, Sheets, Slides, Forms or Drive link, or upload a PDF (up to 5 MB). Give it a name and description, choose its Thornhill link (e.g. `thornhillcorporation.co.uk/d/staff-handbook`), and click **Create link**.

- Anyone with the link sees the document on a Thornhill-branded page, with buttons to copy the link and open or download the original.
- Tick **List on the public Documents page** to show it at `/documents` as well.
- Google files must be shared as **"Anyone with the link can view"** in Google, or visitors will see a Google sign-in box instead.

**One-time setup:** in Supabase → SQL Editor → New query, paste the whole of `supabase/documents.sql` and click **Run**. (Run it after `setup.sql`. Safe to run again.)

---

## How replying works

In the admin panel, open an enquiry and click **Reply via email** (opens your email app) or **Reply in Gmail**. The reply is pre-filled with the customer's address, a subject containing their reference number, and their original message quoted. Replying automatically moves a *New* enquiry to *In progress*.

---

Copyright © 2026 Thornhill Corporation. All Rights Reserved. Thornhill owns the right to this material.
