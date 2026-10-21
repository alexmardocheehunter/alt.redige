/**
 * Content-Security-Policy.
 *
 * The frontend is a single HTML file that carries its own inline `<script>`.
 * A static CSP without a nonce would block it, so the server issues a nonce
 * per response and injects it into the inline scripts it serves. The file on
 * disk is never modified.
 */
import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

export const CSP_NONCE_KEY = 'cspNonce';

function buildPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // The nonce authorises the inline script of the page; 'self' keeps the
    // external files (none today) allowed.
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Issues a per-response nonce and the matching policy. */
export function contentSecurityPolicy(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nonce = randomBytes(16).toString('base64');
    c.set(CSP_NONCE_KEY, nonce);
    c.header('Content-Security-Policy', buildPolicy(nonce));
    await next();
  };
}

/**
 * Adds the nonce to the inline scripts of the page.
 * Only the `<script>` tags without a `src` are touched.
 */
export function applyNonce(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (match, attributes: string) => {
    if (/\bnonce=/i.test(attributes)) return match;
    return `<script${attributes} nonce="${nonce}">`;
  });
}
