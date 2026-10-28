// SPDX-License-Identifier: Apache-2.0
import crypto from 'crypto';
import fs from 'fs';
import { getSessionSecretPath } from './paths.js';

let sessionSecretCache: string | null = null;

export function getSessionSecret(): string {
  if (sessionSecretCache) {
    return sessionSecretCache;
  }

  const secretPath = getSessionSecretPath();
  if (fs.existsSync(secretPath)) {
    sessionSecretCache = fs.readFileSync(secretPath, 'utf8').trim();
    return sessionSecretCache;
  }

  const newSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, newSecret, { mode: 0o600, encoding: 'utf8' });
  sessionSecretCache = newSecret;
  return newSecret;
}

// In-memory one-time tokens: token -> { expiresAt }
const oneTimeTokens = new Map<string, { expiresAt: number }>();

export function generateOneTimeToken(): string {
  const token = crypto.randomBytes(24).toString('hex');
  oneTimeTokens.set(token, { expiresAt: Date.now() + 60_000 }); // 60s expiration
  return token;
}

export function verifyAndConsumeOneTimeToken(token: string): boolean {
  const record = oneTimeTokens.get(token);
  if (!record) return false;
  oneTimeTokens.delete(token);
  if (Date.now() > record.expiresAt) return false;
  return true;
}

// Session cookie value signature
export function createSessionCookie(): string {
  const secret = getSessionSecret();
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

export function verifySessionCookie(cookieValue?: string): boolean {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, signature] = parts;
  const secret = getSessionSecret();
  const expectedSignature = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
