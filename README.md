# wechat — game 的 Node.js 后端

使用 Node.js 24、TypeScript、NestJS 重写 [gdgeek/game](https://github.com/gdgeek/game) 的 Yii2 后端。当前后端仓库为 [42task/wechat](https://github.com/42task/wechat)，微信小程序为 [42task/bujiaban-mp](https://github.com/42task/bujiaban-mp)，两者迁移保留 Git 历史。Vue 管理前端已从原项目抽离至 [42task/checkin-frontend](https://github.com/42task/checkin-frontend)；`game` 保持未修改的 Yii 对照实现。客户端继续使用原接口。

兼容范围包括 `/v1` 游戏、玩家、商户、奖品、积分、签到与文件流程，`/v2` 微信身份、设备配置、版本上报、状态协调、文件与云存储，`/admin-api` 密码/扫码登录、管理 JWT 刷新和撤销、设备权限及配置，以及健康检查、受 Basic Auth 保护的 Swagger 和五个固定路径的原始公开静态文件。

## 启动

```sh
npm ci
cp .env.example .env
# 填写数据库、Redis、JWT、微信和腾讯云配置
npm run build
npm start
```

数据库使用 MySQL，Redis 沿用 Yii Redis ActiveRecord 键格式。`JWT_KEY` 兼容原密钥文件，亦可使用 `JWT_SECRET`；要接收原 Token，必须配置相同签名密钥。原微信、腾讯云环境变量名称也可继续使用，详见 [集成说明](src/integrations/README.md)。

Web 管理端使用当前 Yii 的独立 `game-admin` ES256 Bearer JWT，登录和扫码消费返回 `{user,token,authMode:"jwt"}`，通过 `/admin-api/refresh` 轮换刷新令牌，退出撤销整次登录。访问令牌最长三小时，刷新不会延长原八小时期限。扫码浏览器凭据使用现有 `X-Admin-Scan-Owner` 请求头；管理端不要求 Cookie 或 CSRF。

沿用相同 `ADMIN_JWT_KEY` / `ADMIN_JWT_PUB_KEY`、`ADMIN_AUTH_ISSUER` 以及 `ADMIN_AUTH_REDIS_*` 后，Yii 与 Node 可共享管理令牌、刷新状态、密码限流和扫码 owner 锁。认证 Redis 独立于业务 Redis 配置，连接失败返回 503。小程序继续使用原 HS256 Bearer Token，v1/v2 与管理身份域严格隔离。本次 b0、b1 均经用户分别明确批准设置 `GAME_DEV_AUTH=1`，延续各自 Yii `YII_ENV=dev` 的设备免签策略：设备 refresh 鉴权跳过 time/hash 和 token 格式检查，仍需 token 及唯一的 uuid/id/key；小程序 JWT 和支付回调验签保持原规则。扫码 create/approve 的 Yii FileCache 与 Node SQL 限流计数不共享。

## 数据库

先对数据库做备份，并在副本验收。已有 Yii 数据库执行：

```sh
npm run migrate
```

空数据库执行：

```sh
npm run migrate -- --bootstrap
```

`--bootstrap` 只接受空库，不包含 DROP TABLE。普通迁移创建兼容状态/扫码限流表和缺失扫码表，检查设备版本字段及 v1 商户关联列，并将 `record.device_id` 改为允许空值和 `ON DELETE SET NULL`；保留业务行。旧 Node Session 表保留，认证不再使用。迁移不会随应用启动自动运行。

设备类型存储在 `device.device_type`（`VARCHAR(32) NOT NULL DEFAULT 'ios'`）。执行迁移会给已有设备补上 `ios`，新设备未指定类型时也默认使用 `ios`；重复迁移保留已设置的类型。空库初始化和已有数据库升级均通过上述迁移入口完成。v2 设备接口使用 `device_type` 读写，接受非空且不超过 32 个字符的类型值（例如 `ios`、`rokid`）；Web 管理设备接口返回 `deviceType`。

冻结源的 v2 历史迁移删除了 `device.shop_id`，但 v1 游戏仍依赖它。`database/002-v1-compatibility.sql` 恢复可空关联列和外键。已经丢失的设备与商户映射需要从可信备份核对恢复，代码不能推断历史归属。初始化 SQL 来自 65 个源迁移的最终状态；生成器只用于离线核对，服务运行不依赖 PHP。

当前管理员设备删除入口为 `DELETE /admin-api/devices/:id`，仅密码管理员可用。存在未结束的游戏时返回 409；删除配置和关联时保留已结束游戏记录及原时间字段。必须先完成记录保留迁移，旧未升级的表结构会拒绝删除。已有外键通过单条 ALTER 原子更新；重复迁移不修改业务数据。

## 验证

2026-11-12 本轮逻辑候选已完成真实隔离 MySQL/Redis **1,257/1,257** 回归（0 失败、0 跳过），实际 Yii / 编译版 Node HTTP 与业务差分 **883/884**（v1 新增边界复测为 97/97），仅保留诊断 Bearer 脱敏，没有未解释的差分。实际部署应用仍为 `4bcd38b83f42bf6333d1758e48f1b9c8007ad55c`，其 [CI 与固定 SHA 镜像发布](https://github.com/42task/wechat/actions/runs/43238081426) 均成功；补充验证提交 `1bf66a3` 的 [CI 43244233055](https://github.com/42task/wechat/actions/runs/43244233055) verify 成功、publish 按条件跳过，没有替换已部署应用版本。

| 当前架构 / 入口 | 运行状态 |
| --- | --- |
| 前端 f：`c.4mr.cn` | 实际运行的 Nginx 将管理 API 按 50%/50% 分到 b0/b1，彼此互为 backup；小程序网关以 b0 为主、b1 为备 |
| `x2.b0.01xr.com`、`x2.b1.01xr.com` | 前端实际使用的两个 Node 上游；两台 Node 均保留这两个 Host 别名，TLS 验证开启，公共 Host/SNI 为 `x2.b0.01xr.com` |
| `x.b0.01xr.com` | 此规范业务 Host 已切到 Node `4bcd38b`；设备免签设置经明确批准，原 Yii 保留用于回滚 |
| `x.b1.01xr.com` | 已按后续明确批准切到同一 Node `4bcd38b` 镜像，并启用设备免签；原 Yii 保留用于回滚 |

当前 b1 容器为 `2ff62e`（11 月 12 日 23:57:58 创建），已恢复 Node 原有的统一扫码 origin `c.4mr.cn`。此前复制 b1 Yii 的废弃 `checkin.voxel.cn` 是本轮配置错误，已说明并修正；因此当前与 b1 Yii 的环境映射是 **23/24**，唯一差异是这项有意保留的退役 origin 例外。两台实际 Node 已核实共享同一 MySQL 数据库及票据表、业务/管理 Redis 实例与 DB、六个密钥文件和管理 issuer。实际前端配置及两个不同服务器的上游已核实，不能再称 `x2` Node 为“未使用”；没有据此推断历史请求量。

11 月 13 日的集群验证仅插入 **1** 条自有 pending 票据，经真实前端分别强制走 b0/b1 执行 **4** 次状态读取、在 b1 取消 **1** 次，两台均看到 cancelled；自有票据、owner lock、临时代码和私有 ledger 均已清理。没有调用 HTTP 创建票据、全局清理、限流写入、批准、登录、消费、真实账号或供应商。首次 `CLIENT INFO` 预检在任何数据写入前失败，修正 helper 的实例/DB 绑定后才完成上述成功运行。11 月 12 日 23:23:55 的两入口 **22/22** 与 23:44:34 的 b1 业务入口 **11/11** 只读检查分别保留历史时间和范围，不等于全部接口证明。没有 DDL、数据库迁移、Stack 整体重部署或辅助任务；本轮数据写入只涉及上述已清理的自有 fixture。

用户已确认当前范围是 **f → b0/b1**，旧二维码、缺省/显式 v0 和 `x.4mr.cn` 已停用，`checkin.voxel.cn` 也已退役，统一使用 `c.4mr.cn`。旧主线 **2/12** 对照只保留为历史参考，不再是当前替换门槛，也不宣称旧协议透明兼容；本轮没有修改旧基础设施。当前活动后端已可由 Node 替换且两台都在使用，仍保留唯一 Bearer 脱敏差异及已知边界。真实微信/手机号、支付退款回调、COS 对象和实体设备联调继续按用户决定延期。详细范围及 UI 输出事件见 [验证记录](docs/VALIDATION.md)。

```sh
npm run build
npm test
npm run parity
# 同时核对真正的当前 Yii 源码，检测基线之后的修改或新增后端 PHP 文件
npm run parity -- --source-root /path/to/game
```

普通测试不连接生产资源。SQL/HTTP 集成测试统一使用 MySQL 8.4 和 Redis 7.4，CI 也只验证 MySQL 8.4。集成测试要求显式开启并限定本机测试数据库：

```sh
docker compose -f compose.test.yaml up -d --wait
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=33367 MYSQL_USER=root
export MYSQL_PASSWORD=wechat-local-test MYSQL_DATABASE=wechat_test
export REDIS_HOST=127.0.0.1 REDIS_PORT=36379 REDIS_DB=0
npm run migrate -- --bootstrap
RUN_INTEGRATION=1 V1_MYSQL_TEST_URL='mysql://root:wechat-local-test@127.0.0.1:33367/wechat_schema_test' npm test
```

`wechat_schema_test` 是专用的可重建测试库，v1 集成测试会重建它；`wechat_test` 的 HTTP fixtures 也会清理测试行。管理认证使用同一个隔离 Redis 的 DB 15，并清理 `game:admin:auth:*` 测试键。迁移测试创建唯一命名的新库、只清理自己成功创建的库，不复用同名既有数据。不要把这些变量指向业务资源。测试完成后 `docker compose -f compose.test.yaml down`。

源路由与实现对照、已损坏旧入口和具体兼容处理见 [API_PARITY.md](docs/API_PARITY.md)。线上探测已验证支付材料配置检查、实际 STS 签发和临时凭据对缺失对象的 HEAD；没有执行实际支付/退款、对象 PUT/GET/DELETE 或实体设备联调，不能把探测通过当作这些流程已完成。

有当前 Yii 源码和 PHP/Composer 环境时，可复现真实双向管理令牌互通检查（仅接受显式指定的 localhost 非 6379 测试端口、DB 15，临时密钥和随机 issuer）：

```sh
RUN_YII_ADMIN_INTEROP=1 YII_SOURCE_ROOT=/path/to/game \
ADMIN_AUTH_REDIS_HOST=127.0.0.1 ADMIN_AUTH_REDIS_PORT=36379 ADMIN_AUTH_REDIS_DB=15 \
node --import tsx scripts/verify-yii-admin-interop.cjs
```

## 部署

```sh
docker build -t wechat-backend .
docker compose up -d
```

`compose.yaml` 只启动后端，连接 `.env` 中指定的数据库和 Redis，不部署前端。证书、JWT 密钥通过只读挂载或平台 Secret 注入，容器以 `node` 用户运行，须保证该用户能读取密钥。`TRUST_PROXY` 仅在已有可信反向代理后启用，保证请求 origin 和 IP 限流使用正确地址。原管理端代理继续转发 Bearer 和 owner proof，保留目前清除 Cookie/CSRF 的设置。

b0 / b1 今后复用同一已验证镜像时，使用 [compose.image.yaml](compose.image.yaml) 和 [分环境部署说明](docs/DEPLOYMENT-B0-B1.md)，保留每台 Node 的两个 `x2` 别名、统一扫码 origin、共享连接/密钥及明确批准的设备策略。[部署预检脚本](scripts/check-image-deployment.py) 检查五项镜像构建元数据覆盖；[集群票据验证脚本](scripts/acceptance/scan-cluster.cjs) 提供显式授权的单行验证及精确清理。应用与 CI 不自动执行线上验证；CI 仅运行不访问外部服务的合成 `--self-test`。

如果沿用 `SCENE_SERVER_BASE_URL=http://y1-p:8080` 或其他现有 Docker 服务名，使用 `BACKEND_NETWORK=proxy docker compose -f compose.yaml -f compose.proxy.yaml up -d` 接入对应的既有网络；该网络必须预先存在，名称可按部署修改。密钥挂载、域名入口与外部回调可达性在切换前验收。支付通知默认保留 Yii 由请求 origin 生成的对应 `/v1/wechat-pay/notify` 或 `/v2/wechat-pay/notify`，也支持显式通知 URL。

`/health` 同时检查数据库和 Redis，支持 HEAD。Swagger 的 `/swagger`、`/swagger/json-schema` 使用 `SWAGGER_USERNAME` / `SWAGGER_PASSWORD`，未配置不公开文档。微信支付通知采用原生平台验签与 AES-GCM 解密，通知入口不使用小程序 Bearer，也不虚构源系统没有的订单入账逻辑。

源码基线与内容哈希保存在 [source-manifest.json](docs/source-manifest.json)。未包含原环境文件、密钥、业务数据或客户端源码。

当前 v2 文件列表/详情只读当前账号文件；文件 CRUD 不再允许客户端直接写入价格或解锁状态。拍摄时保存整数分价格，旧文件未知价格保留 NULL；下单、查单和回调按当前 Yii 文件付款流程校验并解锁。整数分价格按冻结源 recordingPriceInCents 规则处理；本地订单绑定、回调核验和保留的协议限制见 API_PARITY.md。

`file_payment_order` 使用区分大小写的订单号主键，支付请求前持久绑定账号、文件和金额；同绑定重试幂等，不允许把已有订单号换绑。普通升级即使已存在 file.price 也会创建缺失的订单表。
