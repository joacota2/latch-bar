import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function packageVersionFromToml(contents, packageName) {
  const blocks = contents.split(/^\[\[package\]\]\s*$/m);
  const block = blocks.find((candidate) =>
    new RegExp(`^name\\s*=\\s*"${packageName}"\\s*$`, "m").test(candidate),
  );
  return block?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

function rootPackageVersionFromToml(contents) {
  const packageSection = contents.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  return packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

const [
  packageJson,
  packageLock,
  tauriConfig,
  releasePleaseConfig,
  cargoToml,
  cargoLock,
] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson("src-tauri/tauri.conf.json"),
    readJson("release-please-config.json"),
    readFile(new URL("src-tauri/Cargo.toml", root), "utf8"),
    readFile(new URL("src-tauri/Cargo.lock", root), "utf8"),
  ]);

// GenericToml tags scalar values so it can replace them in place without
// reformatting the file. Filters must therefore inspect the tag's value field.
const cargoLockExtraFile = releasePleaseConfig.packages?.["."]?.["extra-files"]?.find(
  ({ path }) => path === "src-tauri/Cargo.lock",
);
const cargoLockJsonPath = "$.package[?(@.name.value == 'latch-bar')].version";
if (cargoLockExtraFile?.jsonpath !== cargoLockJsonPath) {
  throw new Error(
    `Release Please must update latch-bar in Cargo.lock with ${cargoLockJsonPath}`,
  );
}

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", rootPackageVersionFromToml(cargoToml)],
  ["src-tauri/Cargo.lock", packageVersionFromToml(cargoLock, "latch-bar")],
]);

const missing = [...versions].filter(([, version]) => !version);
if (missing.length > 0) {
  throw new Error(`Could not read a version from: ${missing.map(([name]) => name).join(", ")}`);
}

const distinct = new Set(versions.values());
if (distinct.size !== 1) {
  const details = [...versions]
    .map(([name, version]) => `  ${name}: ${version}`)
    .join("\n");
  throw new Error(`Release versions are not synchronized:\n${details}`);
}

const [version] = distinct;
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(`Release tag ${releaseTag} does not match application version v${version}`);
}

console.log(`All release metadata uses version ${version}.`);
