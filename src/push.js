// Web push for Flookes HQ (RFC 8291 payload encryption + RFC 8292 VAPID).
// The VAPID key pair is created by the Worker the first time it's needed and kept in
// the database, so there is no push secret to paste into Cloudflare.

const te = new TextEncoder();

function b64Decode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? b64 + '='.repeat(4 - (b64.length % 4)) : b64;
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
function b64Encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── VAPID keys (stored in settings as a JWK) ─────────────────
let cachedKeys = null;
export async function vapidKeys(env) {
  if (cachedKeys) return cachedKeys;
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid_jwk'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_jwk', ?)").bind(JSON.stringify(jwk)).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid_jwk'").first();
  }
  const jwk = JSON.parse(row.value);
  const publicKey = b64Encode(concat(new Uint8Array([4]), b64Decode(jwk.x), b64Decode(jwk.y)));
  cachedKeys = { jwk, publicKey };
  return cachedKeys;
}

async function vapidJwt(env, endpoint) {
  const { jwk } = await vapidKeys(env);
  const hdr = b64Encode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay = b64Encode(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: 'mailto:hello@flookesitup.com',
  })));
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${hdr}.${pay}`));
  return `${hdr}.${pay}.${b64Encode(sig)}`;
}

async function encryptPayload(subscription, payload) {
  const plaintext = te.encode(payload);
  const authSecret = b64Decode(subscription.keys.auth);
  const uaPublic = b64Decode(subscription.keys.p256dh);

  const asKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKP.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKP.privateKey, 256));

  const keyInfo = concat(te.encode('WebPush: info\x00'), uaPublic, asPublicRaw);
  const ecdhMat = await crypto.subtle.importKey('raw', ecdhSecret, 'HKDF', false, ['deriveBits']);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, ecdhMat, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('Content-Encoding: aes128gcm\x00') }, ikmKey, 128));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('Content-Encoding: nonce\x00') }, ikmKey, 96));

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, concat(plaintext, new Uint8Array([0x02]))));

  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPublicRaw, 21);
  return concat(header, ciphertext);
}

// Send to every device a family member has turned notifications on for.
export async function pushTo(env, memberId, title, body, tag = 'flookes-hq') {
  const { publicKey } = await vapidKeys(env);
  const subs = (await env.DB.prepare('SELECT id, subscription FROM push_subscriptions WHERE family_member_id = ?')
    .bind(memberId).all()).results;
  const payload = JSON.stringify({
    title: String(title || 'Flookes HQ').slice(0, 120),
    body: String(body || '').slice(0, 300),
    tag: String(tag || 'flookes-hq').slice(0, 80),
  });
  await Promise.all(subs.map(async (row) => {
    try {
      const sub = JSON.parse(row.subscription);
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${await vapidJwt(env, sub.endpoint)},k=${publicKey}`,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: '86400',
        },
        body: await encryptPayload(sub, payload),
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run();
      }
    } catch (e) {
      console.log('push failed', e && e.message);
    }
  }));
}

// Push services the browser may hand us. Anything else is refused so the Worker
// can't be used to make requests to arbitrary addresses.
export function isPushEndpoint(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(hostname);
  } catch { return false; }
}
