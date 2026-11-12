# 验证记录（2026-11-12）

本轮以未修改的 `game@74cae4cdb0a5807dd32b97dd90d56ceff3f5c52b` 为现代 Yii 合同，逻辑检查先在 `codex/online-acceptance-20261112` 完成，旧协议补充在 `codex/legacy-main-parity-20261112`。实际应用候选仍为 `4bcd38b83f42bf6333d1758e48f1b9c8007ad55c`；用户随后授权的 b0 单 Host 切换和 b1 候选更新均已完成。当前本机与 CI 仅使用 **MySQL 8.4 + Redis 7.4**（本机实测 MySQL 8.4.9），没有新增业务功能或更换线上数据库。

用户已明确调整顺序：**先完成代码和逻辑对应，确认后执行后端切换；真实微信、支付、COS 和设备联调延期。** 本页记录已授权并完成的有限部署范围；延期联调及旧主域名兼容问题仍未完成。

[候选 CI 43238081426](https://github.com/42task/wechat/actions/runs/43238081426) verify/publish 均成功，PHP 8.4.27 下 1,257 项测试通过，冻结源码新鲜度、生产镜像静态文件与编译迁移检查均通过。补充检查提交 `1bf66a3fe4c89e0e89443984568733b2a868a8a6` 的 [CI 43244233055](https://github.com/42task/wechat/actions/runs/43244233055) verify 成功、publish 按条件跳过；该提交没有改变应用源码，部署版本仍是 `4bcd38b`。

| 本次部署范围（Asia/Shanghai） | 当前状态 |
| --- | --- |
| b0，23:15:36 | 仅 `Host(x.b0.01xr.com)` 切到 Node `4bcd38b`，容器前缀 `76f978`；路由优先级 22，高于原 Yii 规则。`GAME_DEV_AUTH=1` 经用户明确批准，延续原 Yii dev 免签策略。原 Yii 容器 `cae4a0` healthy，保留用于回滚 |
| b1，23:22:10 | `x2.b1.01xr.com` 候选 Node 更新为同一镜像，容器前缀 `1fb706`；原路由标签保持。业务入口 `x.b1.01xr.com` 仍为 Yii `64901c9`，原 Yii 容器 `0ba24b` healthy；`GAME_DEV_AUTH=0` 未变 |
| 两处只读验收，23:23:55 完成 | 每个入口 **11/11**，合计 **22/22**：健康及版本、5 个公开文件字节、3 个禁止路径、文件列表 Bearer 要求及 OPTIONS |

两端使用同一镜像摘要前缀 `7f91cc`，保持各自现有网络及只读密钥卷。b1 以自己的 Yii 为准核对 **24/24** 项业务环境映射、**6/6** 个密钥文件内容相等且双方可读；其独立的 `ADMIN_SCAN_LOGIN_ORIGIN` 已修正为本环境 Yii 对应值，没有照搬 b0。没有执行数据库迁移、Stack 整体重部署、backup/keys/migrate 等辅助任务或业务写入；`x.4mr.cn`、b1 业务入口及其他域名保持原状。最初包含多个 Host 的草案被自动审批拒绝，实际应用前已收窄为唯一获准的 b0 Host。日后共用镜像的配置方式见 [部署说明](DEPLOYMENT-B0-B1.md)。

配置核对期间，UI 快照曾意外将 ENV 值显示到工具输出，已明确告知用户；后续检查只输出变量名、数量和布尔结论。实际 ENV 值、密钥内容和指纹没有写入仓库或报告。本页及报告只记录必要的部署标识、路由、状态、计数和批准结论，不作“从未在任何地方输出”的笼统声明。

`x.4mr.cn`（146.56.194.31）仍为 `c4e088adc7ba17bd5bb640ac31178a122906e002` 的旧协议，和本轮现代 Yii 对照不同。现有小程序在旧主域名主动省略支付 `file_id`，当前候选按新版协议会拒绝；旧 JWT 身份域、文件归属/价格/订单绑定、权限及四项迁移也存在跨版本差异。独立旧版对照仅 **2/12** 一致，不能把 b0 切换称为旧主域名的透明替换。

旧主域名单独在 `codex/legacy-main-parity-20261112` 补充可复跑的固定源码 oracle 和隔离 MySQL 升级演练，应用运行代码保持候选版本。结果与限制见 [旧主域名兼容性](LEGACY_MAIN_COMPATIBILITY.md)，不计入下表的现代 b0 差分数量。

| 当前工作树的本地检查 | 最新已完成结果 / 状态 |
| --- | --- |
| 全量测试，真实隔离 MySQL/Redis | **1,257 / 1,257**，0 失败、0 跳过 |
| Yii / 编译版 Node 严格 HTTP 与业务差分 | **883 / 884**，0 工具错误；仅保留诊断 Bearer 脱敏，未解释差异为 0 |
| 匿名路由与前置响应 | 495 / 495 |
| 携带身份路由与前置响应 | 183 / 184，保留 `GET /v1/local/test` 的 Bearer 脱敏差异 |
| 管理端有效流程和边界 | 51 / 51 |
| v1 游戏、积分与账务副作用 | 97 / 97，新增商户 operation 关系首次读取时的默认值及 SQL 副作用已完整复测 |
| v2 设备、配置、文件、状态副作用 | **52 / 52**，包含非有限数字编码错误及其 SQL 状态 |
| 本地 HTTPS Y1 替身 | 5 / 5 |
| 原 PHP 微信/支付 SDK 与 Node 供应商合同 | **75 / 75**，合成密码材料与替身传输；不是实际交易 |
| 本地 JWT 实际双向签发并立即接受 | Yii → Node 5 / 5；Node → Yii 5 / 5；另有未来/过期负例 |
| 支付损坏配置不阻断非支付应用 | 4 / 4 |
| 原 Tencent SDK 与 Node STS 请求、策略及响应 | 9 / 9，本地替身传输，无外网授权请求 |
| PHP 浮点格式、整数校验与 SQL typecast | 172 / 172，原 PHP/Yii 函数 oracle |
| 本地参考源路由与新鲜度 | 250 / 250 可解析项、239 条源 404 保留，212 个 PHP 文件核对通过 |
| 本地逻辑候选镜像 | 健康接口 healthy；MySQL/Redis up，uid=1000；5 个原始公开文件的实际 HTTP 字节/hash 核对通过，专属容器已移除；当前固定 SHA 部署见上表 |

本轮新增修复包括管理配置的整数/小数词法、重复保存不更新时间、PHP 名称和内容归一；Redis 只保存 dirty 字段，避免并发状态覆盖，并保留新建记录的重复列表成员、数值主键计数及序列化错误前副作用；补齐原始域名校验文件、robots、favicon 和 CSS 的固定路径。另核对微信 profile 的 JSON 数值类型、支付/退款金额和通知错误，以及场景目录的 PHP 整数过滤、空白与错误 JSON 缓存。账务继续按源的运算顺序、模型校验、SQL 截断、失败前副作用和保存后内存响应对照，没有新增业务规则。

严格差分中的诊断脱敏差异没有被归一化消掉：源会回显 Bearer，Node 保留 `[redacted]`，因此严格命令仍可返回 **exit 1**。PHP 私有路径/堆栈、生成时钟、随机凭据和等义 Link 引号只按脚本的显式规则处理；公开状态/消息/类型、字段缺失与 SQL/Redis 状态继续参与比较。最终组数和未解释差异以全部套件完成后重新生成的 `runtime/parity-validation/summary.json` 为准。

保留的实现和验证边界：

- Y1 的旧 `forwardCheckinRequest` 关闭了 TLS peer 校验，Node 保持证书验证；不会为了错误证书行为一致而关闭校验。本地主表使用 HTTPS 替身，不能代替真实 Y1 网络验收。
- 部分设备建档等错误分支采用更强的事务回滚，避免留下半成品；不把这些保护写成任意故障下的逐条写入完全等价。
- 扫码 create/approve 限流在 Yii 使用 FileCache，Node 使用 SQL；混合节点间计数不共享。管理令牌、刷新 CAS、密码限流和 owner 锁沿用共享 Redis 格式。
- 业务 ID 和 `scene_id` 按现有 INT32 数据库域验证。超出 JavaScript 安全整数范围的 PHP64 原始数字与 JSON 输出仍有精度边界，不能据此宣称任意 PHP64 输入逐字节等价。
- b0 原 Yii 的 `YII_ENV=dev` 会跳过设备 refresh 的 time/hash 校验，本次已获明确批准以 `GAME_DEV_AUTH=1` 延续；b1 保持 `GAME_DEV_AUTH=0`，不能因共用镜像自动继承 b0 策略。MySQL 连接字符集按各自源的 `utf8` 配置，不随镜像更新改变数据。

以下线上证据属于**较早的 d829 候选**，不能代替本轮工作树代码的验收。提交 `d8294e95aa29d3aefa729107a1dd2f3b63d0d823` 已通过 [应用 CI 43226455851](https://github.com/42task/wechat/actions/runs/43226455851) 的 verify、publish 和 1,029 项测试。2026-11-12 **21:35:04（Asia/Shanghai）**仅替换 b0 尚未使用的 Node 容器，容器 ID 前缀 `6a8dd5`，固定镜像摘要前缀 `49de7bc`。Yii 源码版本（前缀 `64901c9`）、容器（ID 前缀 `cae4a0`）未变，b1 Node 仍为 `959a1f91fffd3a49e5458ce5dc90c44bc3b15b3d`；未整体重部署 Stack、未执行迁移、未切换业务入口。

| 较早 d829 候选的线上范围 | 结果 |
| --- | --- |
| b0 专属新 fixture 对照 | **24 / 24**，`completed=true`、`restored=true` |
| fixture 清理和恢复复核 | 10 条 SQL 行、6 个 Redis hash 已清理并复核；未重置自增计数、全库或全局列表 |
| 无对象写入的供应商探测 | **8 / 8**，支付配置布尔检查全部通过，`cosWritesStarted=false` |
| 实际 STS 与缺失对象 HEAD | 两端合计 **8 次 STS 签发、8 次 HEAD 404**；没有对象 PUT/GET/DELETE |
| 只读环境映射 | **22 项业务环境值一致，6 / 6 密钥文件内容完全一致且两端可读**；该历史核对只记录相等和可读结论，未改线上环境 |

业务对照运行标识为 `codex_20261112_b0_d8294e9_a1`。更早 `fa630128ec7a9041b112af945ddacdd1106fdcc0` 候选为 20/24，差异仅在分页 Link 的 HTTP/HTTPS scheme；d829 只将分页链接按原生 socket TLS 状态生成，保留真实协议差异检查，没有改变可信代理、IP、认证、Location 或支付通知 URL，随后复测为 24/24。

供应商探测运行标识为 `codex_20261112_b0_d829_provider_a1`。商户证书有效性、与私钥/序列号匹配、签名往返及平台验证材料等布尔检查全部通过。探测先确认两端存储 scope 相同，再签发同 scope 短效 STS 并 HEAD 不存在的对象；没有扩大桶权限。真实微信登录/手机号、付款/退款/回调、COS 对象 PUT/GET/DELETE、Y1 与实体设备的连接/拍摄/上报/上传仍属延期范围。COS 写入模式仍为实验性且未获线上执行批准，无版本对象 DELETE 不被宣称具备原子归属保证。

较早的 **834/835** 本地严格结果与 **42/42** 供应商合同是修复前阶段记录。本轮严格结果稳定后重新生成 HTML 和 JSON；本地用例结果与已授权部署状态分别列示。报告里的线上信息来自 `runtime/online-acceptance` 的白名单状态摘要，当前代码、本地镜像、当前部署、较早候选和历史归档分别列示。原始初轮 797 组中 121 组不同，归档于 `baseline-20261112`；新增边界用例后分母不同。

本地环境已经准备好时：

```sh
npm run build
# 独立终端保持服务运行；只绑定 loopback
node --import tsx scripts/differential/serve.ts
# 另一终端顺序执行
node --import tsx scripts/differential/run-integration.ts
node --import tsx scripts/differential/run.ts
# 所有套件结束后再生成报告
node --import tsx scripts/differential/report.ts
npm run parity -- --source-root ../game
```

重建空测试环境时先用 `scripts/differential/compose.yaml` 启动 MySQL/Redis，再运行 `prepare.ts --fresh`。遇到既有 parity 库会拒绝，不会 DROP；已有库复用 context。这些写入受 loopback、专用端口、parity 库名与 Redis DB 保护，不能用于业务库。当前测试仅使用 MySQL；下方 MariaDB 内容是历史归档。

在线工具 `scripts/acceptance/online-parity.cjs`、`scripts/acceptance/providers.cjs` 是显式授权后手工执行的独立流程，要求批准候选 SHA 与唯一 runId，不随应用或 CI 自动运行。fixture 恢复复核只证明本次行和 Redis 成员清理，不代表全库时间点恢复。配置、密钥和 context 位于被忽略的 runtime 目录，不得提交；报告生成器只嵌入白名单状态/脱敏证据。

后端 [42task/wechat](https://github.com/42task/wechat) 和小程序 [42task/bujiaban-mp](https://github.com/42task/bujiaban-mp) 迁移保留 Git 历史；管理前端已抽离到 [42task/checkin-frontend](https://github.com/42task/checkin-frontend)，[前端 CI 43228540382](https://github.com/42task/checkin-frontend/actions/runs/43228540382) 通过。原 [gdgeek/game](https://github.com/gdgeek/game) 保持未修改的 Yii 对照。仓库整理不代表业务切流。

生产依赖审计另记录同一 multer 2.4.0 公告及其 Nest 依赖链的两条 high；当前源码未注册 multer/multipart 上传中间件，本轮未升级依赖。详情在 `runtime/parity-validation/dependency-audit.json`。

## 历史归档：2026-10-23 契约对齐

以下是原仓库历史记录，数据库矩阵、发布与清理状态均指当时，不代表本轮执行。

验证对象为 `source-manifest.json` 的 202 个源文件哈希，包含当前 game 管理 JWT、设备删除/历史保留、设备 version 上报及文件下载/支付流程；其中包含源工作区并发产生的改动。验收锁定在 2026-10-22 17:52:58 UTC 的冻结快照；不将其他会话之后的修改混入本次验证。

| 检查 | 结果 |
| --- | --- |
| TypeScript 生产构建 | 通过 |
| 普通离线测试 | 174 通过，23 个 SQL/HTTP 集成用例按设计跳过 |
| MySQL 8.4 + Redis 7.4 全量测试 | 17 个文件，197 项通过，0 跳过 |
| MariaDB 11.4 + Redis 7.4 全量测试 | 17 个文件，197 项通过，0 跳过 |
| GitHub CI 三数据库矩阵 | MySQL 8.4、MariaDB 11.4、MariaDB 10.4 均通过 |
| 独立源路由核对 | 249/249 可解析 method/path 对覆盖；239/239 原 404 保留 |
| 未声明方法/路径负例 | 7/7 保留 |
| 当前源码新鲜度 | 对冻结源目录直接核对通过；`--source-root` 可检测其他 checkout 后续修改、删除和新增源文件 |
| 真实 Yii ↔ Node 管理认证 | ES256 双向签发/验证、跨运行时刷新、旧刷新拒绝、撤销立即生效及绝对期限均通过 |
| 数据升级演练 | 唯一新建的临时库；既有业务数据保留、未知名称 CASCADE 外键改 SET NULL、重复执行通过 |
| Docker 多阶段生产构建 | 通过；运行镜像仅保留生产依赖 |
| 生产容器启动 | uid=1000；`/health` 返回 200，MySQL/Redis 均 healthy |
| 独立代码审查 | 发现的问题均已修复并补回归；当前无剩余 P1/P2 发现 |

数据测试包含真实事务、游戏账务、JSON 类型、管理 JWT/身份域、共享刷新 CAS、密码限流、扫码 owner proof/一次消费/锁丢失、实时 control 权限撤销、并发配置写入和跨后端诊断。新增设备删除覆盖密码管理员权限、微信管理员拒绝、未结束游戏 409、已结束历史保留及故障回滚；非法外键参数保持 Yii 422，不进入错误 SQL。升级测试仅清理自己成功创建的随机数据库；HTTP 认证测试仅清理本轮随机 issuer 的 Redis 键。

可复现互通脚本为 `scripts/verify-yii-admin-interop.cjs` 和配套 PHP，使用当前源组件与真实隔离 Redis DB 15。测试密钥仅临时生成，不使用生产密钥或账号。扫码 create/approve 的限流计数仍由 Node SQL 保存，Yii 使用 FileCache，因此混合节点间此类计数不共享；管理令牌、刷新、密码限流和 owner 锁按 Yii Redis 格式共享。

实现提交 `d5024cf` 的 [本轮 GitHub CI](https://github.com/gdgeek/wechat/actions/runs/39827497011) 三组均通过，含依赖安装、构建、空库初始化、全量测试、路由核对及 Docker 构建。新增 MariaDB 10.4 与原 game CI 数据库版本对齐；此前 `f1ccbe5` 的 CI 仅为历史记录。

本次只修改 wechat 后端仓库，没有运行生产迁移或切换线上入口，没有修改 Vue 管理后台、小程序或源 Yii2 文件。微信支付及 COS/STS 测试使用真实本地密码算法和可注入传输，未发起真实交易。仍需使用真实凭据验收微信登录/手机号、支付退款回调、COS 权限、Y1 和真实设备。旧数据库已丢失的 device.shop_id 映射需从可信备份恢复，不能由代码推断。已知源损坏入口的兼容处理见 API_PARITY.md。

文件新增验收包括当前账号与旧 unionid 归属回退、文件写入口 404、拍摄时价格快照、配置改价后旧文件不变、旧文件 NULL 不回填、v2 服务端定价与付款主体校验、微信签名查单与可信回调幂等解锁。金额明确按整数分处理，recordingPriceInCents 的整分规则与原有上传 key 归属重绑限制见 API_PARITY.md。

本地订单表已覆盖真实 SQL 并发争用、不可换绑、同单幂等、大小写区分及 price 列已存在但订单表缺失时的升级。未付状态不依赖微信尚未返回的付款附件，成功支付仍核本地绑定与可信微信结果。

实现已推送 gdgeek/wechat main，随后仅补验证文档。最终生产镜像包含 reserveOrder 方法、以 uid=1000 运行，健康接口 200；本次创建的所有测试容器与网络已清理，其他容器未动。
