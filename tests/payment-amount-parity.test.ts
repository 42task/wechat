import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/application';
import type { Row, Services } from '../src/core/contracts';
import { parsePhpJson, phpNumberType, setPhpNumberType } from '../src/core/php';
import { MiniProgramFileService, priceInCents } from '../src/v2/file-service';

// Captured from unmodified game@74cae4c: MiniProgramFileService::prepareOrder
// with raw json_decode(..., true) inputs, and WechatPayController::actionWxpayOrder
// with only its final payApp()->getClient()->post/response replaced by a local
// recorder. No merchant, SQL, Redis or provider service participates in this test.
const sourceV2 = [
  { literal: '250', status: 200 },
  { literal: '250.0', status: 400 },
  { literal: '2.5e2', status: 400 },
  { literal: '"250"', status: 200 },
  { literal: 'null', status: 200 },
] as const;
const sourceV1 = [
  { literal: '100', code: 0, forwarded: 1, total: 100 },
  { literal: '-1', code: 0, forwarded: 1, total: -1 },
  { literal: '"0.0"', code: 0, forwarded: 1, total: 0 },
  { literal: '"-0"', code: 0, forwarded: 1, total: 0 },
  { literal: '"0e1"', code: 0, forwarded: 1, total: 0 },
  { literal: '"0"', code: 400, forwarded: 0 },
  { literal: '0', code: 400, forwarded: 0 },
  { literal: '0.0', code: 400, forwarded: 0 },
  { literal: '1.5', code: 0, forwarded: 1, total: 1 },
  { literal: '" 2 "', code: 0, forwarded: 1, total: 2 },
  { literal: '"\\u00a02"', code: 400, forwarded: 0 },
] as const;

describe('raw HTTP payment amount compatibility', () => {
  let app: INestApplication;
  let request: ReturnType<typeof supertest>;
  const file = { id: 1, user_id: 7, price: 250, unlocked: 0, key: 'synthetic-clip.mp4' };
  const user = { id: 7, openid: 'synthetic-payer', unionid: 'synthetic-union' };
  const db = {
    one: vi.fn(async () => file),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 1 })),
  };
  const order = vi.fn(async (_input: Row) => ({ synthetic: true }));
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    app = await createApplication({ db, auth: { bearer: async () => user }, integrations: { config: {}, order } } as unknown as Services);
    request = supertest(app.getHttpServer());
  });
  beforeEach(() => { db.one.mockClear(); db.execute.mockClear(); order.mockClear(); });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it.each(sourceV2)('v2 raw amount=$literal retains source status $status before any reservation', async ({ literal, status }) => {
    const raw = '{"out_trade_no":"codex_amount_01","file_id":1,"amount":' + literal + '}';
    const response = await request.post('/v2/wechat-pay/wxpay-order').set('Content-Type', 'application/json').send(raw).expect(status);
    if (status === 400) {
      expect(response.body).toMatchObject({ message: '文件金额已更新，请刷新后重试' });
      expect(db.execute).not.toHaveBeenCalled();
      expect(order).not.toHaveBeenCalled();
    } else {
      expect(response.body).toMatchObject({ code: 0 });
      expect(db.execute).toHaveBeenCalledOnce();
      expect(order).toHaveBeenCalledOnce();
      expect(order.mock.calls[0][0]).toMatchObject({ amount: 250, openid: user.openid });
    }
  });

  it.each(sourceV1)('v1 raw amount=$literal retains source forwarding and integer conversion', async ({ literal, code, forwarded, ...source }) => {
    const raw = '{"openid":"synthetic-payer","out_trade_no":"codex_amount_01","amount":' + literal + '}';
    const response = await request.post('/v1/wechat-pay/wxpay-order').set('Content-Type', 'application/json').send(raw).expect(200);
    expect(response.body.code).toBe(code);
    expect(order).toHaveBeenCalledTimes(forwarded);
    expect(db.execute).not.toHaveBeenCalled();
    if ('total' in source) expect(order.mock.calls[0][0].amount).toBe(source.total);
  });
});

describe('strict file cents versus recording SQL FLOAT cents', () => {
  it('rejects typed PHP floats in payment inputs while preserving whole recording prices', () => {
    const service = new MiniProgramFileService({} as any), user = { id: 7, openid: 'synthetic-payer' };
    const body = parsePhpJson('{"amount":250.0}');
    expect(() => service.prepareOrder({ id: 1, price: 250 }, user, body.amount, null, phpNumberType(body, 'amount'))).toThrow('文件金额已更新，请刷新后重试');
    const file = { id: 1, price: 250 }; setPhpNumberType(file, 'price', 'double');
    expect(() => service.prepareOrder(file, user)).toThrow('该历史文件尚未确认收费金额，请联系管理员');
    // Server::GetFile intentionally uses recordingPriceInCents, which accepts
    // the integer-valued FLOAT retrieved from setup.money.
    expect(priceInCents(250)).toBe(250);
    expect(priceInCents(250, 'double')).toBeNull();
  });
});
