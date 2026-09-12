import crypto from 'crypto';
import config from '../config';

/**
 * Pass 31 — Multi-Tenant Clinics (per-clinic email). Encrypts credentials like
 * Clinic.gmailAppPassEnc / imageApiSecretEnc at rest, using AES-256-GCM.
 *
 * CLINIC_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key, base64-encoded (44 chars).
 * Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 *
 * Output format: `${ivBase64}:${authTagBase64}:${ciphertextBase64}` — the IV and auth
 * tag are not secret and are stored alongside the ciphertext, standard practice for
 * GCM. A fresh random IV is generated per encryption call (never reused), which is
 * what makes it safe to store the IV in plaintext next to the ciphertext.
 */

const ALGORITHM = 'aes-256-gcm';

const getKey = (): Buffer => {
    const keyB64 = config.clinicCredentialEncryptionKey;
    if (!keyB64) {
        throw new Error('CLINIC_CREDENTIAL_ENCRYPTION_KEY is not configured — cannot encrypt/decrypt clinic credentials.');
    }
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) {
        throw new Error('CLINIC_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
    }
    return key;
}

export const encryptCredential = (plaintext: string): string => {
    const key = getKey();
    const iv = crypto.randomBytes(12); // 96-bit IV, the GCM-recommended size
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export const decryptCredential = (stored: string): string => {
    const key = getKey();
    const [ivB64, authTagB64, ciphertextB64] = stored.split(':');
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
        throw new Error('Stored credential is not in the expected iv:authTag:ciphertext format.');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
}
