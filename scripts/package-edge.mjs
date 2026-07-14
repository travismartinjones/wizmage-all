import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, "..");
const CONFIG_RELATIVE_PATH = "scripts/edge-package-files.json";
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const ZIP_VERSION = 20;

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertSafeRelativePath(value, label, { singleSegment = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  if (value.includes("\\") || posix.isAbsolute(value)) {
    throw new Error(`${label} must use a relative POSIX path: ${value}`);
  }

  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    (singleSegment && segments.length !== 1)
  ) {
    throw new Error(`${label} is not a safe relative path: ${value}`);
  }
}

function assertSortedUnique(values, label) {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array.`);
  }

  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== "string") {
      throw new Error(`${label}[${index}] must be a string.`);
    }
    if (index === 0) {
      continue;
    }

    const comparison = compareOrdinal(values[index - 1], values[index]);
    if (comparison === 0) {
      throw new Error(`${label} contains a duplicate entry: ${values[index]}`);
    }
    if (comparison > 0) {
      throw new Error(`${label} must be sorted: ${values[index - 1]} precedes ${values[index]}.`);
    }
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("The Edge package configuration must be a JSON object.");
  }
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported Edge package schema version: ${config.schemaVersion}`);
  }

  assertSafeRelativePath(config.archiveName, "archiveName", { singleSegment: true });
  assertSafeRelativePath(config.unpackedDirectoryName, "unpackedDirectoryName", {
    singleSegment: true,
  });
  if (config.archiveName === config.unpackedDirectoryName) {
    throw new Error("archiveName and unpackedDirectoryName must be different.");
  }

  const fixedTimestamp = new Date(config.fixedZipTimestamp);
  if (
    Number.isNaN(fixedTimestamp.valueOf()) ||
    fixedTimestamp.getUTCFullYear() < 1980 ||
    fixedTimestamp.getUTCFullYear() > 2107 ||
    fixedTimestamp.getUTCSeconds() % 2 !== 0
  ) {
    throw new Error("fixedZipTimestamp must be an even-second UTC timestamp from 1980 through 2107.");
  }

  assertSortedUnique(config.stripManifestFields, "stripManifestFields");
  assertSortedUnique(config.packageFiles, "packageFiles");
  assertSortedUnique(config.allowedRepositoryEntries, "allowedRepositoryEntries");

  for (const field of config.stripManifestFields) {
    assertSafeRelativePath(field, "stripManifestFields entry", { singleSegment: true });
  }
  for (const file of config.packageFiles) {
    assertSafeRelativePath(file, "packageFiles entry");
  }
  for (const entry of config.allowedRepositoryEntries) {
    assertSafeRelativePath(entry, "allowedRepositoryEntries entry", { singleSegment: true });
  }

  const packageFiles = new Set(config.packageFiles);
  const allowedEntries = new Set(config.allowedRepositoryEntries);
  for (const file of config.packageFiles) {
    const rootEntry = file.split("/", 1)[0];
    if (!allowedEntries.has(rootEntry)) {
      throw new Error(`Packaged path has an undeclared repository root entry: ${file}`);
    }
  }
  if (!packageFiles.has("manifest.json")) {
    throw new Error("packageFiles must include manifest.json.");
  }

  return config;
}

export function loadPackageConfig(rootDir = DEFAULT_ROOT_DIR) {
  const configPath = join(resolve(rootDir), ...CONFIG_RELATIVE_PATH.split("/"));
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${CONFIG_RELATIVE_PATH}: ${error.message}`, { cause: error });
  }
  return validateConfig(config);
}

export function validateRepository(rootDir, config = loadPackageConfig(rootDir)) {
  const absoluteRoot = resolve(rootDir);
  const allowedEntries = new Set(config.allowedRepositoryEntries);
  const unexpectedEntries = readdirSync(absoluteRoot)
    .filter((entry) => !allowedEntries.has(entry))
    .sort(compareOrdinal);

  if (unexpectedEntries.length > 0) {
    throw new Error(
      `Unexpected repository root entries are not declared in ${CONFIG_RELATIVE_PATH}: ` +
        unexpectedEntries.join(", "),
    );
  }

  for (const file of config.packageFiles) {
    const sourcePath = join(absoluteRoot, ...file.split("/"));
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch (error) {
      throw new Error(`Required package file is missing: ${file}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Packaged paths must be regular files, not directories or symlinks: ${file}`);
    }
  }
}

function sanitizeManifest(sourceBuffer, config) {
  let manifest;
  try {
    manifest = JSON.parse(sourceBuffer.toString("utf8"));
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${error.message}`, { cause: error });
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected a Manifest V3 extension, found manifest_version=${manifest.manifest_version}.`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("manifest.json must contain a version string.");
  }

  let changed = false;
  for (const field of config.stripManifestFields) {
    if (Object.hasOwn(manifest, field)) {
      delete manifest[field];
      changed = true;
    }
  }

  return {
    buffer: changed ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") : sourceBuffer,
    manifest,
  };
}

function canonicalizePackageContents(file, sourceBuffer) {
  if (!/\.(?:css|htm|html|js|json|svg)$/i.test(file)) {
    return sourceBuffer;
  }
  const source = sourceBuffer.toString("utf8");
  return Buffer.from(source.replace(/\r\n?/g, "\n"), "utf8");
}

export function createExpectedEntries(rootDir, config = loadPackageConfig(rootDir)) {
  const absoluteRoot = resolve(rootDir);
  const entries = new Map();
  let manifest;

  for (const file of config.packageFiles) {
    const sourceBuffer = canonicalizePackageContents(
      file,
      readFileSync(join(absoluteRoot, ...file.split("/"))),
    );
    if (file === "manifest.json") {
      const sanitized = sanitizeManifest(sourceBuffer, config);
      entries.set(file, sanitized.buffer);
      manifest = sanitized.manifest;
    } else {
      entries.set(file, sourceBuffer);
    }
  }

  return { entries, manifest };
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimestamp(timestamp) {
  const date = new Date(timestamp);
  const dosDate =
    ((date.getUTCFullYear() - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  const dosTime =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  return { dosDate, dosTime };
}

export function createDeterministicZip(entries, fixedTimestamp) {
  if (!(entries instanceof Map) || entries.size > 0xffff) {
    throw new Error("ZIP entries must be a Map containing at most 65,535 files.");
  }

  const { dosDate, dosTime } = toDosTimestamp(fixedTimestamp);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, contents] of entries) {
    assertSafeRelativePath(name, "ZIP entry");
    if (!Buffer.isBuffer(contents)) {
      throw new Error(`ZIP entry contents must be a Buffer: ${name}`);
    }
    const nameBuffer = Buffer.from(name, "utf8");
    if (nameBuffer.length > 0xffff || contents.length > 0xffffffff) {
      throw new Error(`ZIP entry exceeds the ZIP32 size limit: ${name}`);
    }

    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORED_METHOD, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORED_METHOD, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, nameBuffer, contents);
    centralParts.push(centralHeader, nameBuffer);
    localOffset += localHeader.length + nameBuffer.length + contents.length;
    if (localOffset > 0xffffffff) {
      throw new Error("ZIP local records exceed the ZIP32 size limit.");
    }
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  if (centralSize > 0xffffffff || localOffset + centralSize > 0xffffffff) {
    throw new Error("ZIP central directory exceeds the ZIP32 size limit.");
  }

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.size, 8);
  endRecord.writeUInt16LE(entries.size, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

function readZipEntries(zipBuffer) {
  if (zipBuffer.length < 22) {
    throw new Error("ZIP is too small to contain an end record.");
  }

  const endOffset = zipBuffer.length - 22;
  if (zipBuffer.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error("ZIP does not end with the canonical end record.");
  }
  if (
    zipBuffer.readUInt16LE(endOffset + 4) !== 0 ||
    zipBuffer.readUInt16LE(endOffset + 6) !== 0 ||
    zipBuffer.readUInt16LE(endOffset + 20) !== 0
  ) {
    throw new Error("Multi-disk ZIP files and ZIP comments are not supported.");
  }

  const entryCount = zipBuffer.readUInt16LE(endOffset + 10);
  if (entryCount !== zipBuffer.readUInt16LE(endOffset + 8)) {
    throw new Error("ZIP entry counts do not match.");
  }
  const centralSize = zipBuffer.readUInt32LE(endOffset + 12);
  const centralOffset = zipBuffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP central directory does not end at the end record.");
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at index ${index}.`);
    }

    const flags = zipBuffer.readUInt16LE(cursor + 8);
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const checksum = zipBuffer.readUInt32LE(cursor + 16);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > endOffset) {
      throw new Error(`ZIP central directory entry is truncated at index ${index}.`);
    }
    if (flags !== UTF8_FLAG || method !== STORED_METHOD || compressedSize !== uncompressedSize) {
      throw new Error(`ZIP entry is not a canonical UTF-8 stored file at index ${index}.`);
    }

    const nameBuffer = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBuffer.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(nameBuffer)) {
      throw new Error(`ZIP entry name is not valid UTF-8 at index ${index}.`);
    }
    assertSafeRelativePath(name, "ZIP entry");
    if (entries.has(name)) {
      throw new Error(`ZIP contains a duplicate entry: ${name}`);
    }

    if (
      localHeaderOffset + 30 > centralOffset ||
      zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`ZIP local header is invalid for ${name}.`);
    }
    const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (
      zipBuffer.readUInt16LE(localHeaderOffset + 6) !== flags ||
      zipBuffer.readUInt16LE(localHeaderOffset + 8) !== method ||
      zipBuffer.readUInt32LE(localHeaderOffset + 14) !== checksum ||
      zipBuffer.readUInt32LE(localHeaderOffset + 18) !== compressedSize ||
      zipBuffer.readUInt32LE(localHeaderOffset + 22) !== uncompressedSize ||
      !zipBuffer
        .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength)
        .equals(nameBuffer) ||
      dataEnd > centralOffset
    ) {
      throw new Error(`ZIP local and central records do not match for ${name}.`);
    }

    const contents = zipBuffer.subarray(dataOffset, dataEnd);
    if (crc32(contents) !== checksum) {
      throw new Error(`ZIP CRC-32 check failed for ${name}.`);
    }
    entries.set(name, Buffer.from(contents));
    cursor = centralEnd;
  }

  if (cursor !== endOffset) {
    throw new Error("ZIP central directory contains trailing or unparsed data.");
  }
  return entries;
}

function walkDirectory(directory) {
  const files = new Map();

  function visit(currentDirectory, relativeDirectory) {
    const dirents = readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) =>
      compareOrdinal(left.name, right.name),
    );
    for (const dirent of dirents) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${dirent.name}`
        : dirent.name;
      const absolutePath = join(currentDirectory, dirent.name);
      if (dirent.isSymbolicLink()) {
        throw new Error(`Unpacked package contains a symlink: ${relativePath}`);
      }
      if (dirent.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (dirent.isFile()) {
        files.set(relativePath, readFileSync(absolutePath));
      } else {
        throw new Error(`Unpacked package contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  visit(directory, "");
  return new Map([...files].sort(([left], [right]) => compareOrdinal(left, right)));
}

function verifyEntryParity(actualEntries, expectedEntries, label) {
  const actualNames = [...actualEntries.keys()];
  const expectedNames = [...expectedEntries.keys()];
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    const missing = expectedNames.filter((name) => !actualEntries.has(name));
    const unexpected = actualNames.filter((name) => !expectedEntries.has(name));
    throw new Error(
      `${label} file list differs from the allowlist.` +
        (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
        (unexpected.length ? ` Unexpected: ${unexpected.join(", ")}.` : ""),
    );
  }

  for (const [name, expectedContents] of expectedEntries) {
    const actualContents = actualEntries.get(name);
    if (!actualContents.equals(expectedContents)) {
      throw new Error(
        `${label} contents differ for ${name} ` +
          `(expected ${sha256(expectedContents)}, found ${sha256(actualContents)}).`,
      );
    }
  }
}

function fingerprintEntries(entries) {
  const hash = createHash("sha256");
  for (const [name, contents] of entries) {
    hash.update(name, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(String(contents.length), "ascii");
    hash.update(Buffer.from([0]));
    hash.update(contents);
  }
  return hash.digest("hex");
}

function writeUnpacked(directory, entries) {
  for (const [name, contents] of entries) {
    const destination = join(directory, ...name.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, { flag: "wx" });
  }
}

function verifyBuiltArtifacts(unpackedDirectory, zipPath, expectedEntries, config) {
  const unpackedEntries = walkDirectory(unpackedDirectory);
  verifyEntryParity(unpackedEntries, expectedEntries, "Unpacked package");

  const zipBuffer = readFileSync(zipPath);
  const zipEntries = readZipEntries(zipBuffer);
  verifyEntryParity(zipEntries, expectedEntries, "ZIP package");

  const canonicalZip = createDeterministicZip(expectedEntries, config.fixedZipTimestamp);
  if (!zipBuffer.equals(canonicalZip)) {
    throw new Error("ZIP package is valid but does not use the canonical deterministic encoding.");
  }

  return zipBuffer;
}

function canonicalPathIdentity(path) {
  const absolute = resolve(path);
  const missingSegments = [];
  let existingAncestor = absolute;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = existsSync(existingAncestor)
    ? realpathSync.native(existingAncestor)
    : existingAncestor;
  const canonical = resolve(canonicalAncestor, ...missingSegments);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function assertSafeOutputDirectory(rootDir, outDir) {
  const absoluteRoot = resolve(rootDir);
  const absoluteOutput = resolve(outDir);
  const rootIdentity = canonicalPathIdentity(absoluteRoot);
  const outputIdentity = canonicalPathIdentity(absoluteOutput);
  const filesystemRootIdentity = canonicalPathIdentity(parse(absoluteOutput).root);
  if (outputIdentity === rootIdentity || outputIdentity === filesystemRootIdentity) {
    throw new Error(`Refusing to use a repository or filesystem root as the output directory: ${absoluteOutput}`);
  }

  const repositoryRelative = relative(rootIdentity, outputIdentity);
  const isInsideRepository =
    repositoryRelative !== "" &&
    repositoryRelative !== ".." &&
    !repositoryRelative.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelative);
  if (isInsideRepository && repositoryRelative.split(sep, 1)[0] !== "dist") {
    throw new Error("Output directories inside the repository must be under dist.");
  }
  return absoluteOutput;
}

function makeSummary({ config, entries, manifest, outDir, zipBuffer }) {
  return {
    archivePath: join(outDir, config.archiveName),
    archiveSha256: sha256(zipBuffer),
    entryCount: entries.size,
    manifestVersion: manifest.version,
    sourceSha256: fingerprintEntries(entries),
    unpackedPath: join(outDir, config.unpackedDirectoryName),
  };
}

function acquireBuildLock(outputDirectory) {
  const lockPath = join(outputDirectory, ".edge-package.lock");
  let created = false;
  try {
    mkdirSync(lockPath);
    created = true;
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" },
    );
    return lockPath;
  } catch (error) {
    if (created) {
      rmSync(lockPath, { recursive: true, force: true });
    }
    if (existsSync(lockPath)) {
      throw new Error(
        `Another build is active, or a stale build lock must be inspected: ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function publishArtifacts({
  archivePath,
  config,
  entries,
  stagingArchivePath,
  stagingPath,
  stagingUnpackedPath,
  unpackedPath,
}) {
  const previousArchivePath = join(stagingPath, "previous-archive");
  const previousUnpackedPath = join(stagingPath, "previous-unpacked");
  let previousArchiveMoved = false;
  let previousUnpackedMoved = false;
  let newArchivePublished = false;
  let newUnpackedPublished = false;

  try {
    if (existsSync(unpackedPath)) {
      renameSync(unpackedPath, previousUnpackedPath);
      previousUnpackedMoved = true;
    }
    if (existsSync(archivePath)) {
      renameSync(archivePath, previousArchivePath);
      previousArchiveMoved = true;
    }

    renameSync(stagingUnpackedPath, unpackedPath);
    newUnpackedPublished = true;
    renameSync(stagingArchivePath, archivePath);
    newArchivePublished = true;
    return verifyBuiltArtifacts(unpackedPath, archivePath, entries, config);
  } catch (publishError) {
    const rollbackErrors = [];
    const attempt = operation => {
      try {
        operation();
      } catch (error) {
        rollbackErrors.push(error);
      }
    };

    if (newArchivePublished) {
      attempt(() => rmSync(archivePath, { force: true }));
    }
    if (newUnpackedPublished) {
      attempt(() => rmSync(unpackedPath, { recursive: true, force: true }));
    }
    if (previousArchiveMoved) {
      attempt(() => renameSync(previousArchivePath, archivePath));
    }
    if (previousUnpackedMoved) {
      attempt(() => renameSync(previousUnpackedPath, unpackedPath));
    }

    if (rollbackErrors.length > 0) {
      const error = new AggregateError(
        [publishError, ...rollbackErrors],
        `Package publication and rollback failed. Preserved recovery files under ${stagingPath}.`,
      );
      error.preserveBuildState = true;
      throw error;
    }
    throw publishError;
  }
}

export function buildPackage({ rootDir = DEFAULT_ROOT_DIR, outDir } = {}) {
  const absoluteRoot = resolve(rootDir);
  const config = loadPackageConfig(absoluteRoot);
  validateRepository(absoluteRoot, config);
  const { entries, manifest } = createExpectedEntries(absoluteRoot, config);
  const absoluteOutput = assertSafeOutputDirectory(
    absoluteRoot,
    outDir ?? join(absoluteRoot, "dist", "edge"),
  );
  const unpackedPath = join(absoluteOutput, config.unpackedDirectoryName);
  const archivePath = join(absoluteOutput, config.archiveName);
  mkdirSync(absoluteOutput, { recursive: true });
  const lockPath = acquireBuildLock(absoluteOutput);
  let stagingPath = null;
  let preserveBuildState = false;

  try {
    stagingPath = mkdtempSync(join(absoluteOutput, ".edge-package-staging-"));
    const stagingUnpackedPath = join(stagingPath, config.unpackedDirectoryName);
    const stagingArchivePath = join(stagingPath, config.archiveName);
    mkdirSync(stagingUnpackedPath, { recursive: true });
    writeUnpacked(stagingUnpackedPath, entries);
    writeFileSync(
      stagingArchivePath,
      createDeterministicZip(entries, config.fixedZipTimestamp),
      { flag: "wx" },
    );
    verifyBuiltArtifacts(stagingUnpackedPath, stagingArchivePath, entries, config);

    const zipBuffer = publishArtifacts({
      archivePath,
      config,
      entries,
      stagingArchivePath,
      stagingPath,
      stagingUnpackedPath,
      unpackedPath,
    });
    return makeSummary({ config, entries, manifest, outDir: absoluteOutput, zipBuffer });
  } catch (error) {
    preserveBuildState = !!error.preserveBuildState;
    throw error;
  } finally {
    if (!preserveBuildState) {
      if (stagingPath) {
        rmSync(stagingPath, { recursive: true, force: true });
      }
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

export function verifyPackage({ rootDir = DEFAULT_ROOT_DIR, outDir } = {}) {
  const absoluteRoot = resolve(rootDir);
  const config = loadPackageConfig(absoluteRoot);
  validateRepository(absoluteRoot, config);
  const { entries, manifest } = createExpectedEntries(absoluteRoot, config);
  const absoluteOutput = assertSafeOutputDirectory(
    absoluteRoot,
    outDir ?? join(absoluteRoot, "dist", "edge"),
  );
  const lockPath = join(absoluteOutput, ".edge-package.lock");
  if (existsSync(lockPath)) {
    throw new Error(`Cannot verify artifacts while a build lock exists: ${lockPath}`);
  }
  const zipBuffer = verifyBuiltArtifacts(
    join(absoluteOutput, config.unpackedDirectoryName),
    join(absoluteOutput, config.archiveName),
    entries,
    config,
  );
  return makeSummary({ config, entries, manifest, outDir: absoluteOutput, zipBuffer });
}

function parseArguments(argumentsList) {
  let outDir;
  let verify = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--verify") {
      verify = true;
    } else if (argument === "--out-dir") {
      index += 1;
      if (index >= argumentsList.length || outDir !== undefined) {
        throw new Error("--out-dir requires exactly one directory argument.");
      }
      outDir = argumentsList[index];
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { help: false, outDir, verify };
}

function printSummary(summary, verb) {
  console.log(`${verb} Edge package ${summary.manifestVersion} (${summary.entryCount} files)`);
  console.log(`  Unpacked: ${summary.unpackedPath}`);
  console.log(`  ZIP:      ${summary.archivePath}`);
  console.log(`  Source:   ${summary.sourceSha256}`);
  console.log(`  SHA-256:  ${summary.archiveSha256}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
const isMainModule =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMainModule) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_.help) {
      console.log("Usage: node scripts/package-edge.mjs [--verify] [--out-dir DIRECTORY]");
    } else if (arguments_.verify) {
      printSummary(verifyPackage({ outDir: arguments_.outDir }), "Verified");
    } else {
      printSummary(buildPackage({ outDir: arguments_.outDir }), "Built");
    }
  } catch (error) {
    console.error(`Edge package failed: ${error.message}`);
    process.exitCode = 1;
  }
}
