// lib/schema-snapshot.mjs — §5.5/§6.1 schema snapshot + skill identity MECHANICS (task 52).
//
// The real module behind the task-58 seam (lib/interview.mjs SCHEMA_SNAPSHOT_MODULE_OPS).
// Two ops, exactly what the seam pins:
//
//   captureSchemaSnapshot({ skillRoot }) → { schema_sha256, skill_identity,
//                                            host_contract_version, schema_format_version }
//   computeSkillIdentity({ skillRoot })  → <64-hex sha256>
//
// The skill is the /design-intent skill (pinned by policy/design-intent-skill.json): its
// schema.json is the schema authority, and its manifest.json declares the CLOSED file set
// the identity digests. The identity algorithm is byte-identical to the reference
// recomputation in test/design-intent-host-contract.test.mjs and to the manifest's own
// identity.canonicalization:
//
//   entries sorted in ascending byte order of the manifest-relative POSIX path; for each
//   entry in that order, update the running sha256 with the UTF-8 bytes of the path, a
//   newline, the 64-character lowercase hex sha256 of the file's exact bytes, and a newline;
//   the identity is the final digest in lowercase hex. The fixed-length per-entry hex digest
//   makes the framing unambiguous without escaping file content.
//
// Every guard failure is NAMED with the §5.5 list (lib/interview.mjs SKILL_GUARD_FAILURES)
// and thrown as `<name>: <detail>` — the surface propagates these verbatim:
//
//   skill_absent               — the skill root, its manifest, or SKILL.md is missing
//   host_contract_unsupported  — the manifest's host_contract_version is not one this host supports
//   schema_unsupported         — the schema format version is unsupported, malformed, or
//                                mismatched against the manifest's declaration
//   undeclared_dependency      — the closed set is not closed or not complete: an undeclared
//                                asset, a missing/absolute/escaping/duplicate entry, or a
//                                non-regular file in the set
//   skill_identity_changed     — the LATER-OPERATION guard (lib/interview.mjs assertSkillIdentity):
//                                the installed skill recomputes to a different identity than
//                                the run recorded; this module only computes, the surface compares
//
// There is NO fallback to native questioning and NO fallback to a live schema: a failing check
// throws, never silently degrades. A schema upgrade is an explicit amendment
// (mp interview amend-skill-identity), never a silent migration.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- supported versions (the host's declared contract, §5.5/§6.1) ---------------
//
// The manifest declares what the skill speaks; these are what THIS host understands. A
// skill declaring anything else fails closed (host_contract_unsupported /
// schema_unsupported) — no silent downgrade, no partial support. Module-internal: the
// module's public surface is EXACTLY the two seam ops (SCHEMA_SNAPSHOT_MODULE_OPS); the
// supported set is proven by behavior (the pinned skill's version 1 passes; anything
// else refuses by name).
const SUPPORTED_HOST_CONTRACT_VERSIONS = [1];
const SUPPORTED_SCHEMA_FORMAT_VERSIONS = [1];

// The files the host contract necessarily reads from every skill: the instructions
// (SKILL.md), the schema authority (schema.json), and the closed-set declaration itself
// (manifest.json). A closed set that omits one of these cannot close the set — the skill
// loads a file the digest never covers.
const REQUIRED_CLOSED_SET_ENTRIES = ['SKILL.md', 'schema.json', 'manifest.json'];

function namedFailure(name, detail) {
  throw new Error(`${name}: ${detail}`);
}

// ---- confined reads (wave-12 review fix: ancestor confinement + no-follow descriptors) --

/**
 * Read a file under the skill root WITHOUT escapes, at read time:
 *
 *   1. every ANCESTOR directory component is lstat'd right before the open and must be a
 *      REAL directory — an `assets` symlink pointing outside the root would otherwise
 *      smuggle outside bytes into the digest through a textually-in-range path;
 *   2. the leaf is opened with O_NOFOLLOW and verified a REGULAR file through the SAME
 *      descriptor the bytes are read from — a leaf swapped for an outside symlink after
 *      inspection cannot reappear through the read (ELOOP or a non-regular fstat fails);
 *   3. the bytes come from that descriptor only.
 *
 * POSIX-without-openat caveat: an ancestor renamed to a symlink between its lstat and the
 * leaf open is not fully eliminable in Node's sync API; the walk is performed immediately
 * before each open to shrink the window to the single call, and the leaf descriptor keeps
 * the read confined regardless.
 *
 * ENOENT maps to the caller's chosen missing-failure name (SKILL.md is skill_absent; a
 * closed-set member is undeclared_dependency). Everything else fails closed as
 * undeclared_dependency with the reason in the detail.
 */
function readConfinedFile(skillRoot, rel, { missingFailure = 'undeclared_dependency', missingDetail } = {}) {
  const parts = rel.split('/');
  let acc = skillRoot;
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = path.join(acc, parts[i]);
    let st;
    try {
      st = fs.lstatSync(acc);
    } catch {
      namedFailure('undeclared_dependency', `closed_file_set entry ${rel} is unreadable: ancestor ${parts.slice(0, i + 1).join('/')} is missing (§5.5)`);
    }
    if (!st.isDirectory()) {
      namedFailure('undeclared_dependency', `closed_file_set entry ${rel} escapes the skill root: ancestor ${parts.slice(0, i + 1).join('/')} is not a real directory (symlink or otherwise) — a path escaping the skill root fails closed (§5.5)`);
    }
  }
  const full = path.join(skillRoot, rel);
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') {
      namedFailure(missingFailure, missingDetail || `closed_file_set entry ${rel} is missing from the skill tree — a listed file that is missing fails closed (§5.5)`);
    }
    namedFailure('undeclared_dependency', `closed_file_set entry ${rel} failed its no-follow open (${e.code}) — missing, or replaced by a symlink at read time; a path escaping the skill root fails closed (§5.5)`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      namedFailure('undeclared_dependency', `closed_file_set entry ${rel} is not a regular file at read time (the opened descriptor is ${st.isDirectory() ? 'a directory' : 'not a regular file'}) — a path escaping the skill root fails closed (§5.5)`);
    }
    const chunks = [];
    for (;;) {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// SKILL.md is the skill's own presence: without it there is no installed skill at all —
// not merely an incomplete one (§5.5's skill_absent names root, manifest AND SKILL.md).
function requireSkillMd(skillRoot) {
  // ENOENT maps to skill_absent (no readable SKILL.md); an escape (a symlinked or
  // non-regular SKILL.md) fails as the more precise undeclared_dependency from the
  // confined read itself.
  readConfinedFile(skillRoot, 'SKILL.md', {
    missingFailure: 'skill_absent',
    missingDetail: `the installed skill has no readable SKILL.md at ${path.join(skillRoot, 'SKILL.md')}`,
  });
}

// ---- manifest ----------------------------------------------------------------

function loadManifest(skillRoot) {
  if (typeof skillRoot !== 'string' || skillRoot.trim() === '') {
    namedFailure('skill_absent', `the skill root is required — resolve the INSTALLED skill, never a caller-supplied schema (got ${JSON.stringify(skillRoot)})`);
  }
  let stat;
  try {
    stat = fs.statSync(skillRoot);
  } catch {
    namedFailure('skill_absent', `the installed skill root does not exist or is unreadable: ${skillRoot}`);
  }
  if (!stat.isDirectory()) {
    namedFailure('skill_absent', `the skill root is not a directory: ${skillRoot}`);
  }
  const manifestPath = path.join(skillRoot, 'manifest.json');
  let manifestBytes;
  try {
    manifestBytes = fs.readFileSync(manifestPath);
  } catch {
    namedFailure('skill_absent', `the installed skill has no readable manifest.json at ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (e) {
    namedFailure('skill_absent', `the skill's manifest.json is not valid JSON (${e.message}) — the closed file set cannot be established`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    namedFailure('skill_absent', 'the skill\'s manifest.json is not an object');
  }
  return manifest;
}

// ---- version validation (§5.5 fail-closed, no silent downgrade) ----------------

function validateHostContractVersion(manifest) {
  const v = manifest.host_contract_version;
  if (!Number.isInteger(v) || !SUPPORTED_HOST_CONTRACT_VERSIONS.includes(v)) {
    namedFailure(
      'host_contract_unsupported',
      `the skill's manifest declares host_contract_version ${JSON.stringify(v)}, which this host does not support (supported: ${SUPPORTED_HOST_CONTRACT_VERSIONS.join(', ')}) — there is no silent downgrade (§5.5)`
    );
  }
  return v;
}

// Loads the skill's schema.json and validates its format version against the
// manifest-declared schema_format_version. Returns { bytes, version }.
function loadValidatedSchema(skillRoot, manifest) {
  const declared = manifest.schema_format_version;
  if (!Number.isInteger(declared) || !SUPPORTED_SCHEMA_FORMAT_VERSIONS.includes(declared)) {
    namedFailure(
      'schema_unsupported',
      `the skill's manifest declares schema_format_version ${JSON.stringify(declared)}, which this host does not support (supported: ${SUPPORTED_SCHEMA_FORMAT_VERSIONS.join(', ')}) — a schema upgrade is an explicit amendment, never a silent migration (§5.5)`
    );
  }
  const schemaPath = path.join(skillRoot, 'schema.json');
  // Confined read: plain absence keeps the declared-core message (undeclared_dependency);
  // a symlinked or non-regular schema.json fails as the escape it is.
  const bytes = readConfinedFile(skillRoot, 'schema.json', {
    missingFailure: 'undeclared_dependency',
    missingDetail: `the declared schema.json is missing or unreadable at ${schemaPath} — a closed-set file must exist in the tree (§5.5)`,
  });
  let schema;
  try {
    schema = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    namedFailure('schema_unsupported', `the skill's schema.json is malformed (${e.message}) — a missing, malformed, unsupported or mismatched schema fails closed (§5.5)`);
  }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    namedFailure('schema_unsupported', "the skill's schema.json is not a JSON object");
  }
  if (schema.version !== declared) {
    namedFailure(
      'schema_unsupported',
      `the schema's format version ${JSON.stringify(schema.version)} does not match the manifest-declared schema_format_version ${declared} — a mismatched schema fails closed (§5.5)`
    );
  }
  return { bytes, version: declared };
}

// ---- the closed file set --------------------------------------------------------

// The closed set is closed by requiring the manifest to be COMPLETE: it must declare every
// behavior-affecting asset it consists of, and every declared entry must be a real regular
// file inside the skill root. Missing files and path escapes fail closed
// (undeclared_dependency), never a lenient subset digest.
function validateClosedFileSet(manifest, skillRoot) {
  const identity = manifest.identity;
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    namedFailure('undeclared_dependency', "the manifest carries no identity object — the closed file set cannot be established, so every file the skill loads is undeclared (§5.5)");
  }
  const set = identity.closed_file_set;
  if (!Array.isArray(set) || set.length === 0) {
    namedFailure('undeclared_dependency', "the manifest's identity.closed_file_set is missing or empty — the digest would cover a chosen subset rather than the implementation (§5.5)");
  }
  const seen = new Set();
  for (const rel of set) {
    if (typeof rel !== 'string' || rel.trim() === '') {
      namedFailure('undeclared_dependency', `a closed_file_set entry is not a non-empty string: ${JSON.stringify(rel)}`);
    }
    if (seen.has(rel)) {
      namedFailure('undeclared_dependency', `duplicate closed_file_set entry: ${rel}`);
    }
    seen.add(rel);
    // Path-escape refusal: a manifest-relative POSIX path only — no absolute paths, no
    // traversal, no Windows separators (a backslash is not a POSIX separator and would
    // name a different file on the skill root's filesystem).
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || rel.split('/').includes('..') || rel.split('/').includes('')) {
      namedFailure('undeclared_dependency', `closed_file_set entry escapes the skill root: ${rel}`);
    }
    // lstat (never stat): a symlink entry would read bytes from OUTSIDE the root while
    // passing the textual path check — only a regular file inside the root is a closed-set
    // member.
    let st;
    try {
      st = fs.lstatSync(path.join(skillRoot, rel));
    } catch {
      namedFailure('undeclared_dependency', `closed_file_set entry ${rel} is missing from the skill tree — a listed file that is missing fails closed (§5.5)`);
    }
    if (!st.isFile()) {
      namedFailure('undeclared_dependency', `closed_file_set entry ${rel} is not a regular file (symlink, directory or device) — a path escaping the skill root fails closed (§5.5)`);
    }
  }
  // Completeness: the files the host contract necessarily loads, and every declared asset,
  // must be IN the set — otherwise the set omits a file the skill reads and the digest
  // covers a subset.
  for (const required of REQUIRED_CLOSED_SET_ENTRIES) {
    if (!seen.has(required)) {
      namedFailure('undeclared_dependency', `the closed_file_set does not declare ${required}, which the skill always loads — the set is not closed (§5.5)`);
    }
  }
  const assets = manifest.assets;
  if (assets !== undefined) {
    if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) {
      namedFailure('undeclared_dependency', "the manifest's assets entry is not an object");
    }
    for (const asset of Object.keys(assets)) {
      if (!seen.has(asset)) {
        namedFailure('undeclared_dependency', `the manifest declares asset ${asset} but identity.closed_file_set does not list it — the digest would not cover a file the skill loads (§5.5)`);
      }
    }
  }
  return set;
}

// ---- the identity digest (byte-identical to the reference algorithm) -----------

// Entries sorted in ascending byte order of the manifest-relative POSIX path (the reference
// recomputation's [...set].sort(): default string order, identical to byte order for the
// ASCII POSIX paths a manifest declares); each entry contributes the UTF-8 bytes of its
// path, a newline, the 64-character lowercase hex sha256 of its exact bytes, and a newline,
// into one running sha256. The identity is the final digest in lowercase hex.
function digestClosedFileSet(set, skillRoot) {
  const h = crypto.createHash('sha256');
  for (const rel of [...set].sort()) {
    // Confined read AT DIGEST TIME: the validation lstats happened moments ago, but the
    // bytes the identity digests come from no-follow descriptors whose ancestors were
    // just re-verified — a post-inspection swap fails closed instead of digesting outside
    // content (wave-12 review finding).
    const bytes = readConfinedFile(skillRoot, rel);
    h.update(rel, 'utf8');
    h.update('\n', 'utf8');
    h.update(sha256Hex(bytes), 'utf8');
    h.update('\n', 'utf8');
  }
  return h.digest('hex');
}

// ---- the two seam ops (SCHEMA_SNAPSHOT_MODULE_OPS) ------------------------------

// The §5.5 skill identity: the digest over the closed manifest-declared file set. The same
// validation captureSchemaSnapshot applies (a skill the host cannot honor cannot be amended
// to either), then the digest. Guard failures throw named, verbatim-propagated.
export function computeSkillIdentity({ skillRoot } = {}) {
  const manifest = loadManifest(skillRoot); // skill_absent
  requireSkillMd(skillRoot); // skill_absent
  validateHostContractVersion(manifest); // host_contract_unsupported
  loadValidatedSchema(skillRoot, manifest); // schema_unsupported / undeclared_dependency
  const set = validateClosedFileSet(manifest, skillRoot); // undeclared_dependency
  return digestClosedFileSet(set, skillRoot);
}

// The §5.5 approved-capture result: the schema snapshot digest (exact BYTES — artifact
// identity, the snapshot is compared by exact bytes), the skill identity (the closed-set
// digest), and the skill's declared versions carried beside it (supplementary, never a
// substitute for the digest).
export function captureSchemaSnapshot({ skillRoot } = {}) {
  const manifest = loadManifest(skillRoot); // skill_absent
  requireSkillMd(skillRoot); // skill_absent
  const hostContractVersion = validateHostContractVersion(manifest); // host_contract_unsupported
  const schema = loadValidatedSchema(skillRoot, manifest); // schema_unsupported / undeclared_dependency
  const set = validateClosedFileSet(manifest, skillRoot); // undeclared_dependency
  const skillIdentity = digestClosedFileSet(set, skillRoot);
  return {
    schema_sha256: sha256Hex(schema.bytes),
    skill_identity: skillIdentity,
    host_contract_version: hostContractVersion,
    schema_format_version: schema.version,
  };
}