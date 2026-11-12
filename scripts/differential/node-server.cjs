// Execute the production build with a declared, network-free STS transport.
// No production service, route, SDK result or database implementation is mocked.
const { readFileSync } = require('node:fs');
const { createApplication, createServices } = require('../../dist/application');
const { Integrations } = require('../../dist/integrations/integrations');
async function main() {
  const services = createServices();
  const response = JSON.parse(readFileSync(require.resolve('./sts-http-response.json'), 'utf8'));
  services.integrations = new Integrations({
    secretId: 'synthetic-sts-id', secretKey: 'synthetic-sts-key',
    bucket: 'configured-1250000000', region: 'ap-shanghai',
    fetch: async input => {
      if (new URL(String(input)).hostname !== 'sts.tencentcloudapi.com') throw Error('Unexpected provider transport in isolated HTTP runner');
      return Response.json(response);
    },
  });
  const app = await createApplication(services);
  const shutdown = async () => { await app.close(); await Promise.allSettled([services.db.close(), services.redis.close()]); };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  await app.listen(Number(process.env.PORT || 18881), '127.0.0.1');
}
void main().catch(() => { console.error('Compiled isolated Node service failed to start.'); process.exitCode = 1; });
