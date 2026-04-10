// api/_lib/crypto.js
// Application-level AES-256-GCM encryption for sensitive fields.
// Used by action.js to automatically encrypt/decrypt workspace_credentials.
//
// Requires CREDENTIALS_ENCRYPTION_KEY env var (32-byte hex string).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Usage:
//   var crypto = require('./_lib/crypto');
//   var encrypted = crypto.encrypt('my secret');  // returns "v1:iv:ciphertext:tag"
//   var plain = crypto.decrypt(encrypted);        // returns "my secret"

var nodeCrypto = require('crypto');

var ALGO = 'aes-256-gcm';
var IV_BYTES = 12;
var PREFIX = 'v1:';

function getKey() {
  var hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

// Encrypt a plaintext string. Returns "v1:iv_hex:ciphertext_hex:tag_hex" or null if no key.
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  var key = getKey();
  if (!key) return plaintext; // Passthrough if no key configured

  var iv = nodeCrypto.randomBytes(IV_BYTES);
  var cipher = nodeCrypto.createCipheriv(ALGO, key, iv);
  var encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();

  return PREFIX + iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

// Decrypt a "v1:iv:ciphertext:tag" string. Returns plaintext or original string if not encrypted.
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // Not encrypted, return as-is

  var key = getKey();
  if (!key) return '[encrypted - key not available]';

  try {
    var parts = ciphertext.substring(PREFIX.length).split(':');
    if (parts.length !== 3) return ciphertext;

    var iv = Buffer.from(parts[0], 'hex');
    var encrypted = Buffer.from(parts[1], 'hex');
    var tag = Buffer.from(parts[2], 'hex');

    var decipher = nodeCrypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    var decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return '[decryption failed]';
  }
}

// Encrypt specific fields in an object. Returns a new object with encrypted values.
function encryptFields(obj, fields) {
  if (!obj) return obj;
  var result = Object.assign({}, obj);
  for (var i = 0; i < fields.length; i++) {
    if (result[fields[i]] && typeof result[fields[i]] === 'string' && !result[fields[i]].startsWith(PREFIX)) {
      result[fields[i]] = encrypt(result[fields[i]]);
    }
  }
  return result;
}

// Decrypt specific fields in an object (or array of objects).
function decryptFields(data, fields) {
  if (!data) return data;
  if (Array.isArray(data)) {
    return data.map(function(row) { return decryptFields(row, fields); });
  }
  var result = Object.assign({}, data);
  for (var i = 0; i < fields.length; i++) {
    if (result[fields[i]]) {
      result[fields[i]] = decrypt(result[fields[i]]);
    }
  }
  // Handle backup_codes array
  if (result.authenticator_backup_codes && Array.isArray(result.authenticator_backup_codes)) {
    result.authenticator_backup_codes = result.authenticator_backup_codes.map(function(code) {
      return decrypt(code);
    });
  }
  return result;
}

// Check if encryption is configured
function isConfigured() {
  return !!process.env.CREDENTIALS_ENCRYPTION_KEY;
}

// The fields that should be encrypted
var SENSITIVE_FIELDS = ['gmail_password', 'app_password', 'authenticator_secret_key', 'qr_code_image'];

module.exports = {
  encrypt: encrypt,
  decrypt: decrypt,
  encryptFields: encryptFields,
  decryptFields: decryptFields,
  isConfigured: isConfigured,
  SENSITIVE_FIELDS: SENSITIVE_FIELDS
};
