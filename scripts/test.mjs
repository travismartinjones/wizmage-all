import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROOT_DIR,
  buildPackage,
  createExpectedEntries,
  loadPackageConfig,
  validateRepository,
  verifyPackage,
} from "./package-edge.mjs";
import { runBrowserRegression } from "./browser-regression.mjs";
import { runRuntimeVmTests } from "./runtime-vm-tests.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const RESOURCE_EXTENSION = /\.(?:css|gif|htm|html|jpeg|jpg|js|png|svg|webp)(?:[?#].*)?$/i;
const FORBIDDEN_PACKAGE_ENTRIES = new Set([
  ".git",
  ".gitattributes",
  ".github",
  ".gitignore",
  "README.md",
  "dist",
  "node_modules",
  "package-lock.json",
  "package.json",
  "scripts",
  "tests",
  "Wizmage AI",
]);

assert.equal(ROOT_DIR, DEFAULT_ROOT_DIR, "Tool scripts disagree about the repository root.");

function parseArguments(argumentsList) {
  if (argumentsList.length === 0) {
    return { checkOnly: false };
  }
  if (argumentsList.length === 1 && argumentsList[0] === "--check-only") {
    return { checkOnly: true };
  }
  throw new Error(`Unknown test argument: ${argumentsList.join(" ")}`);
}

function checkJavaScriptSyntax(config) {
  const toolingFiles = [
    "scripts/browser-regression.mjs",
    "scripts/package-edge.mjs",
    "scripts/runtime-regression-page.js",
    "scripts/runtime-vm-tests.mjs",
    "scripts/test.mjs",
  ];
  const files = [
    ...config.packageFiles.filter(file => file.endsWith(".js")),
    ...toolingFiles,
  ];

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", join(ROOT_DIR, ...file.split("/"))], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`JavaScript syntax check failed for ${file}${details ? `:\n${details}` : "."}`);
    }
  }
  return files.length;
}

function normalizeLocalReference(reference, origin) {
  const value = reference.trim();
  if (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    value.includes("${") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return null;
  }

  const withoutFragment = value.split(/[?#]/, 1)[0];
  const resolved = withoutFragment.startsWith("/")
    ? withoutFragment.slice(1)
    : posix.normalize(posix.join(posix.dirname(origin), withoutFragment));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`${origin} references a path outside the extension root: ${reference}`);
  }
  return RESOURCE_EXTENSION.test(resolved) ? resolved : null;
}

function assertReferenceIsPackaged(reference, origin, packageFiles) {
  const normalized = normalizeLocalReference(reference, origin);
  if (normalized && !packageFiles.has(normalized)) {
    throw new Error(`${origin} references a file outside the package allowlist: ${normalized}`);
  }
}

function visitManifestStrings(value, callback) {
  if (typeof value === "string") {
    callback(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      visitManifestStrings(item, callback);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      visitManifestStrings(item, callback);
    }
  }
}

function checkResourceReferences(config, expectedEntries, manifest) {
  const packageFiles = new Set(config.packageFiles);
  visitManifestStrings(manifest, (reference) =>
    assertReferenceIsPackaged(reference, "manifest.json", packageFiles),
  );

  for (const [file, contents] of expectedEntries) {
    let source = contents.toString("utf8");
    if (/\.(?:css|htm|html)$/i.test(file)) {
      source = source.replace(/<!--[^]*?-->/g, "").replace(/\/\*[^]*?\*\//g, "");

      if (/\.html?$/i.test(file)) {
        const attributePattern = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
        for (const match of source.matchAll(attributePattern)) {
          assertReferenceIsPackaged(match[2], file, packageFiles);
        }
      }

      const cssUrlPattern = /\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi;
      for (const match of source.matchAll(cssUrlPattern)) {
        assertReferenceIsPackaged(match[2], file, packageFiles);
      }
    } else if (/\.js$/i.test(file)) {
      const stringLiteralPattern = /(["'])([^"'\r\n]*?)\1/g;
      for (const match of source.matchAll(stringLiteralPattern)) {
        const value = match[2];
        if (!/\s/.test(value) && /(?:^|\/)[^/.][^/]*\.(?:css|gif|htm|html|jpeg|jpg|js|png|svg|webp)(?:[?#].*)?$/i.test(value)) {
          assertReferenceIsPackaged(value, file, packageFiles);
        }
      }
    }
  }
}

function checkPackagePolicy(config) {
  for (const file of config.packageFiles) {
    const rootEntry = file.split("/", 1)[0];
    if (FORBIDDEN_PACKAGE_ENTRIES.has(rootEntry)) {
      throw new Error(`Tooling or repository metadata is in the package allowlist: ${file}`);
    }
  }
  assert(!config.packageFiles.includes(".gitignore"), ".gitignore must never be packaged.");
}

function checkCanonicalTextEntries(expectedEntries) {
  for (const [file, contents] of expectedEntries) {
    if (/\.(?:css|htm|html|js|json|svg)$/i.test(file)) {
      assert(!contents.includes(13), `Canonical package text still contains a CR byte: ${file}`);
    }
  }
}

function checkOutputRootSafety() {
  const rootAlias = process.platform === "win32" ? ROOT_DIR.toLowerCase() : ROOT_DIR;
  assert.throws(
    () => buildPackage({ rootDir: ROOT_DIR, outDir: rootAlias }),
    /Refusing to use a repository or filesystem root/,
    "The packager accepted the repository root as its output directory.",
  );

  if (process.platform !== "win32") {
    return;
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "wizmage-output-alias-"));
  const junctionPath = join(temporaryRoot, "repository-junction");
  try {
    symlinkSync(ROOT_DIR, junctionPath, "junction");
    assert.throws(
      () => buildPackage({ rootDir: ROOT_DIR, outDir: junctionPath }),
      /Refusing to use a repository or filesystem root/,
      "The packager accepted a junction alias of the repository root.",
    );
  } finally {
    if (process.platform === "win32") {
      try { unlinkSync(junctionPath); } catch { /* junction may not have been created */ }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parsePbxObjects(source) {
  const objects = new Map();
  const singleLinePattern = /^\t\t([A-F0-9]{24}) \/\* (.*?) \*\/ = \{([^\r\n]*?)\};\r?$/gm;
  for (const match of source.matchAll(singleLinePattern)) {
    objects.set(match[1], { id: match[1], comment: match[2], body: match[3] });
  }
  const objectPattern = /^\t\t([A-F0-9]{24}) \/\* (.*?) \*\/ = \{\r?\n([^]*?)^\t\t\};/gm;
  for (const match of source.matchAll(objectPattern)) {
    objects.set(match[1], { id: match[1], comment: match[2], body: match[3] });
  }
  return objects;
}

function listObjectIds(body, listName) {
  const escapedName = listName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`\\b${escapedName} = \\(([^]*?)\\);`));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/\b([A-F0-9]{24}) \/\* (.*?) \*\//g)].map(item => ({
    id: item[1],
    comment: item[2],
  }));
}

function localHtmlScripts(expectedEntries) {
  const scripts = new Set();
  for (const [file, contents] of expectedEntries) {
    if (!/\.html?$/i.test(file)) {
      continue;
    }
    const source = contents.toString("utf8").replace(/<!--[^]*?-->/g, "");
    const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
    for (const match of source.matchAll(scriptPattern)) {
      const normalized = normalizeLocalReference(match[2], file);
      if (normalized && normalized.endsWith(".js")) {
        scripts.add(normalized);
      }
    }
  }
  return scripts;
}

function checkSafariExtensionResources(manifest, expectedEntries) {
  const requiredScripts = localHtmlScripts(expectedEntries);
  if (manifest.background && manifest.background.service_worker) {
    requiredScripts.add(manifest.background.service_worker);
  }
  for (const declaration of manifest.content_scripts || []) {
    for (const file of declaration.js || []) {
      requiredScripts.add(file);
    }
  }

  const contentDeclaration = (manifest.content_scripts || []).find(declaration =>
    Array.isArray(declaration.js) && declaration.js.includes("js.js"),
  );
  assert(contentDeclaration, "manifest.json has no content script declaration for js.js.");
  assert.deepEqual(
    contentDeclaration.js.slice(0, 4),
    ["media-startup.js", "shared.js", "content-controller.js", "js.js"],
    "The media gate must load before the shared/controller/content runtime.",
  );

  const projectPath = join(ROOT_DIR, "Wizmage AI", "Wizmage AI.xcodeproj", "project.pbxproj");
  const projectSource = readFileSync(projectPath, "utf8");
  const objects = parsePbxObjects(projectSource);
  const resourceGroup = [...objects.values()].find(object =>
    object.comment === "Resources" && /\bpath = "Shared \(Extension\)";/.test(object.body),
  );
  assert(resourceGroup, "The Xcode Shared (Extension) Resources group was not found.");
  const groupChildren = listObjectIds(resourceGroup.body, "children");

  const targetNames = ["Wizmage AI Extension (iOS)", "Wizmage AI Extension (macOS)"];
  const phaseResources = new Map();
  for (const targetName of targetNames) {
    const target = [...objects.values()].find(object => object.comment === targetName);
    assert(target, `Xcode target was not found: ${targetName}`);
    const resourcePhaseReference = listObjectIds(target.body, "buildPhases").find(
      reference => reference.comment === "Resources",
    );
    assert(resourcePhaseReference, `Xcode target has no Resources build phase: ${targetName}`);
    const phase = objects.get(resourcePhaseReference.id);
    assert(phase && /\bisa = PBXResourcesBuildPhase;/.test(phase.body), `Invalid Resources phase for ${targetName}`);
    phaseResources.set(targetName, listObjectIds(phase.body, "files"));
  }

  for (const file of [...requiredScripts].sort()) {
    const groupMatches = groupChildren.filter(reference => reference.comment === file);
    assert.equal(groupMatches.length, 1, `Xcode Shared (Extension) group must contain ${file} exactly once.`);
    const fileReference = objects.get(groupMatches[0].id);
    assert(fileReference && /\bisa = PBXFileReference;/.test(fileReference.body), `Invalid Xcode file reference for ${file}`);
    const expectedPath = `../../${file}`;
    const pathMatch = fileReference.body.match(/\bpath = (?:"([^"]+)"|([^;]+));/);
    const referencedPath = pathMatch ? (pathMatch[1] || pathMatch[2]).trim() : "";
    assert.equal(referencedPath, expectedPath, `Xcode ${file} reference does not point to the repository source.`);

    for (const [targetName, resources] of phaseResources) {
      const matches = resources.filter(resource => {
        const buildFile = objects.get(resource.id);
        if (!buildFile) {
          return false;
        }
        const fileRefMatch = buildFile.body.match(/\bfileRef = ([A-F0-9]{24}) \/\*/);
        return !!fileRefMatch && fileRefMatch[1] === fileReference.id;
      });
      assert.equal(matches.length, 1, `${targetName} must package ${file} exactly once.`);
    }
  }
}

function runStaticChecks() {
  const config = loadPackageConfig(ROOT_DIR);
  validateRepository(ROOT_DIR, config);
  checkPackagePolicy(config);
  const { entries, manifest } = createExpectedEntries(ROOT_DIR, config);
  checkCanonicalTextEntries(entries);
  checkResourceReferences(config, entries, manifest);
  checkSafariExtensionResources(manifest, entries);
  checkOutputRootSafety();
  const syntaxFileCount = checkJavaScriptSyntax(config);

  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  assert.equal(packageJson.private, true, "The tooling package must remain private.");
  assert.equal(manifest.manifest_version, 3, "Only Manifest V3 release packages are supported.");

  return { config, entryCount: entries.size, manifest, syntaxFileCount };
}

function checkReproducibleBuild(config) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "wizmage-edge-package-"));
  try {
    const firstOutput = join(temporaryRoot, "first");
    const secondOutput = join(temporaryRoot, "second");
    const lockedOutput = join(temporaryRoot, "locked");
    const lockPath = join(lockedOutput, ".edge-package.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), '{"pid":0,"fixture":true}\n');
    assert.throws(
      () => buildPackage({ rootDir: ROOT_DIR, outDir: lockedOutput }),
      /Another build is active, or a stale build lock must be inspected/,
      "A second build ignored an existing output lock.",
    );
    assert(existsSync(lockPath), "A rejected concurrent build removed the existing build lock.");
    assert.throws(
      () => verifyPackage({ rootDir: ROOT_DIR, outDir: lockedOutput }),
      /Cannot verify artifacts while a build lock exists/,
      "Verification ignored an active package build lock.",
    );

    const first = buildPackage({ rootDir: ROOT_DIR, outDir: firstOutput });
    const second = buildPackage({ rootDir: ROOT_DIR, outDir: secondOutput });
    writeFileSync(join(first.unpackedPath, "stale-file.txt"), "stale\n");
    writeFileSync(first.archivePath, Buffer.from("stale trailing bytes"), { flag: "a" });
    const rebuiltFirst = buildPackage({ rootDir: ROOT_DIR, outDir: firstOutput });
    const firstVerified = verifyPackage({ rootDir: ROOT_DIR, outDir: firstOutput });
    const secondVerified = verifyPackage({ rootDir: ROOT_DIR, outDir: secondOutput });

    assert.equal(rebuiltFirst.archiveSha256, second.archiveSha256, "Repeated builds produced different ZIP hashes.");
    assert.equal(rebuiltFirst.sourceSha256, second.sourceSha256, "Repeated builds used different source inputs.");
    assert.equal(firstVerified.archiveSha256, rebuiltFirst.archiveSha256);
    assert.equal(secondVerified.archiveSha256, second.archiveSha256);
    assert(
      readFileSync(rebuiltFirst.archivePath).equals(readFileSync(second.archivePath)),
      "Repeated builds are not byte-for-byte identical.",
    );
    assert(!existsSync(join(first.unpackedPath, "stale-file.txt")), "A stale unpacked file survived a rebuild.");
    assert.deepEqual(
      readdirSync(firstOutput).sort(),
      [config.unpackedDirectoryName, config.archiveName].sort(),
      "A completed build retained its lock, staging directory, or backup artifacts.",
    );

    return rebuiltFirst;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const { checkOnly } = parseArguments(process.argv.slice(2));
  const checks = runStaticChecks();
  console.log(
    `Checked ${checks.syntaxFileCount} JavaScript files and ${checks.entryCount} package resources ` +
      `for Manifest V${checks.manifest.manifest_version}.`,
  );

  if (!checkOnly) {
    const runtimeVm = await runRuntimeVmTests();
    console.log(
      `Runtime VM regression passed (${runtimeVm.sharedAssertions} shared-helper and ` +
        `${runtimeVm.workerAssertions} worker assertions).`,
    );
    const build = checkReproducibleBuild(checks.config);
    console.log(
      `Reproducible Edge package verified (${basename(build.archivePath)}, SHA-256 ${build.archiveSha256}).`,
    );
    const browser = await runBrowserRegression();
    if (browser.skipped) {
      console.log(`Browser DOM regression skipped: ${browser.reason}`);
    } else {
      console.log(`Browser DOM regression passed with ${browser.browserVersion}.`);
      if (browser.mv3Smoke && browser.mv3Smoke.skipped) {
        console.log(`Browser MV3 smoke skipped: ${browser.mv3Smoke.reason}`);
      } else if (browser.mv3Smoke) {
        console.log(`Browser MV3 smoke passed: ${browser.mv3Smoke.details}`);
      }
    }
  }
} catch (error) {
  console.error(`Test failed: ${error.message}`);
  process.exitCode = 1;
}
