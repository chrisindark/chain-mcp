import * as crypto from "node:crypto";

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    validateKeyName(key);
    return this.secrets.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    validateKeyName(key);
    if (typeof value !== "string") {
      throw new TypeError("Secret value must be a string");
    }
    this.secrets.set(key, value);
  }

  async delete(key: string): Promise<void> {
    validateKeyName(key);
    this.secrets.delete(key);
  }

  clear(): void {
    this.secrets.clear();
  }

  get size(): number {
    return this.secrets.size;
  }
}

export type KeyRing =
  | Readonly<Record<string, Buffer | string>>
  | ReadonlyMap<string, Buffer | string>;

export interface EncryptedSecretStoreOptions {
  /** Underlying secret store where ciphertexts are persisted. */
  store: SecretStore;
  /** Active key ID used for all new encryptions. Must exist in keys. */
  activeKeyId: string;
  /** Key ring mapping key IDs to 256-bit (32 bytes) keys. Keys may be Buffers or 64-char hex strings. */
  keys: KeyRing;
}

const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const MAX_SECRET_VALUE_BYTES = 1024 * 1024; // 1 MiB

const KEY_NAME_PATTERN = /^[a-zA-Z0-9_:./-]{1,256}$/;
const KEY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function validateKeyName(key: string): void {
  if (
    typeof key !== "string" ||
    !KEY_NAME_PATTERN.test(key) ||
    RESERVED_NAMES.has(key)
  ) {
    throw new TypeError(
      `Invalid secret key name '${key}'. Must be 1-256 printable characters [a-zA-Z0-9_:./-] and not reserved.`,
    );
  }
}

function validateKeyId(keyId: string): void {
  if (
    typeof keyId !== "string" ||
    !KEY_ID_PATTERN.test(keyId) ||
    RESERVED_NAMES.has(keyId)
  ) {
    throw new TypeError(
      `Invalid key ID '${keyId}'. Must match /^[a-zA-Z0-9_-]{1,64}$/ and not be reserved.`,
    );
  }
}

function normalizeKeyBuffer(keyId: string, rawKey: Buffer | string): Buffer {
  if (Buffer.isBuffer(rawKey)) {
    if (rawKey.byteLength !== 32) {
      throw new TypeError(
        `Secret key '${keyId}' must be exactly 32 bytes (256 bits), got ${rawKey.byteLength} bytes`,
      );
    }
    return rawKey;
  }
  if (typeof rawKey === "string") {
    const trimmed = rawKey.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }
    if (Buffer.byteLength(trimmed, "utf8") === 32) {
      return Buffer.from(trimmed, "utf8");
    }
    throw new TypeError(
      `Secret key '${keyId}' string must be a 64-character hex string or 32 UTF-8 bytes`,
    );
  }
  throw new TypeError(`Secret key '${keyId}' must be a Buffer or string`);
}

/**
 * Authenticated secret store implementing AES-256-GCM encryption at rest.
 *
 * Security properties:
 * - 256-bit keys with explicit key IDs.
 * - Cryptographically random 96-bit (12-byte) IV per encryption.
 * - 128-bit (16-byte) authentication tag.
 * - Additional Authenticated Data (AAD) bound to the secret key name so ciphertexts
 *   cannot be swapped across keys within the store.
 * - Key rotation: decrypts using any configured key in the key ring, and encrypts
 *   new secrets with `activeKeyId`.
 * - Fail-closed: corrupted ciphertexts, invalid auth tags, or missing keys throw.
 */
export class EncryptedSecretStore implements SecretStore {
  private readonly store: SecretStore;
  private readonly activeKeyId: string;
  private readonly keyRing = new Map<string, Buffer>();

  constructor(options: EncryptedSecretStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("EncryptedSecretStore requires options");
    }
    if (!options.store || typeof options.store.get !== "function") {
      throw new TypeError(
        "EncryptedSecretStore requires a valid underlying store",
      );
    }
    if (
      typeof options.activeKeyId !== "string" ||
      options.activeKeyId.trim().length === 0
    ) {
      throw new TypeError(
        "EncryptedSecretStore requires a non-empty activeKeyId",
      );
    }
    this.store = options.store;
    validateKeyId(options.activeKeyId);
    this.activeKeyId = options.activeKeyId.trim();

    const keysEntries =
      options.keys instanceof Map
        ? options.keys.entries()
        : Object.entries(options.keys ?? {});

    for (const [keyId, rawKey] of keysEntries) {
      const normalizedKeyId = keyId.trim();
      if (normalizedKeyId.length === 0) continue;
      validateKeyId(normalizedKeyId);
      this.keyRing.set(
        normalizedKeyId,
        normalizeKeyBuffer(normalizedKeyId, rawKey),
      );
    }

    if (!this.keyRing.has(this.activeKeyId)) {
      throw new TypeError(
        `activeKeyId '${this.activeKeyId}' not found in provided keys`,
      );
    }
  }

  async get(key: string): Promise<string | undefined> {
    validateKeyName(key);
    const raw = await this.store.get(key);
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") {
      throw new TypeError(`Secret store returned non-string for key '${key}'`);
    }

    return this.decrypt(key, raw);
  }

  async set(key: string, value: string): Promise<void> {
    validateKeyName(key);
    if (typeof value !== "string") {
      throw new TypeError("Secret value must be a string");
    }
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new RangeError(
        `Secret value exceeds maximum size of ${MAX_SECRET_VALUE_BYTES} bytes`,
      );
    }

    const encrypted = this.encrypt(key, value);
    await this.store.set(key, encrypted);
  }

  async delete(key: string): Promise<void> {
    validateKeyName(key);
    await this.store.delete(key);
  }

  /**
   * Re-encrypts an existing secret with the current active key (or a specified target key).
   * Returns true if the key existed and was re-encrypted, or false if not found.
   */
  async rotate(key: string, targetKeyId?: string): Promise<boolean> {
    validateKeyName(key);
    const plain = await this.get(key);
    if (plain === undefined) return false;

    const keyToUse = targetKeyId ? targetKeyId.trim() : this.activeKeyId;
    validateKeyId(keyToUse);
    if (!this.keyRing.has(keyToUse)) {
      throw new Error(`Target key ID '${keyToUse}' not found in key ring`);
    }

    const encrypted = this.encryptWithKey(key, plain, keyToUse);
    await this.store.set(key, encrypted);
    return true;
  }

  private encrypt(secretName: string, plaintext: string): string {
    return this.encryptWithKey(secretName, plaintext, this.activeKeyId);
  }

  private encryptWithKey(
    secretName: string,
    plaintext: string,
    keyId: string,
  ): string {
    const key = this.keyRing.get(keyId);
    if (!key) {
      throw new Error(`Encryption key '${keyId}' not found`);
    }

    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv);
    // Bind the secret name as Additional Authenticated Data (AAD)
    cipher.setAAD(Buffer.from(secretName, "utf8"));

    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Format: v1:<keyId>:<ivHex>:<tagHex>:<cipherHex>
    return `v1:${keyId}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
  }

  private decrypt(secretName: string, serialized: string): string {
    const parts = serialized.split(":");
    if (parts.length !== 5 || parts[0] !== "v1") {
      throw new Error(
        `Invalid or unsupported ciphertext format for key '${secretName}'`,
      );
    }

    const [, keyId, ivHex, tagHex, cipherHex] = parts;
    if (!keyId || !KEY_ID_PATTERN.test(keyId) || RESERVED_NAMES.has(keyId)) {
      throw new Error(
        `Invalid key ID in ciphertext format for key '${secretName}'`,
      );
    }
    const key = this.keyRing.get(keyId);
    if (!key) {
      throw new Error(
        `Decryption failed: key ID '${keyId}' not available in key ring`,
      );
    }

    if (ivHex!.length !== IV_LENGTH_BYTES * 2) {
      throw new Error(`Invalid IV length for secret key '${secretName}'`);
    }
    if (tagHex!.length !== AUTH_TAG_LENGTH_BYTES * 2) {
      throw new Error(`Invalid auth tag length for secret key '${secretName}'`);
    }

    const iv = Buffer.from(ivHex!, "hex");
    const tag = Buffer.from(tagHex!, "hex");
    const ciphertext = Buffer.from(cipherHex!, "hex");

    try {
      const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(secretName, "utf8"));

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return decrypted.toString("utf8");
    } catch (error) {
      throw new Error(
        `Failed to decrypt secret '${secretName}': authentication verification failed or data corrupted`,
        { cause: error },
      );
    }
  }
}
