import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_ASSET = "Latch-Bar.app.tar.gz";

// Tauri wraps Minisign's public key and detached signature text in base64.
// Verify both the payload signature and the trusted comment before publishing.
export function verifyUpdateSignature(bytes, encodedSignature, encodedKey) {
  const keyLines = Buffer.from(encodedKey.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const lines = Buffer.from(encodedSignature.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith("trusted comment: ")) throw new Error("Invalid updater signature or public key format");
  const key = Buffer.from(keyLines[1], "base64");
  const signature = Buffer.from(lines[1], "base64");
  const globalSignature = Buffer.from(lines[3], "base64");
  if (key.length !== 42 || signature.length !== 74 || globalSignature.length !== 64 || !["Ed", "ED"].includes(key.subarray(0, 2).toString())) throw new Error("Invalid Minisign key or signature");
  if (!key.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error("Updater signing key does not match configured public key");
  const algorithm = signature.subarray(0, 2).toString();
  if (!["Ed", "ED"].includes(algorithm)) throw new Error("Unsupported updater signature algorithm");
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
  const payload = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const trustedComment = Buffer.from(lines[2].slice("trusted comment: ".length));
  if (!verify(null, payload, publicKey, signature.subarray(10)) || !verify(null, Buffer.concat([signature.subarray(10), trustedComment]), publicKey, globalSignature)) throw new Error("Updater signature verification failed");
}

export function createManifest({ config, release, repository, bytes, signature, date = new Date().toISOString() }) {
  const version = config.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Only stable SemVer releases can be published to the updater");
  if (release.tagName !== `v${version}` || release.isDraft !== true || release.isPrerelease !== false) throw new Error("Updater requires a matching stable draft release");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  if (!bytes.length) throw new Error("Updater package is empty");
  if (!Number.isFinite(Date.parse(date))) throw new Error("Invalid publication date");
  verifyUpdateSignature(bytes, signature, config.plugins.updater.pubkey);
  const platform = { signature: signature.trim(), url: `https://github.com/${repository}/releases/download/${release.tagName}/${UPDATE_ASSET}` };
  return { version, notes: release.body || "", pub_date: date, platforms: { "darwin-aarch64": platform, "darwin-x86_64": { ...platform } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, releasePath, packagePath, signaturePath, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error("Usage: updater-manifest.mjs CONFIG RELEASE_JSON PACKAGE SIGNATURE OUTPUT");
  const [config, release, bytes, signature] = await Promise.all([
    readFile(configPath, "utf8").then(JSON.parse), readFile(releasePath, "utf8").then(JSON.parse),
    readFile(packagePath), readFile(signaturePath, "utf8"),
  ]);
  const manifest = createManifest({ config, release, bytes, signature, repository: process.env.GITHUB_REPOSITORY });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Verified update package and generated manifest for ${manifest.version}.`);
}
