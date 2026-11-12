import express, { type RequestHandler } from 'express';
import { resolve } from 'node:path';

/** The complete tracked Apache document-root files retained for an API cutover. */
export const legacyStaticPaths = Object.freeze([
  '/HyffLvU10s.txt',
  '/YnLzIY5Yjs.txt',
  '/robots.txt',
  '/favicon.ico',
  '/css/site.css',
] as const);

export function legacyStaticDirectory(): string {
  // Both src/core and dist/core have the repository/image root two levels up.
  return resolve(__dirname, '../../public-legacy');
}

/** Mount at the server root, before API routing. No directory is published. */
export function legacyStaticMiddleware(directory = legacyStaticDirectory()): RequestHandler {
  const allowed = new Set<string>(legacyStaticPaths);
  const serve = express.static(directory, {
    dotfiles: 'deny',
    index: false,
    redirect: false,
    fallthrough: true,
  });
  return (req, res, next) => {
    // Use the original case and path: Linux Apache does not alias case variants.
    // Encoded aliases, extra slashes and traversal never widen this allowlist.
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !allowed.has(req.path)) {
      next();
      return;
    }
    serve(req, res, next);
  };
}
