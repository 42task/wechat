# WeChat and Tencent integrations

`new Integrations()` reads deployment environment variables. Tests can inject
`fetch`, `now` (Unix seconds), `nonce`, and provider configuration through
`IntegrationOptions`. `registerIntegrations(router, services)` registers the
existing v1/v2 HTTP routes. There is no forwarding to the former PHP backend.

## Configuration

Modern names take precedence over the existing Yii variable names:

| Purpose | Modern variable | Existing Yii fallback |
| --- | --- | --- |
| Mini program AppID | `WECHAT_APP_ID` | same |
| Mini program secret | `WECHAT_APP_SECRET` | `WECHAT_SECRET` |
| Merchant ID | `WECHAT_PAY_MCH_ID` | `WECHAT_MCH_ID` |
| Merchant serial | `WECHAT_PAY_SERIAL_NO` | extracted from X.509 PEM/path `WECHAT_CERTIFICATE` |
| Merchant private key | `WECHAT_PAY_PRIVATE_KEY` (PEM) / `WECHAT_PAY_PRIVATE_KEY_PATH` | `WECHAT_PRIVATE_KEY` (PEM/path) |
| APIv3 key | `WECHAT_PAY_API_V3_KEY` | `WECHAT_SECRET_KEY` |
| Platform public key ID | `WECHAT_PAY_PLATFORM_SERIAL_NO` | `WECHAT_PUB_KEY_ID` |
| Platform public key | `WECHAT_PAY_PLATFORM_PUBLIC_KEY` (PEM) / `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH` | `WECHAT_PUB_KEY` (PEM/path) |
| Tencent credentials | `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | `SECRET_ID` / `SECRET_KEY` |
| COS bucket and region | `COS_BUCKET` / `COS_REGION` | `COS_BUCKETS_BUCKET` / `COS_BUCKETS_REGION` |

`WECHAT_PAY_PLATFORM_KEYS_JSON` accepts a JSON object mapping platform key IDs or
certificate serials to trusted PEM public keys/certificates. Configure both keys
during rotation. Unknown serials are rejected; keys are never downloaded and
trusted automatically. When a public key ID is configured it is also sent in the
`Wechatpay-Serial` request header. `WECHAT_PAY_NOTIFY_URL` overrides the callback
URL. Otherwise v1 orders use `/v1/wechat-pay/notify` and v2 file orders use
`/v2/wechat-pay/notify`, based on `PUBLIC_ORIGIN` or the incoming request origin.
`WECHAT_PAY_REFUND_NOTIFY_URL` is optional.

`WECHAT_PLATFORM_CERTS` also accepts the Yii JSON array of local X509 certificate
paths. Each certificate is indexed by its actual serial; repeated identical paths
are allowed, while conflicting paths for the same serial are rejected. Invalid
JSON, missing files and non-certificate entries fail payment verification before
provider traffic. Explicit modern single keys override modern map entries; modern
maps override legacy primary/list entries. A complete modern configuration can
replace an unused legacy primary, but never hides a malformed legacy list. Payment
configuration errors are deferred until payment/notification use, so unrelated
login and COS operations remain available.

Signing credentials stay on the server. The client receives only mini program
payment parameters, presigned object URLs, and scoped temporary STS credentials.
Provider error status, public SDK exception types and messages follow the current
Yii actions. Local key material is never included in the comparison artifacts.

## Compatibility boundaries

- Web admin `game-admin` JWT and WeChat `v2-user` Bearer identities stay independent.
- v2 login uses only the `codeSession` identity. When unionid is absent, an
  existing verified openid is required; client-provided identity fields do not
  create or select a user.
- Successful v1/v2 payment operations retain `{code,message?,data?}`;
  login/profile/phone retain `{success,message,data}`. Current v2 file order and
  confirmation validation uses HTTP errors. v1 openid does not expose `session_key`.
- v2 orders require an owned `file_id`, use its stored price in fen and the
  authenticated user's OpenID, and bind the file/account/amount in the provider
  attachment. Unknown historical prices, free or unlocked files, substituted
  payers and changed requested amounts are rejected before contacting WeChat.
- Before contacting WeChat, the order number reserves an immutable
  `file_payment_order` binding to the account, file and amount. Identical retries
  reuse that binding; a conflicting reservation returns HTTP 409. Query routes
  check the local owner before sending a provider request, and callbacks resolve
  their user from the local reservation rather than an attachment.
- A v2 order query confirms attachment ownership, AppID, merchant, payer,
  currency and the stored price before returning `data.unlocked`. Only a
  successful authenticated WeChat transaction writes `file.unlocked=1`. Known
  unpaid states may omit attachment, amount and payer details and return false;
  unknown states are rejected.
- Notifications validate the exact raw request body, trusted serial, RSA
  signature, signatures no more than five minutes old and authenticated AES-256-GCM
  payload. Like the current Yii SDK, a valid signed future
  timestamp is accepted. Signed unknown or cross-endpoint events receive the
  source success acknowledgment without order queries, writes or hooks. A v2 paid callback
  queries WeChat again and performs the same file payment checks before granting
  access, including the queried order's merchant/AppID, payer, amount and local
  ownership binding; callback resource metadata has no additional merchant/AppID
  gate and cannot itself unlock a file. The v1 paid/refund handlers retain their
  acknowledgment-only behavior without order queries or accounting writes. Failed or still-unpaid
  confirmation returns HTTP 500 without success acknowledgment. Successfully
  verified JSON callbacks return JSON `{code: 'SUCCESS', message: '成功'}`, including
  when the caller requests XML through Accept. An XML request body preserves the
  current source SDK/controller's HTTP 500 `ERROR` failure after signature verification;
  it never processes or acknowledges a payment. An optional `onPaymentNotification`
  hook remains available; hook failure prevents acknowledgment.
- The current v2 controller exempts `notify` and `refund-notify` from user Bearer
  authentication. Node retains the same provider-signature authentication, while other v2
  payment operations continue to require `v2-user` Bearer credentials.
- The current `/v1/q-cloud/object-url` calls an undefined `File::Create` method.
  A valid key preserves the source HTTP 500 exception without COS traffic or
  database writes; migration does not add the signing behavior described by its
  outdated source comment. Parameter binding still follows the source action.
- The v1 WeChat info SDK object serializes to `{}`, without exposing SDK configuration
  or secrets. The missing v2 info action and the unpublished v2 code action stay
  HTTP 404 and are not exposed as new endpoints.
- STS requests retain the actual source policy, including `principal` and the
  `GenerateSignURL` / `GetObjectUrl` action strings. They omit DurationSeconds so
  the provider applies its default. The PHP oracle verifies the exact encoded
  policy and headers using the original Tencent SDK with an injected transport;
  real provider acceptance and account permissions still require external acceptance testing.
- Current v1 token requests accept the caller's required `bucket` and optional
  `region`, defaulting to `ap-nanjing`;
  v2 token requests use configured storage and ignore query overrides. An
  unconfigured cloud discovery response retains `{bucket:false,region:false}`.
- Admin saved-image previews use the current device control scope and sign only
  HTTPS objects from the configured COS bucket. Links use GET, a shared absolute
  five-minute expiry, and the SDK-compatible `sign` parameter. Saved query strings,
  request overrides and fragments never reach signing; GET never creates setup.

Provider comparison loads the current checkout of `game` at execution time;
historical compatibility notes are not an oracle for current behavior. Missing
local provider configuration stays distinct from an actual provider response:
Node does not fabricate an old Tencent remote credential error when no request
was made. Scene forwarding continues to verify HTTPS certificates. Account
ownership, active-payment order checks and provider signatures remain enforced.

## Official protocol references

- [WeChat code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)
- [WeChat phone number API](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html)
- [WeChat stable access token](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html)
- [WeChat Pay request signing](https://pay.wechatpay.cn/doc/v3/merchant/4012365336)
- [WeChat Pay response and callback verification](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)
- [WeChat Pay signature scenarios](https://pay.wechatpay.cn/doc/v3/merchant/4012365342)
- [WeChat Pay callback AES-GCM encryption](https://pay.wechatpay.cn/doc/v3/partner/4019605946)
- [Tencent STS GetFederationToken](https://intl.cloud.tencent.com/ind/document/product/1150/49452)
- [Tencent TC3 request signing](https://cloud.tencent.cn/document/product/213/30654)
- [Tencent COS signing](https://cloud.tencent.com/document/product/436/7778)
- [Official COS Node SDK signing implementation](https://github.com/tencentyun/cos-nodejs-sdk-v5/blob/master/sdk/util.js)

## Verification

`npm test -- tests/integrations.test.ts tests/integrations.routes.test.ts tests/integrations.payments.test.ts tests/integrations-parity.test.ts tests/admin-image-parity.test.ts`

Tests use generated test RSA keys and injected provider responses, exercising
exact request signing, response verification, authentic notification decryption,
invalid signatures/serials/timestamps/ciphertext/merchant, login identity
selection, refresh domain, profile field allowlists, phone credentials, STS
policy scope, COS HEAD metadata, payment/refund response shapes, file price and
ownership checks, signed provider requery, and idempotent file unlocking with
isolated SQLite records.
They do not contact real WeChat accounts, issue real temporary credentials,
charge payments, or establish production callback reachability.

With the current Yii checkout and its Composer dependencies available, run the
provider boundary comparisons without SQL, Redis or real provider traffic:

```sh
node --import tsx scripts/differential/provider-boundaries.ts
node --import tsx scripts/differential/sts-boundaries.ts
```

The reports are `runtime/parity-validation/provider-boundaries.json` and
`runtime/parity-validation/sts-boundaries.json`. STS compares original action
bodies and the real SDK, replacing only its internally constructed HTTP transport.
