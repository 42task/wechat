import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/application';
import type { Row, Services } from '../src/core/contracts';
import { Integrations } from '../src/integrations/integrations';

// Published synthetic fixture keys; these never authenticate to a real service.
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/wechat-platform-test-keys.json'), 'utf8'));
const [platform, merchant] = fixture.platforms;
const platformPublicKey = createPublicKey(platform.privateKey).export({ type: 'spki', format: 'pem' }).toString();
const serial = 'PUB_KEY_ID_PROVIDER_PARITY', now = 1800000000, apiV3Key = '0123456789abcdef0123456789abcdef';
const config = { appId: 'wx-test', mchId: 'merchant', serialNo: 'fixture', privateKey: merchant.privateKey, platformKeys: { [serial]: platformPublicKey }, apiV3Key, now: () => now };
function signedHeaders(raw: string) {
  return { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': String(now), 'Wechatpay-Nonce': 'fixture', 'Wechatpay-Serial': serial,
    'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${now}\nfixture\n${raw}\n`), platform.privateKey).toString('base64') };
}
function orderRaw(field?: string): string {
  let attach = '{"v":1,"file_id":1,"user_id":7,"amount":100}';
  if (field?.startsWith('attach.')) {
    const name = field.slice(7), value = name === 'v' || name === 'file_id' ? 1 : name === 'user_id' ? 7 : 100;
    attach = attach.replace(`"${name}":${value}`, `"${name}":${value}.0`);
  }
  return '{"out_trade_no":"order01","appid":"wx-test","mchid":"merchant","trade_state":"SUCCESS","amount":{"total":' +
    (field === 'amount.total' ? '100.0' : '100') + ',"currency":"CNY"},"payer":{"openid":"payer"},"attach":' + JSON.stringify(attach) + '}';
}
function refundRaw(missing?: string, explicitNull = false): string {
  const resource: Row = { out_refund_no: 'refund01', refund_status: 'SUCCESS' };
  if (missing) { if (explicitNull) resource[missing] = null; else delete resource[missing]; }
  const nonce = '0123456789ab', cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from('refund'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  return JSON.stringify({ event_type: 'REFUND.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: 'refund', ciphertext } });
}

describe('signed payment strict PHP types and refund retry HTTP contract', () => {
  let app: INestApplication, request: ReturnType<typeof supertest>;
  let providerRaw = orderRaw(), providerStatus = 200;
  const db = {
    one: vi.fn(async (sql: string) => sql.includes('file_payment_order') ? { user_id: 7, file_id: 1, amount: 100 } : { id: 1, user_id: 7, price: 100, key: 'synthetic.mp4' }),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
  };
  const fetcher = vi.fn(async () => new Response(providerRaw, { status: providerStatus, headers: signedHeaders(providerRaw) }));
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const api = new Integrations({ ...config, fetch: fetcher });
    app = await createApplication({ db, auth: { bearer: async () => ({ id: 7, openid: 'payer', unionid: 'union' }) }, integrations: api } as unknown as Services);
    request = supertest(app.getHttpServer());
  });
  beforeEach(() => { providerRaw = orderRaw(); providerStatus = 200; db.one.mockClear(); db.execute.mockClear(); fetcher.mockClear(); });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it.each(['amount.total', 'attach.v', 'attach.file_id', 'attach.user_id', 'attach.amount'])('rejects signed raw %s PHP double before unlocking', async field => {
    providerRaw = orderRaw(field);
    const response = await request.get('/v2/wechat-pay/wxpay-query-order-by-out-trade-no?out_trade_no=order01').expect(403);
    expect(response.body.message).toBe(field === 'amount.total' ? '订单金额、收款方或付款账号校验失败' : '订单不属于当前文件账号');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it('unlocks the same signed order with integer JSON lexemes', async () => {
    const response = await request.get('/v2/wechat-pay/wxpay-query-order-by-out-trade-no?out_trade_no=order01').expect(200);
    expect(response.body).toMatchObject({ code: 0, data: { unlocked: true } });
    expect(db.execute).toHaveBeenCalledExactlyOnceWith('UPDATE file SET unlocked=1 WHERE id=?', [1]);
  });
  it.each(['v1', 'v2'])('%s refunds retry missing keys and accept explicitly present null keys', async version => {
    for (const field of ['out_refund_no', 'refund_status']) {
      const missing = refundRaw(field);
      const response = await request.post(`/${version}/wechat-pay/refund-notify`).set(signedHeaders(missing)).send(missing).expect(500);
      expect(response.body).toEqual({ code: 'ERROR', message: `Undefined array key "${field}"` });
      const withNull = refundRaw(field, true);
      const accepted = await request.post(`/${version}/wechat-pay/refund-notify`).set(signedHeaders(withNull)).send(withNull).expect(200);
      expect(accepted.body).toEqual({ code: 'SUCCESS', message: '成功' });
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(db.one).not.toHaveBeenCalled(); expect(db.execute).not.toHaveBeenCalled();
  });
  it.each(['{}', '[]', '[{"total":100}]'])('retains signed SDK PHP array decoding for %s', async raw => {
    const api = new Integrations({ ...config, fetch: async () => new Response(raw, { headers: signedHeaders(raw) }) });
    expect(await api.payment('GET', '/v3/test')).toEqual(raw === '{}' ? [] : JSON.parse(raw));
  });
  for (const version of ['v1', 'v2']) it.each([
    ['POST', 'wxpay-order', '支付下单失败', { file_id: 1, openid: 'payer', out_trade_no: 'order01', amount: 100 }],
    ['POST', 'wxpay-refund', '申请退款失败', { out_trade_no: 'order01', out_refund_no: 'refund01', refund_amount: 50, total_amount: 100 }],
    ['GET', 'wxpay-query-refund?out_refund_no=refund01', '查询退款失败', {}],
    ['GET', 'wxpay-query-order-by-transaction-id?transaction_id=' + '1'.repeat(28), '查询订单失败', {}],
    ['GET', 'wxpay-query-order-by-out-trade-no?out_trade_no=order01', '查询订单失败', {}],
  ] as const)(`${version} %s %s preserves the source public SDK failure`, async (method, action, prefix, body) => {
    providerStatus = 400;
    const pending = method === 'POST' ? request.post(`/${version}/wechat-pay/${action}`).send(body) : request.get(`/${version}/wechat-pay/${action}`);
    const response = await pending.expect(200);
    expect(response.body).toEqual({ code: 500, message: `${prefix}: WeChat Pay API request failed.` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.execute).toHaveBeenCalledTimes(action === 'wxpay-order' && version === 'v2' ? 1 : 0);
  });
});

const sourceRoot = resolve(process.env.YII2_SOURCE_ROOT || resolve(__dirname, '../../game'));
describe.skipIf(!existsSync(resolve(sourceRoot, 'api/vendor/yiisoft/yii2/Yii.php')))('offline original Yii payment type oracle', () => {
  it('executes original confirmPayment strict comparisons with only database command recording replaced', () => {
    const code = String.raw`
require $argv[1].'/api/vendor/autoload.php'; require $argv[1].'/api/vendor/yiisoft/yii2/Yii.php'; Yii::setAlias('@app',$argv[1].'/api');
class OracleUser extends app\modules\v2\models\User {public function attributes(){return ['id','openid','unionid'];}}
class OracleFile extends app\modules\v2\models\File {public function attributes(){return ['id','price','user_id','key'];}}
class OracleDb extends yii\db\Connection {public $writes=0;public function createCommand($sql=null,$params=[]){return new class(['db'=>$this]) extends yii\db\Command {public function update($table,$columns,$condition='',$params=[]){return $this;}public function execute(){$this->db->writes++;return 1;}};}}
class OracleService extends app\components\MiniProgramFileService {
public function assertOrderOwner(string $id,app\modules\v2\models\User $u):array{return ['file_id'=>1,'user_id'=>7,'amount'=>100];}
public function findOwned($id,app\modules\v2\models\User $u):app\modules\v2\models\File{$f=new OracleFile();$f->setAttributes(['id'=>1,'price'=>100,'user_id'=>7,'key'=>'synthetic.mp4'],false);return $f;}}
$app=new yii\console\Application(['id'=>'offline-payment-types','basePath'=>$argv[1].'/api','components'=>['db'=>new OracleDb()]]);
$u=new OracleUser();$u->setAttributes(['id'=>7,'openid'=>'payer','unionid'=>'union'],false);$results=[];
foreach(json_decode(stream_get_contents(STDIN),true) as $raw){$app->db->writes=0;try{$ok=(new OracleService())->confirmPayment(json_decode($raw,true),$u,'wx-test','merchant');$row=['status'=>200,'confirmed'=>$ok];}catch(Throwable $e){$row=['status'=>$e instanceof yii\web\HttpException?$e->statusCode:500,'message'=>$e->getMessage()];}$row['writes']=$app->db->writes;$results[]=$row;}
echo json_encode($results,JSON_THROW_ON_ERROR);`;
    const fields = ['amount.total', 'attach.v', 'attach.file_id', 'attach.user_id', 'attach.amount'];
    const result = spawnSync('php', ['-r', code, sourceRoot], { input: JSON.stringify([orderRaw(), ...fields.map(orderRaw)]), encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ status: 200, confirmed: true, writes: 1 }, ...fields.map(field => ({ status: 403, message: field === 'amount.total' ? '订单金额、收款方或付款账号校验失败' : '订单不属于当前文件账号', writes: 0 }))]);
  });
});
