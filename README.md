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

**Optional — show Google files as real PDFs:** deploy the `google-pdf` Edge Function (code in `supabase/functions/google-pdf/index.ts`) in Supabase → Edge Functions, named exactly `google-pdf`, with JWT verification turned off. Without it, Google files open in Google's own preview instead.

**One-time setup:** in Supabase → SQL Editor → New query, paste the whole of `supabase/documents.sql` and click **Run**. (Run it after `setup.sql`. Safe to run again.)

---

## Thornhill Quick (fast staff sign-in)

Staff can sign in with their **fingerprint, face or device PIN** (a passkey) instead of typing their special code.

- Sign in once with your name and code, then click **Set up on this device** (or **Thornhill Quick** in the top bar).
- Next time, click **Sign in with Thornhill Quick** under the normal sign-in form.
- Only devices registered by a signed-in staff member are accepted. Fingerprints and faces never leave the device.
- Quick sign-ins last 12 hours. **Thornhill Quick → Sign out of all Thornhill Quick sessions** ends them everywhere; remove lost devices there too.
- Passkeys work on `thornhillcorporation.co.uk` and its sub-sites (e.g. `link-hub.`).

### Thornhill ID (sign in to a PC or Mac with your phone)

Most computers don't have a fingerprint reader, so computers can be approved from your phone instead:

1. On the computer: **Sign in with Thornhill Quick → Use my phone**. A code and QR code appear.
2. On your phone: scan the QR code (or open `thornhillcorporation.co.uk/id`), unlock your **Thornhill ID** with your fingerprint or face, check the code and tap **Approve**.
3. The computer signs in straight away.

Your phone needs Thornhill Quick set up first. Tip: add `/id` to your phone's home screen — it works like an app.
Setup: run `supabase/quick-id.sql` in Supabase → SQL Editor (after `quick.sql`). No function changes are needed.

Setup:
1. Supabase → SQL Editor → run `supabase/quick.sql`.
2. Supabase → Edge Functions → Deploy a new function → Via Editor → name it `quick` → paste `supabase/functions/quick/index.ts` → Deploy → turn **Verify JWT off**. No secrets are needed.

---

## Emailing Centre

Send and receive email from Thornhill addresses right inside the admin panel (**Emailing Centre** tab).

- **Addresses:** shared ones like `support@thornhillcorporation.co.uk` (every admin can use them) and personal ones like `johndoe@…` (only that admin can send from or read them).
- **Inbox, Sent, Starred, Archive**, search, and conversations grouped like Gmail. Replies from customers land in the same conversation.
- **Reply to enquiries** from the enquiry itself: the email is saved with the enquiry, and you can mark it In progress or Resolved as you send. A customer's reply re-opens a resolved enquiry.
- **Templates** with placeholders (`{{first_name}}`, `{{reference}}`…), **signatures**, **attachments** (up to 7 MB), **preview**, **Cc/Bcc**, **5-second undo send**, and **delivery tracking** (Delivered / Opened / Bounced).
- **Automatic reply** to new Support enquiries with their reference number (optional, in Settings & setup).

It uses **Resend** (free for up to 100 emails a day). One-time setup:

1. **Database:** in Supabase → SQL Editor, run `supabase/email-part1.sql`, then `email-part2.sql`, then `email-part3.sql` (each in a new query).
2. **Resend:** sign up at resend.com → Domains → add `thornhillcorporation.co.uk` → add the DNS records it shows at your domain provider → Verify. Turn on **Receiving** for the domain and add its MX record too (this sends all email for the domain to the Emailing Centre).
3. **API key:** Resend → API Keys → Create (Full access). In Supabase → Edge Functions → Secrets, add `RESEND_API_KEY`.
4. **Function:** Supabase → Edge Functions → Deploy a new function → Via Editor → name it `email` → paste `supabase/functions/email/index.ts` → Deploy → turn **Verify JWT off**.
5. **Webhook (for receiving and delivery tracking):** Resend → Webhooks → Add → URL `https://YOUR-PROJECT.supabase.co/functions/v1/email` → select email.received, email.delivered, email.delivery_delayed, email.bounced, email.complained, email.opened → copy the signing secret into a Supabase secret named `RESEND_WEBHOOK_SECRET`.
6. **Admin panel:** Emailing Centre → create `support@`, then open **Settings & setup** and check everything is green.

---

## How replying works

In the admin panel, open an enquiry and click **Reply via email** (opens your email app) or **Reply in Gmail**. The reply is pre-filled with the customer's address, a subject containing their reference number, and their original message quoted. Replying automatically moves a *New* enquiry to *In progress*.

---

Copyright © 2026 Thornhill Corporation. All Rights Reserved. Thornhill owns the right to this material.
