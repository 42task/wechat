import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AuthService } from '../src/core/auth';
import { errorPayload } from '../src/core/errors';
import type { Context } from '../src/core/contracts';
import type { Database } from '../src/core/database';

const key = 'local-only-yii-business-token-test-key-at-least-32-bytes';
const nowMs = 1_800_000_000_123;
const now = nowMs / 1000;
const base = { uid: 1, identityDomain: 'v2-user', iss: 'https://jwt.reference.invalid', iat: now, nbf: now, exp: now + 3600 };

function signed(claims: Record<string, unknown> = base, secret = key): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function fixture() {
  const one = vi.fn(async () => ({ id: 1, role: 'user' }));
  const db = { one, query: vi.fn(async () => []), execute: vi.fn() } as unknown as Database;
  return { auth: new AuthService(db, { jwtKey: key, now: () => nowMs, devAuth: false }), one };
}

describe('Yii fractional NumericDate business tokens', () => {
  it('accepts fractional iat/nbf within the current millisecond without a one-second delay', async () => {
    const { auth } = fixture();
    const token = signed({ ...base, iat: 1_800_000_000.123456, nbf: 1_800_000_000.123456 });
    await expect(auth.verifyToken(token, 'v2-user')).resolves.toMatchObject({ id: 1 });
  });

  it('accepts an earlier fractional timestamp in the same second', async () => {
    const { auth } = fixture();
    await expect(auth.verifyToken(signed({ ...base, iat: 1_800_000_000.100001, nbf: 1_800_000_000.100001 }), 'v2-user')).resolves.toMatchObject({ id: 1 });
  });

  it.each([
    ['future iat in the next millisecond', { iat: (nowMs + 1) / 1000 }],
    ['future nbf in the next millisecond', { nbf: (nowMs + 1) / 1000 }],
    ['future nbf in the same second', { nbf: 1_800_000_000.9 }],
    ['expired in the same second', { exp: 1_800_000_000.12 }],
    ['expiry exactly now', { exp: now }],
    ['missing iat', { iat: undefined }],
    ['missing nbf', { nbf: undefined }],
    ['missing exp', { exp: undefined }],
    ['string iat', { iat: String(now) }],
    ['string nbf', { nbf: String(now) }],
    ['string exp', { exp: String(now + 3600) }],
    ['invalid temporal value', { nbf: null }],
    ['foreign identity domain', { identityDomain: 'v1-player' }],
    ['fractional uid', { uid: 1.5 }],
  ])('rejects %s before looking up an identity', async (_name, patch) => {
    const { auth, one } = fixture();
    await expect(auth.verifyToken(signed({ ...base, ...patch }), 'v2-user')).rejects.toMatchObject({ status: 401 });
    expect(one).not.toHaveBeenCalled();
  });

  it('rejects a tampered signature without relaxing the algorithm or identity boundary', async () => {
    const { auth, one } = fixture();
    await expect(auth.verifyToken(signed(base, 'different-local-test-key-at-least-32-bytes'), 'v2-user')).rejects.toMatchObject({ status: 401 });
    expect(one).not.toHaveBeenCalled();
  });

  const sourceRoot = resolve(process.env.YII_SOURCE_ROOT || '../game/api');
  const yiiApi = existsSync(resolve(sourceRoot, 'api/vendor/autoload.php')) ? resolve(sourceRoot, 'api') : sourceRoot;
  const phpAvailable = existsSync(resolve(yiiApi, 'vendor/autoload.php')) && spawnSync('php', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!phpAvailable)('immediately accepts real Yii v1/v2 User.generateAccessToken microsecond signatures with a frozen Node clock', async () => {
    // Only the id attribute is needed by the original signing method. Override
    // attributes() to avoid schema lookup: this reference check needs no DB.
    const php = String.raw`
require $argv[1] . '/vendor/autoload.php';
require $argv[1] . '/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $argv[1]);
new yii\console\Application([
  'id'=>'jwt-time-reference','basePath'=>$argv[1],
  'components'=>[
    'request'=>['class'=>yii\web\Request::class,'hostInfo'=>'https://jwt.reference.invalid'],
    'jwt'=>['class'=>bizley\jwt\Jwt::class,'signer'=>bizley\jwt\Jwt::HS256,
      'signingKey'=>['key'=>$argv[2],'method'=>bizley\jwt\Jwt::METHOD_PLAIN]],
  ],
]);
$v1 = new class extends app\modules\v1\models\User { public function attributes() { return ['id']; } };
$v2 = new class extends app\modules\v2\models\User { public function attributes() { return ['id']; } };
$stamp = DateTimeImmutable::createFromFormat('U.u', '1800000000.123456');
$result=[];
foreach (['v1-player'=>$v1,'v2-user'=>$v2] as $domain=>$user) {
  $user->id=1;
  $result[$domain]=$user->generateAccessToken($stamp,$stamp->modify('+1 hour'));
}
echo json_encode($result,JSON_THROW_ON_ERROR);
`;
    const output = spawnSync('php', ['-r', php, yiiApi, key], { encoding: 'utf8' });
    expect(output.status, output.stderr).toBe(0);
    const tokens = JSON.parse(output.stdout) as Record<'v1-player' | 'v2-user', string>;
    const { auth } = fixture();
    for (const domain of ['v1-player', 'v2-user'] as const) {
      const claims = JSON.parse(Buffer.from(tokens[domain].split('.')[1], 'base64url').toString());
      expect(claims.iat).toBe(1_800_000_000.123456);
      expect(claims.nbf).toBe(claims.iat);
      await expect(auth.verifyToken(tokens[domain], domain)).resolves.toMatchObject({ id: 1 });
      await expect(auth.verifyToken(tokens[domain], domain === 'v1-player' ? 'v2-user' : 'v1-player')).rejects.toMatchObject({ status: 401 });
    }
  });
});

describe('Yii CompositeAuth cache headers after successful business Bearer authentication', () => {
  function context(path: string, authorization?: string) {
    const headers: Record<string, string> = {};
    return { headers, ctx: { req: { path, headers: { authorization } }, res: { setHeader: (name: string, value: string) => { headers[name] = value; } } } as unknown as Context };
  }

  it.each(['/v2/files', '/v2/files/list', '/v2/files/1', '/v2/applet/refresh', '/v2/wechat/profile', '/v2/wechat/phone', '/v2/wechat/bind-phone', '/v2/wechat-pay/wxpay-order', '/v2/%66iles/1'])('retains the original private response cache policy on %s', async path => {
    const { auth } = fixture();
    const { ctx, headers } = context(path, `Bearer ${signed()}`);
    await auth.bearer(ctx, 'v2-user');
    expect(headers).toEqual({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Expires: 'Thu, 19 Nov 1981 08:52:00 GMT', Pragma: 'no-cache' });
  });

  it.each(['/v2/devices', '/v2/setups/1', '/v2/root/assign', '/v2/web-login/tickets/test/approve'])('keeps the stateless DeviceBearerAuth response unchanged on %s', async path => {
    const { auth } = fixture();
    const { ctx, headers } = context(path, `Bearer ${signed()}`);
    await auth.bearer(ctx, 'v2-user');
    expect(headers).toEqual({});
  });

  it.each([undefined, 'Bearer invalid'])('does not add successful-session cache headers for rejected credentials: %s', async authorization => {
    const { auth } = fixture();
    const { ctx, headers } = context('/v2/files/list', authorization);
    await expect(auth.bearer(ctx, 'v2-user')).rejects.toMatchObject({ status: 401 });
    expect(headers).toEqual({ 'WWW-Authenticate': 'Bearer realm="api"' });
  });
});

describe('Yii production device signature validation order', () => {
  const token = `T${'a'.repeat(32)}`;
  const ctx = (body: Record<string, unknown>, query: Record<string, unknown> = {}) => ({ body, query }) as unknown as Context;

  it.each([
    [{}, {}, 'token is required'],
    [{ token: '0' }, {}, 'token is required'],
    [{ token }, {}, 'time and hash are required'],
    [{ token, uuid: 'fixture' }, { time: '0', hash: 'invalid' }, 'time and hash are required'],
    [{ token: 'invalid' }, { time: '1', hash: 'invalid' }, 'token format error'],
    [{ token }, { time: '1', hash: 'invalid' }, 'Exactly one of uuid, id, or key must be provided'],
    [{ token, uuid: [] }, { time: '1', hash: 'invalid' }, 'Exactly one of uuid, id, or key must be provided'],
    [{ token, uuid: 'fixture' }, { time: '1', hash: 'invalid' }, 'hash error'],
  ])('matches source validation ordering and generic HttpException', (body, query, message) => {
    const { auth } = fixture();
    try { auth.requireDevice(ctx(body, query)); throw Error('Expected rejection'); }
    catch (error) { expect(errorPayload(error)).toMatchObject({ status: 400, body: { message, type: 'yii\\web\\HttpException' } }); }
  });

  it('accepts a correct production signature and preserves the development bypass ordering', () => {
    const { auth } = fixture();
    const hash = createHash('md5').update(`${token}1fixturebuj1aban.c0m`).digest('hex');
    expect(() => auth.requireDevice(ctx({ token, uuid: 'fixture' }, { time: '1', hash }))).not.toThrow();
    const dev = new AuthService({} as Database, { devAuth: true });
    expect(() => dev.requireDevice(ctx({ token: 'development-token', uuid: 'fixture' }))).not.toThrow();
    expect(() => dev.requireDevice(ctx({ token: 'development-token' }))).toThrow('Exactly one of uuid, id, or key must be provided');
  });
});
