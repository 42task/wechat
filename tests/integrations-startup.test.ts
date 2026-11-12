import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { createApplication, createServices } from '../src/application';
import { Integrations } from '../src/integrations/integrations';
import fixtures from './fixtures/wechat-platform-test-keys.json';

const names = [
  'WECHAT_PAY_PLATFORM_KEYS_JSON', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH',
  'WECHAT_PAY_PLATFORM_SERIAL_NO', 'WECHAT_PUB_KEY', 'WECHAT_PUB_KEY_ID', 'WECHAT_PLATFORM_CERTS',
  'WECHAT_PAY_SERIAL_NO', 'WECHAT_CERTIFICATE', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY_PATH', 'WECHAT_PRIVATE_KEY',
  'WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_SECRET', 'COS_BUCKET', 'COS_REGION', 'COS_BUCKETS_BUCKET', 'COS_BUCKETS_REGION',
];
let directory: string;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const name of names) vi.stubEnv(name, undefined);
  vi.stubEnv('WECHAT_APP_ID', 'wx-local-startup');
  vi.stubEnv('WECHAT_APP_SECRET', 'local-test-secret');
  vi.stubEnv('COS_BUCKET', 'fixture-1250000000');
  vi.stubEnv('COS_REGION', 'ap-nanjing');
  directory = mkdtempSync(join(tmpdir(), 'wechat-payment-startup-'));
  fetcher = vi.fn(async () => Response.json({ openid: 'local-verified-openid' }));
  vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('payment-only configuration failures stay isolated until payment use', () => {
  it.each([
    ['legacy merchant private-key file missing', 'WECHAT_PRIVATE_KEY', 'missing-file'],
    ['modern merchant private-key file missing', 'WECHAT_PAY_PRIVATE_KEY_PATH', 'missing-file'],
    ['merchant private-key PEM malformed', 'WECHAT_PAY_PRIVATE_KEY', 'invalid PEM'],
    ['merchant certificate file missing', 'WECHAT_CERTIFICATE', 'missing-file'],
    ['merchant certificate PEM malformed', 'WECHAT_CERTIFICATE', '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'],
    ['platform map malformed JSON', 'WECHAT_PAY_PLATFORM_KEYS_JSON', '{invalid'],
    ['platform map null JSON', 'WECHAT_PAY_PLATFORM_KEYS_JSON', 'null'],
    ['platform map array JSON', 'WECHAT_PAY_PLATFORM_KEYS_JSON', '[]'],
    ['platform map invalid key material', 'WECHAT_PAY_PLATFORM_KEYS_JSON', '{"fixture":"invalid PEM"}'],
    ['platform public-key file missing', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH', 'missing-file'],
    ['platform rotation list malformed JSON', 'WECHAT_PLATFORM_CERTS', '{invalid'],
  ])('does not block service construction, health or login: %s', async (_description, name, value) => {
    vi.stubEnv(name, value === 'missing-file' ? join(directory, 'does-not-exist.pem') : value);
    const services = createServices();
    // Verify the actual service factory and health route without opening MySQL
    // or Redis connections. The provider transport is an in-process stub.
    vi.spyOn(services.db, 'query').mockResolvedValue([{ ready: 1 }]);
    vi.spyOn(services.redis, 'ping').mockResolvedValue('PONG');
    const app = await createApplication(services);
    try {
      const health = await supertest(app.getHttpServer()).get('/health').expect(200);
      expect(health.body.status).toBe('healthy');
      expect(services.integrations.cloud()).toEqual({ bucket: 'fixture-1250000000', region: 'ap-nanjing' });
      await expect(services.integrations.codeSession('local-synthetic-code')).resolves.toMatchObject({ openid: 'local-verified-openid' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockClear();
      await expect(services.integrations.payment('GET', '/v3/certificates')).rejects.toMatchObject({ status: 503, message: '微信支付验证配置无效' });
      await expect(services.integrations.notification('{}', {})).rejects.toMatchObject({ status: 503, message: '微信支付验证配置无效' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await Promise.all([services.db.close(), services.redis.close(), services.adminAuthRedis?.close()]);
    }
  });

  it('reports incomplete payment configuration as 503 without breaking unrelated services', async () => {
    const services = createServices();
    try {
      expect(services.integrations.cloud()).toEqual({ bucket: 'fixture-1250000000', region: 'ap-nanjing' });
      await expect(services.integrations.codeSession('code')).resolves.toMatchObject({ openid: 'local-verified-openid' });
      fetcher.mockClear();
      await expect(services.integrations.payment('GET', '/v3/certificates')).rejects.toMatchObject({ status: 503, message: '微信支付验证配置不完整' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await Promise.all([services.db.close(), services.redis.close(), services.adminAuthRedis?.close()]); }
  });

  it('defers invalid directly injected merchant signing material as well', async () => {
    const first = fixtures.platforms[0];
    const integration = new Integrations({ appId: 'wx-local-startup', appSecret: 'local-test-secret', mchId: 'merchant', serialNo: 'merchant-serial', privateKey: 'invalid PEM', platformKeys: { fixture: first.certificate }, fetch: fetcher });
    await expect(integration.codeSession('code')).resolves.toMatchObject({ openid: 'local-verified-openid' });
    fetcher.mockClear();
    await expect(integration.payment('POST', '/v3/pay/transactions/jsapi', {})).rejects.toMatchObject({ status: 503, message: '微信支付验证配置无效' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('continues to load valid legacy merchant material without normalizing its bytes', () => {
    const first = fixtures.platforms[0];
    const path = join(directory, 'merchant.pem');
    writeFileSync(path, first.privateKey);
    vi.stubEnv('WECHAT_PRIVATE_KEY', path);
    vi.stubEnv('WECHAT_CERTIFICATE', first.certificate);
    const integration = new Integrations();
    expect(integration.config.privateKey).toBe(first.privateKey);
    expect(integration.config.serialNo).toMatch(/^[0-9A-F]+$/i);
  });
});
