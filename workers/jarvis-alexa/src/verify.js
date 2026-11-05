// Proves a request really came from Amazon, as Amazon requires of any skill's own endpoint:
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html
import { X509Certificate, createPublicKey, createVerify, createHash } from "node:crypto";

const TOLERANCE_MS = 150 * 1000;
const SIGNER = "echo-api.amazon.com";
const CACHE_MS = 6 * 60 * 60 * 1000;
// Amazon Root CA 1 and Starfield Services Root G2, by public key: the chain must reach one of these
const ROOTS = new Set(["++MBgDH5WGvL9Bcn5Be30cRcL0f5O+NyoXuWtQdX1aI=", "KwccWaCgrnaw6tsrrSO61FgLacNgG2MMLq8GE6+oP5I="]);
const certs = new Map();

export class Rejected extends Error {}

export function certUrlOk(value) {
  let url;
  try { url = new URL(value); } catch { return false; }  // new URL also resolves dot segments, so /echo.api/../x can't pass
  return url.protocol === "https:" && url.hostname === "s3.amazonaws.com" && url.pathname.startsWith("/echo.api/") && (url.port === "" || url.port === "443");
}

const spki = cert => createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");

export function checkChain(pem, now) {
  const chain = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(p => new X509Certificate(p));
  if (!chain.length) throw new Rejected("no certificate");
  const leaf = chain[0];
  if (!(leaf.subjectAltName || "").split(/,\s*/).includes("DNS:" + SIGNER)) throw new Rejected("wrong certificate name");
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (now < new Date(cert.validFrom).getTime() || now > new Date(cert.validTo).getTime()) throw new Rejected("certificate out of date");
    if (ROOTS.has(spki(cert))) return leaf;
    if (!chain[i + 1] || !cert.verify(chain[i + 1].publicKey)) throw new Rejected("certificate chain broken");
  }
  throw new Rejected("certificate chain doesn't reach a trusted root");
}

async function signingCert(url, now, fetcher) {
  const held = certs.get(url);
  if (held && held.until > now) return held.leaf;
  const response = await fetcher(url);
  if (!response.ok) throw new Rejected("couldn't fetch certificate");
  const leaf = checkChain(await response.text(), now);
  certs.set(url, { leaf, until: Math.min(now + CACHE_MS, new Date(leaf.validTo).getTime()) });
  return leaf;
}

// Returns the parsed request, or throws Rejected. A skill ID must be set, or nothing is accepted.
export async function verifyRequest({ certUrl, signature, rawBody, skillId, now = Date.now(), fetcher = fetch }) {
  if (!skillId) throw new Rejected("no skill ID set");
  if (!certUrl || !signature || !certUrlOk(certUrl)) throw new Rejected("bad signature headers");
  const leaf = await signingCert(certUrl, now, fetcher);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(rawBody);
  if (!verifier.verify(createPublicKey(leaf.publicKey.export({ type: "spki", format: "pem" })), signature, "base64")) throw new Rejected("bad signature");
  const body = JSON.parse(rawBody);
  const at = Date.parse(body?.request?.timestamp || "");
  if (!at || Math.abs(now - at) > TOLERANCE_MS) throw new Rejected("too old");
  const app = body?.context?.System?.application?.applicationId || body?.session?.application?.applicationId;
  if (app !== skillId) throw new Rejected("wrong skill");
  return body;
}
