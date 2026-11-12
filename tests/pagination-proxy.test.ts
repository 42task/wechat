import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import supertest from 'supertest';
import { createApplication } from '../src/application';
import type { Context, Services } from '../src/core/contracts';
import { paginationOrigin } from '../src/core/pagination';
import { Integrations } from '../src/integrations/integrations';

describe('Yii pagination connection protocol', () => {
  it('uses the application socket rather than forwarded HTTPS for pagination only', () => {
    const req = { protocol: 'https', socket: {}, get: () => 'fixture.example' } as unknown as Request;
    expect(paginationOrigin(req)).toBe('http://fixture.example');
    expect(req.protocol).toBe('https');
    expect(paginationOrigin({ ...req, protocol: 'http', socket: { encrypted: true } } as unknown as Request)).toBe('https://fixture.example');
    expect(paginationOrigin({ protocol: 'https', get: () => 'fixture.example' } as unknown as Request)).toBe('https://fixture.example');
  });
});

describe('pagination behind the existing trusted proxy', () => {
  let app: INestApplication, request: ReturnType<typeof supertest>;
  const observed: Array<{ path: string; protocol: string; ip: string | undefined }> = [];
  const api = new Integrations({ notifyUrl: undefined });
  const order = vi.spyOn(api, 'order').mockResolvedValue({ fixture: 'mock-provider-result' });
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('PUBLIC_ORIGIN', undefined); vi.stubEnv('WECHAT_PAY_NOTIFY_URL', undefined);
    const device = { id: 1, uuid: 'fixture-device', tag: 'fixture', version: 7, shop_id: null };
    const db = {
      query: vi.fn(async () => [device]),
      one: vi.fn(async (sql: string) => /COUNT\(\*\)/i.test(sql) ? { total: 1 } : /FROM\s+`?device`?/i.test(sql) ? device : null),
      columns: vi.fn(async () => [{ name: 'id', key: 'PRI' }, { name: 'device_id' }, { name: 'title' }]),
      insert: vi.fn(async (_table: string, data: object) => ({ id: 21, ...data })),
    };
    const auth = { bearer: vi.fn(async (ctx: Context) => {
      observed.push({ path: ctx.req.path, protocol: ctx.req.protocol, ip: ctx.req.ip }); return { id: 1, role: 'manager' };
    }) };
    const services = { db, auth, redis: { ping: async () => 'PONG', find: async () => null, save: async () => undefined },
      catalog: {}, integrations: api } as unknown as Services;
    app = await createApplication(services); request = supertest(app.getHttpServer());
  });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });
  function forwarded(test: any) {
    return test.set('Host', 'public.example.test').set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'ignored.example.test').set('X-Forwarded-For', '203.0.113.7');
  }
  it.each(['/v1/device', '/v2/devices'])('matches the source HTTP Link for %s without changing trusted request identity', async url => {
    const response = await forwarded(request.get(url)).expect(200);
    expect(response.headers.link).toContain('<http://public.example.test' + url + '?page=1>');
    expect(response.headers.link).not.toContain('https://');
    expect(response.headers.link).not.toContain('ignored.example.test');
    expect(observed.at(-1)).toEqual({ path: url, protocol: 'https', ip: '203.0.113.7' });
  });
  it('retains HTTPS Location for the unchanged resource creation path', async () => {
    const response = await forwarded(request.post('/v2/setups')).send({ device_id: 1, title: 'Fixture' }).expect(201);
    expect(response.headers.location).toBe('https://public.example.test/v2/setups/21');
  });
  it('retains the HTTPS payment notification origin and never contacts a provider', async () => {
    const response = await forwarded(request.post('/v1/wechat-pay/wxpay-order'))
      .send({ openid: 'fixture-payer', out_trade_no: 'fixture_order_01', amount: 100 }).expect(200);
    expect(response.body.code).toBe(0);
    expect(order).toHaveBeenLastCalledWith(expect.objectContaining({ out_trade_no: 'fixture_order_01' }), 'https://public.example.test/v1/wechat-pay/notify');
  });
});
