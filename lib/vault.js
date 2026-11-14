/**
 * Envelope encryption for the credential vault.
 *
 * Structure: a random 32-byte Data Encryption Key (DEK) encrypts the vault
 * payload, and a Key Encryption Key derived from the master password (KEK)
 * encrypts the DEK. Re-keying the password therefore rewrites one small block
 * instead of the whole file.
 *
 *   password --scrypt--> KEK --AES-256-GCM--> DEK --AES-256-GCM--> payload
 *
 * The header (version + KDF parameters) is authenticated as AAD on both
 * blocks, so an attacker cannot lower the work factor or roll the format back
 * without the tag failing.
 *
 * This is deliberately plain `node:crypto`: no dependencies, and the CLI can
 * read a vault without the harness.
 */
import crypto from 'node:crypto';

export const VAULT_VERSION = 1;

/** scrypt cost. 2^15 with r=8 is ~32 MiB and tens of milliseconds: enough to
 * make offline guessing expensive without slowing startup noticeably. */
export const DEFAULT_KDF = Object.freeze({ name: 'scrypt', N: 1 << 15, r: 8, p: 1 });
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** 128 * N * r must fit, with headroom over the default 32 MiB cap. */
const SCRYPT_MAXMEM = 128 * (1 << 15) * 8 * 2;

/** Derive the KEK from the master password. */
function deriveKek(password, salt, kdf) {
  return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, KEY_BYTES, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** The authenticated header: binds version and KDF parameters to both blocks. */
function headerAad(version, kdf) {
  return Buffer.from(JSON.stringify({
    v: version,
    kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p },
  }), 'utf8');
}

/** One AES-256-GCM block. */
function sealBlock(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** One AES-256-GCM block, verified against its tag and AAD. */
function openBlock(key, block, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(block.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(block.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(block.data, 'base64')), decipher.final()]);
}

/**
 * Encrypt a payload.
 * @param payload - any JSON-serialisable value.
 * @param password - the master password.
 * @returns the envelope, safe to write to disk.
 */
export function sealVault(payload, password, kdfOptions = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('a master password is required to seal the vault');
  }
  const kdf = { ...DEFAULT_KDF, ...kdfOptions };
  const salt = crypto.randomBytes(SALT_BYTES);
  const kek = deriveKek(password, salt, kdf);
  const dek = crypto.randomBytes(KEY_BYTES);
  const aad = headerAad(VAULT_VERSION, kdf);

  const wrappedDek = sealBlock(kek, dek, aad);
  const body = sealBlock(dek, Buffer.from(JSON.stringify(payload), 'utf8'), aad);
  dek.fill(0);
  kek.fill(0);

  return {
    version: VAULT_VERSION,
    kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
    dek: wrappedDek,
    payload: body,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt an envelope.
 *
 * Throws a message that distinguishes a wrong password from a damaged file,
 * because those need different advice: retype versus restore a backup.
 */
export function openVault(envelope, password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('a master password is required to open the vault');
  }
  const parsed = validateEnvelope(envelope);
  const salt = Buffer.from(parsed.kdf.salt, 'base64');
  const kek = deriveKek(password, salt, parsed.kdf);
  const aad = headerAad(parsed.version, parsed.kdf);

  let dek;
  try {
    dek = openBlock(kek, parsed.dek, aad);
  } catch {
    throw new Error('the master password is wrong, or the vault header was tampered with');
  } finally {
    kek.fill(0);
  }

  let plaintext;
  try {
    plaintext = openBlock(dek, parsed.payload, aad);
  } catch {
    throw new Error('the vault body failed its integrity check; the file is damaged');
  } finally {
    dek.fill(0);
  }

  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('the vault body is valid but does not contain JSON');
  }
}

/** Structural checks shared by open and rekey. */
function validateEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') {
    throw new Error('the vault file is not an envelope');
  }
  if (envelope.version !== VAULT_VERSION) {
    throw new Error(`the vault is format version ${envelope.version}, which this plugin does not read`);
  }
  const kdf = envelope.kdf;
  if (kdf === null || typeof kdf !== 'object') throw new Error('the vault header has no KDF block');
  if (kdf.name !== 'scrypt') throw new Error(`unsupported KDF "${kdf.name}"`);
  for (const field of ['N', 'r', 'p']) {
    if (!Number.isInteger(kdf[field]) || kdf[field] <= 0) {
      throw new Error(`the vault KDF field ${field} is missing or invalid`);
    }
  }
  if (kdf.N > (1 << 20)) throw new Error('the vault KDF cost is implausibly high');
  for (const field of ['dek', 'payload']) {
    const block = envelope[field];
    if (block === null || typeof block !== 'object'
      || typeof block.iv !== 'string' || typeof block.tag !== 'string' || typeof block.data !== 'string') {
      throw new Error(`the vault block "${field}" is malformed`);
    }
    if (Buffer.from(block.tag, 'base64').length !== TAG_BYTES) {
      throw new Error(`the vault block "${field}" has an invalid tag length`);
    }
    if (Buffer.from(block.iv, 'base64').length !== IV_BYTES) {
      throw new Error(`the vault block "${field}" has an invalid IV length`);
    }
  }
  return envelope;
}

/** Whether a parsed JSON object looks like a vault envelope. */
export function isVaultEnvelope(value) {
  return value !== null && typeof value === 'object'
    && typeof value.version === 'number'
    && typeof value.kdf === 'object' && value.kdf !== null
    && typeof value.dek === 'object' && value.dek !== null
    && typeof value.payload === 'object' && value.payload !== null;
}

/** Re-encrypt with a new password, keeping the same payload. */
export function rekeyVault(envelope, oldPassword, newPassword, kdfOptions) {
  const payload = openVault(envelope, oldPassword);
  return sealVault(payload, newPassword, kdfOptions);
}
