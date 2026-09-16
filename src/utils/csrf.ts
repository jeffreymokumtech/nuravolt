import crypto from 'crypto';

const CSRF_SECRET = process.env.CSRF_SECRET || 'default-csrf-secret-change-in-production';
const TOKEN_LENGTH = 32;

export function generateCSRFToken(): string {
  const token = crypto.randomBytes(TOKEN_LENGTH).toString('hex');
  const hash = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(token)
    .digest('hex');
  
  return `${token}.${hash}`;
}

export function validateCSRFToken(token: string): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [tokenPart, hashPart] = parts;
  const expectedHash = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(tokenPart)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(hashPart),
    Buffer.from(expectedHash)
  );
}