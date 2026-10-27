import { createHash } from 'crypto';

/** SHA-256 hex digest for storing refresh tokens at rest (never raw JWT). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
