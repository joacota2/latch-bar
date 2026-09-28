import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { createManifest, verifyUpdateSignature } from "./updater-manifest.mjs";

function fixture(algorithm = "ED") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const key = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
  const pubkey = Buffer.from(`untrusted comment: test key\n${key.toString("base64")}\n`).toString("base64");
  const bytes = Buffer.from("test universal application archive");
  const signature = sign(null, algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes, privateKey);
  const comment = "timestamp:1234567890";
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const encoded = Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from(algorithm), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${globalSignature.toString("base64")}\n`).toString("base64");
  return { config: { version: "0.3.0", plugins: { updater: { pubkey } } }, release: { tagName: "v0.3.0", isDraft: true, isPrerelease: false, body: "Release notes" }, repository: "joacota2/latch-bar", bytes, signature: encoded };
}

test("both architectures use the same verified universal archive and release notes", () => {
  const input = fixture();
  const result = createManifest(input);
  assert.equal(result.version, "0.3.0");
  assert.equal(result.notes, "Release notes");
  assert.deepEqual(result.platforms["darwin-aarch64"], result.platforms["darwin-x86_64"]);
  assert.match(result.platforms["darwin-aarch64"].url, /\/v0.3.0\/Latch-Bar.app.tar.gz$/);
});

test("rejects changed archives, wrong keys, missing or corrupt signatures", () => {
  const input = fixture();
  for (const patch of [{ bytes: Buffer.from("tampered") }, { signature: "" }, { signature: "invalid" }, { config: fixture().config }]) {
    assert.throws(() => createManifest({ ...input, ...patch }));
  }
  const decoded = Buffer.from(input.signature, "base64").toString().replace("timestamp:1234567890", "timestamp:0000000000");
  assert.throws(() => createManifest({ ...input, signature: Buffer.from(decoded).toString("base64") }));
});

test("rejects mismatched, prerelease, already published releases and empty packages", () => {
  const input = fixture();
  for (const patch of [{ tagName: "v0.4.0" }, { isDraft: false }, { isPrerelease: true }]) {
    assert.throws(() => createManifest({ ...input, release: { ...input.release, ...patch } }));
  }
  assert.throws(() => createManifest({ ...input, bytes: Buffer.alloc(0) }));
  assert.throws(() => createManifest({ ...input, config: { ...input.config, version: "0.3.0-beta.1" } }));
});

test("supports the legacy signature encoding used by Tauri signers", () => {
  const input = fixture("Ed");
  verifyUpdateSignature(input.bytes, input.signature, input.config.plugins.updater.pubkey);
});
