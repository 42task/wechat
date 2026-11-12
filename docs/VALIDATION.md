# 验证记录（2026-11-12）

本轮以未修改的 `game@74cae4cdb0a5807dd32b97dd90d56ceff3f5c52b` 为合同，在 `codex/yii-node-parity-20261112` 分支修复 Node。仅使用 **MySQL 8.4.9 + Redis 7.4**；本地测试 Compose 与 CI 已改为 MySQL。没有新增业务功能，没有推送、发布镜像或更新线上 Stack。

| 检查 | 本轮结果 |
| --- | --- |
| Node 全部测试，真实隔离 MySQL/Redis | **1,024 / 1,024**，0 失败、0 跳过 |
| 实际 Yii / 编译版 Node HTTP 与业务差分 | **834 / 835**，0 工具错误；唯一差异是既有诊断凭据脱敏 |
| 匿名路由与前置响应 | 495 / 495 |
| 携带身份路由与前置响应 | 183 / 184，保留 `GET /v1/local/test` 的 Bearer 脱敏差异 |
| 管理端有效流程和边界 | 35 / 35 |
| v1 游戏、积分与账务副作用 | 65 / 65 |
| v2 设备、配置、文件、状态副作用 | 51 / 51 |
| 本地 HTTPS Y1 替身 | 5 / 5 |
| 业务 JWT 真实双向签发并立即接受 | Yii → Node 5 / 5；Node → Yii 5 / 5；另有未来/过期负例 |
| 支付损坏配置不阻断非支付应用 | 4 / 4 |
| 原 PHP 微信/支付 SDK 与 Node 供应商合同 | 42 / 42，使用合成密码材料与替身传输 |
| 原 Tencent SDK 与 Node STS 请求、策略及响应 | 9 / 9，无真实凭据或外网授权请求 |
| PHP 浮点格式、整数校验与 SQL typecast | 172 / 172，原 PHP/Yii 函数 oracle |
| 当前源路由与新鲜度 | 250 / 250 可解析项、239 条源 404 保留，212 个 PHP 文件核对通过 |
| TypeScript / 本地生产 Docker 镜像 | 通过；uid=1000，包含编译迁移与源 OpenAPI，无开发依赖/私钥目录 |
| 镜像内空库迁移、重复迁移、实际启动 | 均通过；健康接口 200，MySQL/Redis up；坏支付私钥不阻断健康检查 |

修复涵盖 JWT 小数时间、支付配置懒加载、PHP 请求/JSON 类型、fields/分页、缓存头、SQL 时钟和 clean-update 行为。账务特别保留 Yii 的运算顺序、模型整数校验、SQL 截断、失败前副作用及保存后内存响应，不新增 422 规则来替代旧行为。微信/支付/STS 的事件门控和公开错误也按当前源实现对照。

严格差分命令因诊断脱敏这一项保留差异而返回 **exit 1**，结果没有被改成零差异。源会回显 Bearer，Node 保留 `[redacted]`；该差异与所有原始对照均在报告中可查。PHP 私有文件路径/堆栈、生成时钟、随机凭据和等义 Link 引号按脚本的显式规则处理，公开状态/消息/类型、字段缺失与 SQL/Redis 余额仍参与比较。

**当前结论：本地候选修复已验证，尚不建议线上替换。** 用户浏览器中的 Portainer 是实际运行环境；Yii 与原版本 Node 共用 MySQL 和 Redis，Node 仍为 `959a1f91fffd3a49e5458ce5dc90c44bc3b15b3d`。本轮仅只读确认远端，没有迁移、改配置、切流或写入测试数据。真实微信登录、支付/退款通知、COS 上传权限、Y1 与设备验收须在隔离环境完成。

主报告为 `runtime/parity-validation/report.html`，原始结果和 JSON 汇总保存在同目录；原始修复前结果在 `baseline-20261112`。目录被 Git 忽略，包含的本地配置/密钥不能提交。报告生成器仅嵌入白名单脱敏证据，不读取本地密钥或 context。初始 797 组中 121 组不同；本轮新增了边界用例，两轮分母不同。

本地环境已经准备好时：

```sh
npm run build
# 独立终端保持服务运行；只绑定 loopback
node --import tsx scripts/differential/serve.ts
# 另一终端顺序执行
node --import tsx scripts/differential/run-integration.ts
node --import tsx scripts/differential/run.ts
node --import tsx scripts/differential/report.ts
npm run parity -- --source-root ../game
```

重建空本地测试环境时先用 `scripts/differential/compose.yaml` 启动 MySQL/Redis，再运行 `prepare.ts --fresh`。该参数遇到已存在的 parity 库会拒绝，不会 DROP；已有库直接复用 context。所有写入测试均有 loopback、专用端口、parity 库名与 Redis DB 保护。

生产依赖审计另记录同一 multer 2.4.0 公告及其 Nest 依赖链的两条 high；当前源码未注册 multer/multipart 上传中间件，本轮未升级依赖。详情保留在 `runtime/parity-validation/dependency-audit.json`。

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
