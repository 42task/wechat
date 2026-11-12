import { HttpException } from '@nestjs/common';
import { createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import type { Row } from '../core/contracts';
import { phpInt } from '../core/php';

/** Actual provider transports. No endpoint forwards to the retired PHP service. */
export interface IntegrationOptions {
  appId?: string; appSecret?: string; mchId?: string; serialNo?: string; privateKey?: string;
  apiV3Key?: string; platformKeys?: Record<string, string>; platformKeyId?: string; notifyUrl?: string; refundNotifyUrl?: string;
  secretId?: string; secretKey?: string; bucket?: string; region?: string;
  fetch?: typeof fetch; now?: () => number; nonce?: () => string;
  onPaymentNotification?: (notice: Row) => Promise<void>;
}

function pem(value: string | undefined, path: string | undefined): string | undefined {
  if (value) return value.replace(/\\n/g, '\n');
  if (!path) return undefined;
  // EasyWeChat accepts either a PEM value or a file path in the legacy variables.
  return path.trimStart().startsWith('-----BEGIN ') ? path.replace(/\\n/g, '\n') : readFileSync(path, 'utf8');
}
interface EnvironmentOptions extends IntegrationOptions { paymentConfigurationError?: string; paymentApplicationError?: string; legacyPrimaryConfigured?: boolean }
function environment(): EnvironmentOptions {
  const env = process.env;
  let keys: Record<string, string> = {};
  const publicKeyId = env.WECHAT_PAY_PLATFORM_SERIAL_NO || env.WECHAT_PUB_KEY_ID;
  let paymentConfigurationError: string | undefined;
  let paymentApplicationError: string | undefined;
  const legacyPrimaryConfigured = !!env.WECHAT_PUB_KEY_ID && !!env.WECHAT_PUB_KEY;
  const applicationError = (message: string): never => { paymentApplicationError = message; throw Error(message); };
  let serialNo: string | undefined;
  let privateKey: string | undefined;
  try {
    const parsed: unknown = env.WECHAT_PAY_PLATFORM_KEYS_JSON ? JSON.parse(env.WECHAT_PAY_PLATFORM_KEYS_JSON) : {};
    if (!record(parsed)) throw Error();
    keys = parsed;
    const modernKey = env.WECHAT_PAY_PLATFORM_PUBLIC_KEY || env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH;
    const modernConfigured = !!modernKey || Object.keys(keys).length > 0;
    if (modernKey) {
      const key = pem(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY, env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH);
      if (!key || !publicKeyId) throw Error();
      createPublicKey(key);
      keys[publicKeyId] = key;
    } else if (publicKeyId && !keys[publicKeyId] && env.WECHAT_PUB_KEY) {
      const key = pem(undefined, env.WECHAT_PUB_KEY)!;
      createPublicKey(key);
      keys[publicKeyId] = key;
    } else if (!modernConfigured && (env.WECHAT_PUB_KEY_ID || env.WECHAT_PUB_KEY || env.WECHAT_PLATFORM_CERTS)) {
      throw Error();
    }
    // Parse every configured legacy certificate, even if a modern map overrides
    // its serial. A damaged rotation entry must never be silently discarded.
    let paths: unknown = [];
    try { paths = env.WECHAT_PLATFORM_CERTS ? JSON.parse(env.WECHAT_PLATFORM_CERTS) : []; }
    catch { applicationError('WECHAT_PLATFORM_CERTS must be a JSON array of certificate paths.'); }
    if (!Array.isArray(paths)) applicationError('WECHAT_PLATFORM_CERTS must be a list of certificate paths.');
    const references = new Map<string, string>();
    if (env.WECHAT_PUB_KEY_ID && env.WECHAT_PUB_KEY) references.set(env.WECHAT_PUB_KEY_ID, env.WECHAT_PUB_KEY);
    for (const path of paths as unknown[]) {
      let contents: string;
      try {
        if (typeof path !== 'string' || !path || !statSync(path).isFile()) throw Error();
        contents = readFileSync(path, 'utf8');
      } catch { applicationError('A WeChat Pay platform certificate file is not readable.'); }
      let serial: string;
      try { serial = new X509Certificate(contents!).serialNumber.toUpperCase(); }
      catch { applicationError('An additional WeChat Pay platform certificate is not a valid X509 certificate.'); }
      if (!serial! || (references.has(serial!) && references.get(serial!) !== path)) applicationError('Duplicate WeChat Pay verification key ID.');
      references.set(serial!, path as string);
      if (!keys[serial!]) keys[serial!] = contents!;
    }
    serialNo = env.WECHAT_PAY_SERIAL_NO || (env.WECHAT_CERTIFICATE ? new X509Certificate(pem(undefined, env.WECHAT_CERTIFICATE)!).serialNumber : undefined);
    privateKey = pem(env.WECHAT_PAY_PRIVATE_KEY, env.WECHAT_PAY_PRIVATE_KEY_PATH || env.WECHAT_PRIVATE_KEY);
  } catch {
    // Yii creates its payment application lazily. Any unreadable merchant or
    // platform material must remain isolated from login, cloud and health APIs.
    paymentConfigurationError = '微信支付验证配置无效';
  }
  return {
    appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET || env.WECHAT_SECRET,
    mchId: env.WECHAT_PAY_MCH_ID || env.WECHAT_MCH_ID, serialNo,
    privateKey,
    apiV3Key: env.WECHAT_PAY_API_V3_KEY || env.WECHAT_SECRET_KEY, platformKeys: keys, platformKeyId: publicKeyId,
    paymentConfigurationError, paymentApplicationError, legacyPrimaryConfigured,
    notifyUrl: env.WECHAT_PAY_NOTIFY_URL,
    refundNotifyUrl: env.WECHAT_PAY_REFUND_NOTIFY_URL,
    secretId: env.TENCENT_SECRET_ID || env.SECRET_ID, secretKey: env.TENCENT_SECRET_KEY || env.SECRET_KEY,
    bucket: env.COS_BUCKET || env.COS_BUCKETS_BUCKET, region: env.COS_REGION || env.COS_BUCKETS_REGION,
  };
}
function failure(status: number, message: string, yiiType = 'HttpException'): never { throw Object.assign(new HttpException(message, status), { yiiType }); }
function originalException(message: string, type: string, name = 'Exception', code = 0): never {
  throw Object.assign(new HttpException(message, 500), { responseBody: { name, message, code, type } });
}
function phpJson(value: unknown): string {
  const arrays = (item: any): any => Array.isArray(item) ? item.map(arrays) : record(item) ? Object.keys(item).length ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, arrays(child)])) : [] : item;
  return JSON.stringify(arrays(value)).replace(/\//g, '\\/');
}
function record(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function enc(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac256 = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const hmac1 = (key: string, value: string) => createHmac('sha1', key).update(value).digest('hex');

export class Integrations {
  readonly config: IntegrationOptions;
  private readonly fetcher: typeof fetch;
  readonly now: () => number;
  private readonly nonce: () => string;
  private readonly paymentConfigurationError?: string;
  private readonly paymentApplicationError?: string;
  private readonly legacyPrimaryConfigured: boolean;
  private accessToken?: { value: string; expires: number };
  private accessTokenRequest?: Promise<string>;

  constructor(options: IntegrationOptions = {}) {
    const { paymentConfigurationError, paymentApplicationError, legacyPrimaryConfigured, ...config } = environment();
    this.config = { ...config, ...options };
    let configurationError = paymentConfigurationError;
    try {
      if (this.config.privateKey) createPrivateKey(this.config.privateKey);
      for (const key of Object.values(this.config.platformKeys || {})) createPublicKey(key);
    } catch { configurationError ??= '微信支付验证配置无效'; }
    this.paymentConfigurationError = configurationError;
    this.paymentApplicationError = paymentApplicationError;
    this.legacyPrimaryConfigured = legacyPrimaryConfigured === true;
    this.fetcher = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.nonce = options.nonce || (() => randomBytes(16).toString('hex'));
  }

  private required(...names: (keyof IntegrationOptions)[]): void {
    if (names.some(name => !this.config[name])) failure(503, '外部服务配置不完整');
  }
  private requirePaymentVerification(): void {
    if (this.paymentConfigurationError) failure(503, this.paymentConfigurationError);
    if (!Object.keys(this.config.platformKeys || {}).length) failure(503, '微信支付验证配置不完整');
  }
  /** Match the original payApp() initialization boundary for info/callback actions. */
  assertPaymentApplication(): void {
    const message = !this.legacyPrimaryConfigured && !Object.keys(this.config.platformKeys || {}).length
      ? 'WeChat Pay verification key ID and path are required.' : this.paymentApplicationError;
    if (message) originalException(message, 'yii\\base\\InvalidConfigException', 'Invalid Configuration');
  }
  private async transport(url: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { return failure(503, '外部服务暂时不可用'); }
  }
  private async wechat(path: string, data?: Row, allowProviderError = false): Promise<Row> {
    const response = await this.transport(`https://api.weixin.qq.com${path}`, data ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    } : {});
    let result: unknown;
    try { result = await response.json(); } catch { return failure(502, '微信服务返回格式无效'); }
    if (!response.ok || !record(result) || (!allowProviderError && result.errcode !== undefined && Number(result.errcode) !== 0)) return failure(400, '微信服务请求失败，请重新授权');
    return result;
  }

  async codeSession(code: string): Promise<Row> {
    if (typeof code !== 'string' || !code || Buffer.byteLength(code) > 1024) return failure(400, 'code is required');
    this.required('appId', 'appSecret');
    const query = new URLSearchParams({ appid: this.config.appId!, secret: this.config.appSecret!, js_code: code, grant_type: 'authorization_code' });
    const response = await this.transport(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
    let result: unknown;
    try { result = await response.json(); } catch { return failure(502, '微信服务返回格式无效'); }
    const openid = record(result) ? result.openid : undefined;
    if (openid === undefined || openid === null || openid === false || openid === 0 || openid === '' || openid === '0' || typeof openid === 'object' && Object.keys(openid).length === 0) {
      return originalException(`code2Session error: ${phpJson(result)}`, 'EasyWeChat\\Kernel\\Exceptions\\HttpException');
    }
    return result as Row;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > this.now() + 60) return this.accessToken.value;
    if (!this.accessTokenRequest) {
      this.accessTokenRequest = (async () => {
        this.required('appId', 'appSecret');
        const result = await this.wechat('/cgi-bin/stable_token', { grant_type: 'client_credential', appid: this.config.appId, secret: this.config.appSecret, force_refresh: false });
        if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in))) return failure(502, '微信访问凭证无效');
        this.accessToken = { value: result.access_token, expires: this.now() + Number(result.expires_in) };
        return this.accessToken.value;
      })().finally(() => { this.accessTokenRequest = undefined; });
    }
    return this.accessTokenRequest;
  }

  async phone(code: string): Promise<Row> {
    if (typeof code !== 'string' || !code || code.length > 1024) return failure(400, 'code parameter is required');
    const token = await this.token();
    const result = await this.wechat(`/wxa/business/getuserphonenumber?access_token=${enc(token)}`, { code }, true);
    if (result.errcode !== undefined && Number(result.errcode) !== 0) return failure(400, `getuserphonenumber failed: ${result.errmsg ?? 'unknown'}`);
    return record(result.phone_info) ? result.phone_info : {};
  }

  /** APIv3 signatures always cover raw bytes, including trailing newlines. */
  private verifyPayment(raw: string, headers: Headers | Record<string, unknown>): void {
    const get = (name: string): string => headers instanceof Headers ? headers.get(name) || '' : String(headers[name] || headers[name.toLowerCase()] || Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || '');
    const has = (name: string): boolean => headers instanceof Headers ? headers.has(name) : Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());
    const invalid = (message: string): never => originalException(message, 'EasyWeChat\\Pay\\Exceptions\\InvalidSignatureException');
    for (const name of ['Wechatpay-Signature', 'Wechatpay-Timestamp', 'Wechatpay-Serial', 'Wechatpay-Nonce']) if (!has(name)) invalid(`Missing Header: ${name}`);
    const timestamp = get('wechatpay-timestamp');
    const nonce = get('wechatpay-nonce');
    const serial = get('wechatpay-serial');
    const signature = get('wechatpay-signature');
    const key = this.config.platformKeys?.[serial];
    if (this.now() - phpInt(timestamp) > 300) invalid('Clock Offset Exceeded');
    if (!key) originalException(`No platform certs found for serial: ${serial}, \n                please download from wechat pay and set it in merchant config with key \`certs\`.`, 'EasyWeChat\\Kernel\\Exceptions\\InvalidConfigException');
    let valid = false;
    try { valid = verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), key, Buffer.from(signature, 'base64')); }
    catch { /* The source reports all invalid signature bytes with one SDK error. */ }
    if (!valid) invalid('Invalid Signature');
  }

  async payment(method: string, path: string, data?: Row): Promise<Row> {
    this.requirePaymentVerification();
    this.required('mchId', 'serialNo', 'privateKey');
    if (!path.startsWith('/v3/')) return failure(400, '支付请求路径无效');
    const body = data === undefined ? '' : JSON.stringify(data);
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.config.privateKey!).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`;
    const platformKeyId = this.config.platformKeyId || Object.keys(this.config.platformKeys || {}).find(id => id.startsWith('PUB_KEY_ID_'));
    const response = await this.transport(`https://api.mch.weixin.qq.com${path}`, { method, headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN', 'Content-Type': 'application/json', Authorization: authorization, ...(platformKeyId ? { 'Wechatpay-Serial': platformKeyId } : {}) }, ...(body ? { body } : {}) });
    if (!response.ok) originalException('WeChat Pay API request failed.', 'EasyWeChat\\Kernel\\Exceptions\\BadResponseException', 'Exception', response.status);
    const raw = await response.text();
    this.verifyPayment(raw, response.headers);
    let result: unknown;
    try { result = raw ? JSON.parse(raw) : {}; } catch { return failure(502, '微信支付响应格式无效'); }
    if (!record(result)) return failure(502, '微信支付响应格式无效');
    return result;
  }

  async order(input: Row, fallbackNotifyUrl?: string): Promise<Row> {
    this.required('appId');
    const notifyUrl = this.config.notifyUrl || fallbackNotifyUrl;
    if (!notifyUrl) return failure(503, '外部服务配置不完整');
    const result = await this.payment('POST', '/v3/pay/transactions/jsapi', {
      appid: this.config.appId, mchid: this.config.mchId, description: input.description === undefined ? '商品支付' : input.description,
      out_trade_no: input.out_trade_no, notify_url: notifyUrl,
      ...(typeof input.attach === 'string' ? { attach: input.attach } : {}),
      amount: { total: Number(input.amount), currency: 'CNY' }, payer: { openid: input.openid },
    });
    if (typeof result.prepay_id !== 'string' || !result.prepay_id) return failure(502, '获取prepay_id失败');
    const timeStamp = String(this.now()), nonceStr = this.nonce(), packageValue = `prepay_id=${result.prepay_id}`;
    const paySign = sign('RSA-SHA256', Buffer.from(`${this.config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`), this.config.privateKey!).toString('base64');
    return { appId: this.config.appId, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }

  async notification(raw: string | Buffer, headers: Headers | Record<string, unknown>): Promise<Row> {
    this.requirePaymentVerification();
    this.required('apiV3Key', 'mchId');
    const text = raw.toString();
    this.verifyPayment(text, headers);
    const contentType = headers instanceof Headers ? headers.get('content-type') || '' : String(Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '');
    if ((contentType.includes('text/xml') || contentType.includes('application/xml')) && text.startsWith('<xml')) {
      // The source SDK decodes XML, but its payment handler reads event_type
      // from the original body as JSON and returns this server failure. Preserve
      // that failed callback contract after authentication; never acknowledge it.
      throw Object.assign(new HttpException({ code: 'ERROR', message: 'Undefined array key "event_type"' }, 500), { legacyCallbackResponse: true });
    }
    let notice: Row;
    try { notice = JSON.parse(text); } catch { return originalException('Invalid request body.', 'RuntimeException'); }
    if (!record(notice)) return originalException('Invalid request body.', 'RuntimeException');
    const resource = notice.resource;
    if (!record(resource) || resource.algorithm !== 'AEAD_AES_256_GCM' || typeof resource.ciphertext !== 'string' || typeof resource.nonce !== 'string') return failure(400, '微信支付通知加密格式无效');
    try {
      const ciphertext = Buffer.from(resource.ciphertext, 'base64');
      if (ciphertext.length <= 16 || Buffer.byteLength(this.config.apiV3Key!) !== 32) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.apiV3Key!), Buffer.from(resource.nonce));
      decipher.setAuthTag(ciphertext.subarray(-16));
      decipher.setAAD(Buffer.from(resource.associated_data || ''));
      const decrypted = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString());
      if (!record(decrypted)) throw Error();
      // Source callbacks decrypt and dispatch this metadata without an extra
      // merchant/AppID gate. Active v2 payments authorize only from a fresh,
      // signed provider order and its immutable local file/account binding.
      return { ...notice, resource: decrypted };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return failure(400, '微信支付通知解密失败');
    }
  }

  cloud(): Row {
    return { bucket: this.config.bucket ?? false, region: this.config.region ?? false };
  }

  async federationToken(bucket = this.config.bucket, region = this.config.region): Promise<Row> {
    this.required('secretId', 'secretKey');
    // v1 actionToken accepts caller storage; v2/store pass configured storage.
    // Preserve PHP substr/strripos even for malformed names: the provider, not
    // this migration, decides which original policies can be issued.
    const bucketName = String(bucket ?? ''), location = String(region ?? '');
    const lastDash = bucketName.lastIndexOf('-');
    const shortBucket = bucketName.slice(0, lastDash < 0 ? 0 : lastDash);
    const appId = bucketName.slice(lastDash < 0 ? 1 : lastDash + 1);
    const policy = { version: '2.0', statement: [{ action: ['name/cos:PutObject', 'name/cos:PostObject', 'name/cos:HeadObject', 'name/cos:GetObject', 'name/cos:InitiateMultipartUpload', 'name/cos:ListMultipartUploads', 'name/cos:ListParts', 'name/cos:UploadPart', 'name/cos:CompleteMultipartUpload', 'name/cos:GenerateSignURL', 'name/cos:GetObjectUrl'], effect: 'allow', principal: { qcs: ['*'] }, resource: [`qcs::cos:${location}:uid/${appId}:prefix//${appId}/${shortBucket}/*`] }] };
    // The original request leaves DurationSeconds null; the SDK omits it.
    const body = JSON.stringify({ Name: 'mrpp', Policy: enc(JSON.stringify(policy)).replace(/%20/g, '+') });
    const timestamp = this.now(), date = new Date(timestamp * 1000).toISOString().slice(0, 10), host = 'sts.tencentcloudapi.com';
    const canonical = `POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${sha256(body)}`;
    const scope = `${date}/sts/tc3_request`;
    const secretDate = hmac256(`TC3${this.config.secretKey}`, date);
    const signature = hmac256(hmac256(hmac256(secretDate, 'sts'), 'tc3_request'), `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`).toString('hex');
    const response = await this.transport(`https://${host}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: host, 'X-TC-Action': 'GetFederationToken', 'X-TC-Version': '2018-08-13', ...(location && location !== '0' ? { 'X-TC-Region': location } : {}), 'X-TC-Timestamp': String(timestamp), Authorization: `TC3-HMAC-SHA256 Credential=${this.config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}` }, body });
    const raw = await response.text();
    if (!response.ok) {
      let message = raw;
      if (response.status >= 400 && response.status < 600) {
        const prefix = response.status < 500 ? 'Client error' : 'Server error';
        message = `${prefix}: \`POST https://${host}/\` resulted in a \`${response.status} ${response.statusText || STATUS_CODES[response.status] || ''}\` response`;
        const bytes = Buffer.from(raw);
        let summary: string | undefined;
        try {
          const text = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, 120));
          if (text && !/[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Z}\n\r\t]/u.test(text)) summary = text + (bytes.length > 120 ? ' (truncated...)' : '');
        } catch { /* Guzzle omits non-printable or truncated invalid UTF-8. */ }
        if (summary !== undefined) message += `:\n${summary}\n`;
      }
      originalException(message, 'TencentCloud\\Common\\Exception\\TencentCloudSDKException');
    }
    let result: Row;
    try { result = JSON.parse(raw).Response; } catch { return failure(502, '腾讯云响应格式无效'); }
    if (record(result) && record(result.Error)) originalException(String(result.Error.Message ?? ''), 'TencentCloud\\Common\\Exception\\TencentCloudSDKException');
    if (!record(result)) return failure(502, '腾讯云临时凭证请求失败');
    return { Credentials: result.Credentials ?? null, ExpiredTime: result.ExpiredTime ?? null, Expiration: result.Expiration ?? null, RequestId: result.RequestId ?? null };
  }

  async store(): Promise<Row> {
    const result = await this.federationToken();
    return { message: 'success', success: true, data: { ...this.cloud(), token: result.Credentials.Token, tmpSecretId: result.Credentials.TmpSecretId, tmpSecretKey: result.Credentials.TmpSecretKey, startTime: this.now(), expiredTime: result.ExpiredTime, expiration: result.Expiration ?? null, requestId: result.RequestId } };
  }

  async objectUrl(key: string, query: Row = {}, expiresAt?: number): Promise<string> {
    return this.signedObjectUrl(key, query, {}, expiresAt);
  }

  private async signedObjectUrl(key: string, query: Row = {}, extraHeaders: Record<string, string> = {}, expiresAt?: number): Promise<string> {
    this.required('secretId', 'secretKey', 'bucket', 'region');
    if (typeof key !== 'string' || !key || key.length > 1024 || key.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f\\]/.test(key)) return failure(400, 'key is invalid');
    const expires = query.expires === undefined ? 900 : Number(query.expires);
    const method = String(query.method || 'GET').toUpperCase();
    if (!Number.isInteger(expires) || expires < 1 || expires > 86400) return failure(400, 'expires must be between 1 and 86400');
    if (!['GET', 'HEAD', 'PUT'].includes(method)) return failure(400, 'method must be GET, HEAD or PUT');
    let secretId = this.config.secretId!, secretKey = this.config.secretKey!, token: string | undefined;
    let end = expiresAt ?? this.now() + expires;
    if (String(query.force_sts || '') === '1') {
      const sts = await this.federationToken();
      secretId = sts.Credentials.TmpSecretId; secretKey = sts.Credentials.TmpSecretKey; token = sts.Credentials.Token;
      end = Math.min(end, Number(sts.ExpiredTime));
    }
    const host = `${this.config.bucket}.cos.${this.config.region}.myqcloud.com`;
    const pathname = `/${key.replace(/^\//, '').split('/').map(enc).join('/')}`;
    const parameters: Record<string, string> = {};
    for (const name of ['response-content-type', 'response-content-disposition', 'response-cache-control', 'response-content-language', 'response-content-encoding', 'response-expires']) if (typeof query[name] === 'string') parameters[name] = query[name];
    if (query.disposition) parameters['response-content-disposition'] = String(query.disposition);
    const headers: Record<string, string> = { host, ...extraHeaders };
    if (query.contentType) headers['content-type'] = String(query.contentType);
    const headerKeys = Object.keys(headers).sort(), parameterKeys = Object.keys(parameters).sort();
    const httpString = `${method.toLowerCase()}\n${decodeURIComponent(pathname)}\n${parameterKeys.map(name => `${enc(name).toLowerCase()}=${enc(parameters[name])}`).join('&')}\n${headerKeys.map(name => `${enc(name)}=${enc(headers[name])}`).join('&')}\n`;
    const time = `${this.now()};${end}`;
    const stringToSign = `sha1\n${time}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
    const signature = hmac1(hmac1(secretKey, time), stringToSign);
    const output = new URLSearchParams({ 'q-sign-algorithm': 'sha1', 'q-ak': secretId, 'q-sign-time': time, 'q-key-time': time, 'q-header-list': headerKeys.join(';'), 'q-url-param-list': parameterKeys.join(';'), 'q-signature': signature, ...parameters });
    if (token) output.set('x-cos-security-token', token);
    return `https://${host}${pathname}?${output}`;
  }

  async fileMetadata(key: string): Promise<Row> {
    const headers = { 'x-cos-meta-need-md5': '1' };
    const url = await this.signedObjectUrl(key, { method: 'HEAD', expires: 60 }, headers);
    const response = await this.transport(url, { method: 'HEAD', headers });
    if (!response.ok) return failure(response.status === 404 ? 404 : 502, response.status === 404 ? '文件不存在' : 'COS 文件信息查询失败');
    const size = Number(response.headers.get('content-length'));
    const etag = (response.headers.get('etag') || '').replace(/^"|"$/g, '');
    const lastModified = Date.parse(response.headers.get('last-modified') || '');
    const createdAt = new Date((Number.isFinite(lastModified) ? lastModified : this.now() * 1000) + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    return { key, type: response.headers.get('content-type') || 'application/octet-stream', size: Number.isFinite(size) ? size : 0, md5: response.headers.get('x-cos-hash-md5') || response.headers.get('x-cos-meta-md5') || etag, bucket: this.config.bucket, created_at: createdAt };
  }
}

export { registerIntegrations } from './routes';
