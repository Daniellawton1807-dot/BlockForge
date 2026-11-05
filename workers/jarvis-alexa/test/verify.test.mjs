// Run with: node --test test/  (a throwaway certificate chain stands in for Amazon's)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createSign, X509Certificate } from "node:crypto";
import { test } from "node:test";
import { Rejected, certUrlOk, checkChain, verifyRequest } from "../src/verify.js";
import { intentName, OPENERS } from "../src/phrases.js";

test("only Amazon's certificate address is accepted", () => {
  for (const good of ["https://s3.amazonaws.com/echo.api/echo-api-cert.pem", "https://s3.amazonaws.com:443/echo.api/x.pem", "https://s3.amazonaws.com/echo.api/../echo.api/x.pem"]) assert.ok(certUrlOk(good), good);
  for (const bad of ["http://s3.amazonaws.com/echo.api/x.pem", "https://notamazon.com/echo.api/x.pem", "https://s3.amazonaws.com/EcHo.aPi/x.pem", "https://s3.amazonaws.com/invalid.path/x.pem",
    "https://s3.amazonaws.com:563/echo.api/x.pem", "https://s3.amazonaws.com/echo.api/../attacker/x.pem", "", "nonsense"]) assert.ok(!certUrlOk(bad), bad);
});

test("a certificate that doesn't lead to a trusted root is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "alexa-"));
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Fake Root", "-days", "2");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=echo-api.amazon.com");
  writeFileSync(join(dir, "ext"), "subjectAltName=DNS:echo-api.amazon.com\n");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "ext");
  const pem = readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "ca.pem"), "utf8");
  assert.throws(() => checkChain(pem, Date.now()), Rejected);  // right name, valid signatures, but Fake Root isn't pinned
  assert.throws(() => checkChain(readFileSync(join(dir, "ca.pem"), "utf8"), Date.now()), Rejected);  // wrong name
  const body = JSON.stringify({ request: { timestamp: new Date().toISOString() }, context: { System: { application: { applicationId: "skill" } } } });
  const signature = createSign("RSA-SHA256").update(body).sign(readFileSync(join(dir, "leaf.key")), "base64");
  return assert.rejects(verifyRequest({ certUrl: "https://s3.amazonaws.com/echo.api/forged.pem", signature, rawBody: body, skillId: "skill", fetcher: async () => new Response(pem) }), Rejected);
});

test("Amazon's own chain passes its checks, apart from dates when it's an expired copy", () => {
  const real = process.env.REAL_CHAIN && readFileSync(process.env.REAL_CHAIN, "utf8");
  if (!real) return;
  const leaf = new X509Certificate(real.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
  assert.ok(checkChain(real, new Date(leaf.validFrom).getTime() + 1000));
  assert.throws(() => checkChain(real, new Date(leaf.validTo).getTime() + 1000), /out of date/);
  assert.throws(() => checkChain(real.replace("A", "B"), new Date(leaf.validFrom).getTime() + 1000));
});

test("no skill ID set means nothing gets in", () => assert.rejects(verifyRequest({ certUrl: "https://s3.amazonaws.com/echo.api/x", signature: "x", rawBody: "{}", skillId: "" }), /no skill ID/));

test("intent names are valid and unique", () => {
  const names = Object.keys(OPENERS).map(intentName);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[A-Za-z_]+$/);
});
