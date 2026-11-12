// =============================================================================
//  Thornhill Corporation — google-pdf (Supabase Edge Function)
//
//  Turns a Google Docs / Sheets / Slides / Drive-PDF document from the
//  document hub into a real PDF, so Thornhill links open in the browser's
//  normal PDF viewer. It's fetched fresh each time, so edits in Google show up.
//
//  Called as:  <SUPABASE_URL>/functions/v1/google-pdf?code=<document code>
//  It only works for documents saved in your document hub, so it can't be used
//  to fetch anything else. Deploy with "Verify JWT" turned OFF.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function reply(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Work out Google's "download as PDF" address for a document link
function exportUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "docs.google.com") {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{10,})/);
    if (!m) return null; // published (/d/e/...) links and Forms can't be exported
    const [, type, id] = m;
    if (type === "presentation") return `https://docs.google.com/presentation/d/${id}/export/pdf`;
    return `https://docs.google.com/${type}/d/${id}/export?format=pdf`;
  }
  if (host === "drive.google.com") {
    const id = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/)?.[1] ?? u.searchParams.get("id");
    if (id && /^[a-zA-Z0-9_-]{10,}$/.test(id)) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return reply(405, "Method not allowed");

  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(code)) return reply(400, "Missing or invalid document code");

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: doc, error } = await supabase
    .from("documents").select("kind, url, title").eq("slug", code).maybeSingle();
  if (error) return reply(500, "Database error");
  if (!doc || doc.kind !== "google" || !doc.url) return reply(404, "Document not found");

  const target = exportUrl(doc.url);
  if (!target) return reply(422, "This kind of Google file can't be turned into a PDF");

  let res: Response;
  try {
    res = await fetch(target, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Thornhill document hub)" } });
  } catch {
    return reply(502, "Couldn't reach Google");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("pdf")) {
    return reply(502, "Google didn't return a PDF. Check the file is shared as 'Anyone with the link can view'.");
  }

  const safeName = String(doc.title).replace(/[^\w .()-]+/g, "").trim().slice(0, 100) || "document";
  return new Response(res.body, {
    headers: {
      ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}.pdf"`,
      "Cache-Control": "public, max-age=60",
    },
  });
});
