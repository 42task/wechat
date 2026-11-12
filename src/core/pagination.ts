import type { Request } from 'express';

/** Match Yii Request's default untrusted-forwarded-header pagination origin. */
export function paginationOrigin(req: Request): string {
  // Yii's deployed Request has trustedHosts=[], so TLS terminated by the proxy
  // does not make its application-side HTTP connection secure. Limit this
  // compatibility rule to pagination; req.protocol/ip and callback URL handling
  // retain the application's existing trusted-proxy policy.
  const socket = req.socket as (Request['socket'] & { encrypted?: boolean }) | undefined;
  const protocol = socket ? socket.encrypted ? 'https' : 'http' : req.protocol || 'http';
  return protocol + '://' + (req.get('host') || 'localhost');
}
