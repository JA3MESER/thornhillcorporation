// =============================================================================
//  Thornhill Corporation — "email" Edge Function (Emailing Centre)
//
//  • action "send"   — an admin sends an email from a Thornhill mailbox
//  • action "ack"    — automatic "we've received your enquiry" email
//  • action "status" — setup checklist for the admin panel
//  • Resend webhooks — incoming email (email.received) and delivery updates
//
//  Secrets to add in Supabase → Edge Functions → Secrets:
//    RESEND_API_KEY         (Resend → API Keys, "Full access")
//    RESEND_WEBHOOK_SECRET  (Resend → Webhooks → your webhook → Signing secret)
//  Deploy with "Verify JWT" turned OFF. No other code changes are needed.
// =============================================================================

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
const RESEND = "https://api.resend.com";

const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024; // total, before base64

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- database --
async function rpc(fn: string, args: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SERVICE_KEY };
  if (SERVICE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Database error (${fn}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------ formatting --
export function esc(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Simple formatting: **bold**, *italic*, [text](https://link), bare links, "- " lists, "> " quotes, paragraphs. */
export function formatBody(src: string): string {
  const inline = (t: string) => {
    let h = esc(t);
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, a, u) => `<a href="${u}" style="color:#2563eb">${a}</a>`);
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_m, p, u) => `${p}<a href="${u}" style="color:#2563eb">${u}</a>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    return h;
  };
  const blocks = String(src ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*>/.test(l))) {
      const inner = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
      return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 14px;border-left:3px solid #d0d7e2;color:#5b6475">${formatBody(inner)}</blockquote>`;
    }
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<ul style="margin:0 0 16px;padding-left:22px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p style="margin:0 0 16px">${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

export function plainText(src: string) {
  return String(src ?? "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}

/** The branded Thornhill email layout */
export function brandedHtml(opts: { body: string; signature?: string | null; siteUrl: string; reference?: string | null; preheader?: string }) {
  const site = opts.siteUrl.replace(/\/+$/, "");
  const sig = opts.signature ? `<div style="margin-top:8px;padding-top:16px;border-top:1px solid #e6eaf0;color:#4a5263;font-size:14px">${formatBody(opts.signature)}</div>` : "";
  const ref = opts.reference ? `<p style="margin:0 0 6px;color:#7a8396;font-size:12px">Reference: <strong>${esc(opts.reference)}</strong> — please keep this in the subject line when you reply.</p>` : "";
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Thornhill Corporation</title></head>
<body style="margin:0;padding:0;background:#f1f4f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0b0d">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader ?? "")}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="background:#07090e;border-radius:16px 16px 0 0;padding:22px 28px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:12px"><img src="${esc(site)}/assets/img/icon-dark-96.png" width="40" height="40" alt="" style="display:block;border-radius:10px"></td>
    <td style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.01em">Thornhill<br><span style="color:#7a8396;font-size:10px;font-weight:600;letter-spacing:0.18em">CORPORATION</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#2563eb;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td style="background:#ffffff;padding:32px 28px 24px;font-size:15px;line-height:1.65;color:#1f2430">${formatBody(opts.body)}${sig}</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:0 28px 26px">${ref}</td></tr>
<tr><td style="padding:18px 28px;text-align:center;color:#7a8396;font-size:12px;line-height:1.6">
  <a href="${esc(site)}" style="color:#2563eb;text-decoration:none;font-weight:600">${esc(site.replace(/^https?:\/\//, ""))}</a><br>
  Copyright © 2026 Thornhill Corporation. All Rights Reserved. Thornhill owns the right to this material.
</td></tr>
</table></td></tr></table></body></html>`;
}

export function fillPlaceholders(text: string, vars: Record<string, string>) {
  return String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m));
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
function cleanList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[,;\n]/);
  return [...new Set(arr.map((x) => String(x).trim().replace(/^.*<([^>]+)>$/, "$1").toLowerCase()).filter(Boolean))];
}

// --------------------------------------------------------------- Resend --
async function resend(path: string, init: RequestInit = {}) {
  const res = await fetch(RESEND + path, {
    ...init,
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  return { ok: res.ok, status: res.status, body };
}

async function sendViaResend(p: {
  from: string; to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string; subject: string;
  html: string; text: string; headers?: Record<string, string>; attachments?: { filename: string; content: string }[];
}) {
  const payload: Record<string, unknown> = {
    from: p.from, to: p.to, subject: p.subject, html: p.html, text: p.text,
  };
  if (p.cc?.length) payload.cc = p.cc;
  if (p.bcc?.length) payload.bcc = p.bcc;
  if (p.replyTo) payload.reply_to = p.replyTo;
  if (p.headers && Object.keys(p.headers).length) payload.headers = p.headers;
  if (p.attachments?.length) payload.attachments = p.attachments;
  return await resend("/emails", { method: "POST", body: JSON.stringify(payload) });
}

const fromHeader = (name: string, address: string) => `${String(name).replace(/["<>]/g, "")} <${address}>`;

// ------------------------------------------------------------ actions --
async function actionSend(b: any) {
  if (!RESEND_KEY) return json({ ok: false, error: "Email sending isn't set up yet: add the RESEND_API_KEY secret in Supabase." });
  const ctx = await rpc("_email_send_context", { p_name: b.name, p_code: b.code, p_mailbox: b.mailbox_id, p_reply_to: b.reply_to_id ?? null });
  if (ctx?.auth === false) return json({ ok: false, auth: false }, 401);
  if (!ctx?.ok) return json({ ok: false, error: ctx?.error ?? "Couldn't send." });

  const mb = ctx.mailbox, settings = ctx.settings, reply = ctx.reply;
  const to = cleanList(b.to), cc = cleanList(b.cc), bcc = cleanList(b.bcc);
  const bad = [...to, ...cc, ...bcc].filter((a) => !EMAIL_RE.test(a));
  if (!to.length) return json({ ok: false, error: "Add at least one recipient." });
  if (bad.length) return json({ ok: false, error: `These addresses don't look right: ${bad.join(", ")}` });
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return json({ ok: false, error: `You can send to at most ${MAX_RECIPIENTS} people at once.` });
  const subject = String(b.subject ?? "").trim().slice(0, 250);
  if (!subject) return json({ ok: false, error: "Add a subject." });
  const body = String(b.body ?? "").slice(0, 100000);
  if (!body.trim()) return json({ ok: false, error: "Write a message before sending." });

  const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map((a: any) => ({
    filename: String(a.filename ?? "file").slice(0, 150), content: String(a.content ?? ""), size: Number(a.size) || 0,
  }));
  if (attachments.reduce((n: number, a: any) => n + a.size, 0) > MAX_ATTACHMENT_BYTES)
    return json({ ok: false, error: "Attachments can be up to 7 MB in total." });

  const signature = b.include_signature === false ? null : mb.signature;
  const reference = (subject.match(/TH-[A-Z0-9]{6}/i) ?? [])[0]?.toUpperCase() ?? null;
  const html = brandedHtml({ body, signature, siteUrl: settings.site_url, reference, preheader: body.slice(0, 120) });
  const text = plainText(body) + (signature ? `\n\n--\n${plainText(signature)}` : "");

  const headers: Record<string, string> = {};
  if (reply?.message_id) {
    headers["In-Reply-To"] = reply.message_id;
    headers["References"] = [reply.in_reply_to, reply.message_id].filter(Boolean).join(" ");
  }

  const sent = await sendViaResend({
    from: fromHeader(mb.display_name, mb.address), to, cc, bcc, replyTo: mb.address, subject, html, text, headers,
    attachments: attachments.map((a: any) => ({ filename: a.filename, content: a.content })),
  });
  if (!sent.ok) {
    const msg = sent.body?.message ?? `Resend error ${sent.status}`;
    return json({ ok: false, error: /domain/i.test(msg) ? `${msg} (Check that ${settings.domain} is verified in Resend.)` : msg });
  }

  const row = await rpc("_email_record_outbound", {
    p: {
      mailbox_id: mb.id, from_address: mb.address, from_name: mb.display_name, to, cc, bcc, subject,
      body_text: text, body_html: html, resend_id: sent.body?.id, thread_id: b.thread_id ?? reply?.thread_id ?? null,
      enquiry_id: b.enquiry_id ?? reply?.enquiry_id ?? null, in_reply_to: reply?.message_id ?? null,
      attachments: attachments.map((a: any) => ({ filename: a.filename, size: a.size })),
      sent_by: ctx.admin, set_enquiry_status: b.set_enquiry_status ?? null,
    },
  });
  return json({ ok: true, email: row });
}

async function actionAck(b: any) {
  if (!RESEND_KEY) return json({ ok: false });
  const ctx = await rpc("_email_ack_context", { p_reference: String(b.reference ?? "") });
  if (!ctx) return json({ ok: false });
  const { enquiry: q, settings, mailbox: mb, template: t } = ctx;
  const vars: Record<string, string> = {
    first_name: String(q.full_name).trim().split(/\s+/)[0], name: q.full_name, reference: q.reference,
    enquiry_subject: q.subject, subject: q.subject, admin_name: "The Thornhill Corporation team",
    admin_first_name: "Thornhill", mailbox: mb.address, email: q.email,
  };
  let subject = fillPlaceholders(t.subject || "We've received your enquiry [{{reference}}]", vars);
  if (!/TH-[A-Z0-9]{6}/i.test(subject)) subject += ` [${q.reference}]`;
  const body = fillPlaceholders(t.body, vars);
  const html = brandedHtml({ body, signature: mb.signature, siteUrl: settings.site_url, reference: q.reference, preheader: body.slice(0, 120) });
  const text = plainText(body) + (mb.signature ? `\n\n--\n${plainText(mb.signature)}` : "");
  const sent = await sendViaResend({ from: fromHeader(mb.display_name, mb.address), to: [q.email], replyTo: mb.address, subject, html, text });
  await rpc("_email_record_outbound", {
    p: {
      mailbox_id: mb.id, from_address: mb.address, from_name: mb.display_name, to: [q.email], subject,
      body_text: text, body_html: html, resend_id: sent.body?.id ?? null, enquiry_id: q.id, sent_by: "Automatic reply",
      kind: "ack", status: sent.ok ? "sent" : "failed", error: sent.ok ? null : (sent.body?.message ?? "Send failed"),
    },
  });
  return json({ ok: sent.ok });
}

async function actionStatus(b: any) {
  const who = await rpc("admin_login", { p_name: b.name, p_code: b.code });
  if (!who) return json({ ok: false, auth: false }, 401);
  const out: Record<string, unknown> = { ok: true, function: true, resend_key: !!RESEND_KEY, webhook_secret: !!WEBHOOK_SECRET };
  if (RESEND_KEY) {
    const d = await resend("/domains");
    if (d.status === 401 || d.status === 403) out.key_problem = "Your Resend API key can't read domains. Create a key with \"Full access\".";
    else if (d.ok) out.domains = (d.body?.data ?? []).map((x: any) => ({ name: x.name, status: x.status, region: x.region }));
    else out.key_problem = d.body?.message ?? `Resend error ${d.status}`;
  }
  return json(out);
}

// -------------------------------------------------------------- webhooks --
function b64ToBytes(b64: string) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: ArrayBuffer) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Verify a Resend (Svix) webhook signature */
export async function verifyWebhook(secret: string, id: string, timestamp: string, signature: string, body: string, now = Date.now()) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = await crypto.subtle.importKey("raw", b64ToBytes(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToB64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return signature.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export function parseAddress(v: string) {
  const s = String(v ?? "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: "", address: s.toLowerCase() };
}

export function htmlToText(html: string) {
  return String(html ?? "")
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}

async function handleWebhook(req: Request) {
  const raw = await req.text();
  const ok = await verifyWebhook(WEBHOOK_SECRET, req.headers.get("svix-id") ?? "", req.headers.get("svix-timestamp") ?? "",
    req.headers.get("svix-signature") ?? "", raw);
  if (!ok) return json({ error: "Invalid signature" }, 401);
  const event = JSON.parse(raw);
  const data = event.data ?? {};

  if (event.type === "email.received") {
    const full = await resend(`/emails/receiving/${encodeURIComponent(data.email_id)}`);
    const m = full.ok ? full.body : data;
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers ?? {})) h[k.toLowerCase()] = String(v);
    const from = parseAddress(h["from"] ?? m.from ?? data.from);
    const refs = `${h["in-reply-to"] ?? ""} ${h["references"] ?? ""}`.match(/<[^>]+>/g) ?? [];
    const html = m.html ?? null;
    await rpc("_email_record_inbound", {
      p: {
        resend_id: data.email_id, from_address: from.address || String(m.from ?? "").toLowerCase(), from_name: from.name,
        to: (m.to ?? data.to ?? []).map((a: string) => parseAddress(a).address),
        cc: (m.cc ?? data.cc ?? []).map((a: string) => parseAddress(a).address),
        received_for: (m.received_for ?? data.received_for ?? []).map((a: string) => parseAddress(a).address),
        subject: m.subject ?? data.subject ?? "(no subject)",
        body_text: m.text ?? (html ? htmlToText(html) : ""), body_html: html,
        message_id: m.message_id ?? data.message_id ?? null, references: [...new Set(refs)].reverse(),
        attachments: (m.attachments ?? data.attachments ?? []).map((a: any) => ({ filename: a.filename, size: a.size ?? null, content_type: a.content_type })),
      },
    });
    return json({ ok: true });
  }

  const map: Record<string, string> = {
    "email.delivered": "delivered", "email.delivery_delayed": "delivery_delayed", "email.bounced": "bounced",
    "email.complained": "complained", "email.failed": "failed", "email.opened": "opened",
  };
  if (map[event.type] && data.email_id) await rpc("_email_record_event", { p_resend_id: data.email_id, p_event: map[event.type] });
  return json({ ok: true });
}

// ---------------------------------------------------------------- router --
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    if (req.headers.get("svix-id")) return await handleWebhook(req);
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case "send": return await actionSend(b);
      case "ack": return await actionAck(b);
      case "status": return await actionStatus(b);
      default: return json({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Something went wrong on the server. Please try again." }, 500);
  }
}

if (typeof Deno !== "undefined" && (Deno as any).serve) Deno.serve(handler);
