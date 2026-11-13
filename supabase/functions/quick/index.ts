// =============================================================================
//  Thornhill Corporation — "quick" Edge Function (Thornhill Quick sign-in)
//
//  Checks passkeys (fingerprint / face / device PIN) for staff sign-in.
//    begin_register / finish_register — add a device (staff must already be signed in)
//    begin_login    / finish_login    — sign in with a device → 12-hour session token
//
//  Deploy with "Verify JWT" turned OFF. No secrets needed.
//  Optional secret QUICK_RP_ID if your domain isn't thornhillcorporation.co.uk.
// =============================================================================

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
// Passkeys belong to this domain and work on it and all its sub-sites (www., link-hub., …)
const RP_ID = (Deno.env.get("QUICK_RP_ID") ?? "thornhillcorporation.co.uk").toLowerCase();
const RP_NAME = "Thornhill Corporation";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function rpc(fn: string, args: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SERVICE_KEY };
  if (SERVICE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Database error (${fn}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- bytes --
export function b64urlToBytes(s: string): Uint8Array {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
export function bytesToB64url(b: Uint8Array) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** WebAuthn ECDSA signatures are DER-encoded; WebCrypto wants raw r||s (64 bytes for P-256) */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("bad signature");
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const read = () => {
    if (der[i++] !== 0x02) throw new Error("bad signature");
    const len = der[i++];
    let v = der.slice(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length);
    return out;
  };
  const r = read(), s = read();
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32);
  return raw;
}

/** Is this page allowed to use Thornhill Quick? (the domain or any sub-site of it, over https) */
export function originAllowed(origin: string, rpId = RP_ID) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const secure = u.protocol === "https:" || host === "localhost";
    return secure && (host === rpId || host.endsWith("." + rpId));
  } catch { return false; }
}

/** Check clientDataJSON + authenticatorData common to registration and sign-in */
export async function checkClientAndAuth(clientDataB64: string, authDataB64: string, type: string, challenge: string, rpId = RP_ID) {
  const clientBytes = b64urlToBytes(clientDataB64);
  const client = JSON.parse(new TextDecoder().decode(clientBytes));
  if (client.type !== type) throw new Error("Wrong request type.");
  if (client.challenge !== challenge) throw new Error("This sign-in request has expired. Please try again.");
  if (!originAllowed(client.origin, rpId)) throw new Error("This website isn't allowed to use Thornhill Quick.");
  const auth = b64urlToBytes(authDataB64);
  if (auth.length < 37) throw new Error("Invalid device response.");
  if (!eq(auth.slice(0, 32), await sha256(new TextEncoder().encode(rpId)))) throw new Error("This passkey belongs to a different website.");
  const flags = auth[32];
  if (!(flags & 0x01)) throw new Error("The device didn't confirm you were present.");
  if (!(flags & 0x04)) throw new Error("Your device must check your fingerprint, face or PIN.");
  const signCount = new DataView(auth.buffer, auth.byteOffset + 33, 4).getUint32(0);
  return { clientBytes, auth, signCount };
}

async function importKey(spkiB64: string, alg: number) {
  const der = b64ToBytes(spkiB64);
  if (alg === -7) return crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  throw new Error("Unsupported passkey type.");
}

export async function verifyAssertion(publicKeyB64: string, alg: number, auth: Uint8Array, clientBytes: Uint8Array, sigB64url: string) {
  const key = await importKey(publicKeyB64, alg);
  const data = new Uint8Array(auth.length + 32);
  data.set(auth, 0); data.set(await sha256(clientBytes), auth.length);
  const sig = b64urlToBytes(sigB64url);
  return alg === -7
    ? crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), data)
    : crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
}

// -------------------------------------------------------------- actions --
async function beginRegister(b: any) {
  const ch = await rpc("_quick_new_challenge", { p_purpose: "register", p_name: b.name, p_code: b.code });
  if (ch?.auth === false) return json({ ok: false, auth: false }, 401);
  return json({
    ok: true, challenge_id: ch.id,
    options: {
      challenge: ch.challenge,
      rp: { id: RP_ID, name: RP_NAME },
      user: { id: bytesToB64url(new TextEncoder().encode(ch.admin.id)), name: ch.admin.full_name, displayName: ch.admin.full_name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: (ch.exclude ?? []).map((id: string) => ({ type: "public-key", id })),
      attestation: "none", timeout: 120000,
    },
  });
}

async function finishRegister(b: any) {
  const taken = await rpc("_quick_take_challenge", { p_id: b.challenge_id, p_purpose: "register" });
  if (!taken) return json({ ok: false, error: "This set-up request expired. Please try again." });
  // The person must still be signed in as the same admin
  const ch = await rpc("_quick_new_challenge", { p_purpose: "register", p_name: b.name, p_code: b.code });
  if (ch?.auth === false || ch?.admin?.id !== taken.admin_id) return json({ ok: false, auth: false }, 401);

  const c = b.credential ?? {};
  if (!c.id || !c.clientDataJSON || !c.authenticatorData || !c.publicKey) return json({ ok: false, error: "Your browser didn't return a usable passkey. Try Chrome, Edge, Safari or Firefox." });
  if (![-7, -257].includes(Number(c.publicKeyAlgorithm))) return json({ ok: false, error: "This device's passkey type isn't supported." });
  let checked;
  try { checked = await checkClientAndAuth(c.clientDataJSON, c.authenticatorData, "webauthn.create", taken.challenge); }
  catch (e) { return json({ ok: false, error: (e as Error).message }); }
  let spki: string;
  try { spki = bytesToB64(b64urlToBytes(c.publicKey)); await importKey(spki, Number(c.publicKeyAlgorithm)); }
  catch { return json({ ok: false, error: "This device's passkey couldn't be read." }); }

  await rpc("_quick_save_credential", {
    p_admin: taken.admin_id, p_credential_id: c.id, p_public_key: spki, p_alg: Number(c.publicKeyAlgorithm),
    p_sign_count: checked.signCount, p_label: String(b.label ?? "My device").slice(0, 80),
    p_transports: Array.isArray(c.transports) ? c.transports.map(String).slice(0, 6) : [],
  });
  return json({ ok: true });
}

async function beginLogin() {
  const ch = await rpc("_quick_new_challenge", { p_purpose: "login", p_name: null, p_code: null });
  return json({ ok: true, challenge_id: ch.id, options: { challenge: ch.challenge, rpId: RP_ID, userVerification: "required", timeout: 120000 } });
}

async function finishLogin(b: any) {
  const fail = (msg: string) => json({ ok: false, error: msg });
  const taken = await rpc("_quick_take_challenge", { p_id: b.challenge_id, p_purpose: "login" });
  if (!taken) return fail("This sign-in request expired. Please try again.");
  const c = b.credential ?? {};
  const cred = c.id ? await rpc("_quick_get_credential", { p_credential_id: c.id }) : null;
  if (!cred) return fail("This passkey isn't registered for Thornhill Quick. Sign in with your name and code, then set it up again.");
  let checked;
  try { checked = await checkClientAndAuth(c.clientDataJSON, c.authenticatorData, "webauthn.get", taken.challenge); }
  catch (e) { return fail((e as Error).message); }
  let ok = false;
  try { ok = await verifyAssertion(cred.public_key, cred.alg, checked.auth, checked.clientBytes, c.signature); } catch { ok = false; }
  if (!ok) return fail("Thornhill Quick couldn't verify this device.");
  // Cloned-device protection (only when the device counts uses)
  if (checked.signCount > 0 && cred.sign_count > 0 && checked.signCount <= cred.sign_count) return fail("This passkey looks like a copy. Remove it and set Thornhill Quick up again.");
  const s = await rpc("_quick_start_session", { p_credential: cred.id, p_sign_count: checked.signCount });
  return json({ ok: true, name: s.name, token: s.token, device: cred.label });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case "begin_register": return await beginRegister(b);
      case "finish_register": return await finishRegister(b);
      case "begin_login": return await beginLogin();
      case "finish_login": return await finishLogin(b);
      default: return json({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Something went wrong on the server. Please try again." }, 500);
  }
}

if (typeof Deno !== "undefined" && (Deno as any).serve) Deno.serve(handler);
