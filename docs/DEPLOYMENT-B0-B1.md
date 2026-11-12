# b0 / b1 共用镜像部署

两端使用同一个已经验证的 `WECHAT_IMAGE`，只在各自部署配置中保留路由、origin、MySQL、Redis、密钥卷、上游服务与设备认证策略的差异。升级时更换镜像引用即可，无需现场构建或修改业务代码。本文只提供部署配置；不会执行发布、数据库迁移或入口切换。

当前 `compose.yaml` 用于本地构建，读取固定 `.env` 并绑定宿主机 loopback 端口；`compose.proxy.yaml` 只增加既有 Docker 网络。镜像部署使用单独的 [compose.image.yaml](../compose.image.yaml)，适用于 Compose 或现有 Portainer 的 Docker Standalone Stack。它直接复用已经存在的外部命名密钥卷，不包含数据库、Redis、备份、密钥准备或迁移辅助服务。

## 保留每个环境现有配置

从当前正在使用的 Stack 配置和相应 Yii/Node 服务取值，在部署平台或仓库外保存 b0、b1 各自的配置。不要用 `.env.example` 覆盖现有环境，也不要把原始值、完整 `docker inspect` 或带密钥的 Compose 展开结果存入仓库、报告或聊天。已有 provider、Swagger、管理员、支付回调和 Redis 配置全部保留，下面只覆盖明确列出的运行参数。

本轮只读私有身份核对已确认：两个 Node 连接同一 SQL 数据库、同一业务 Redis 和管理认证 Redis，六个挂载密钥文件的字节相同，管理 issuer 相同。两端的 `ADMIN_AUTH_ISSUER` 与 `ADMIN_SCAN_LOGIN_ORIGIN` 都使用 `https://c.4mr.cn`。用户已确认弃用的 `checkin.voxel.cn` 不作为当前扫码目标；此前把 b1 Node 的扫码 origin 按其旧 Yii 复制为该域名是一次配置错误，已恢复为统一 origin。

这个例外不能用“24 项环境全部照搬 Yii”描述：当前采用 23 项原业务映射，加上明确选择的统一扫码 origin。票据的 audience 会在每次查询、确认、兑换和取消时严格核验，节点 origin 不同会造成集群请求 403；小程序源码的可信名单也不包含该弃用域名。共同 issuer 和 Redis 不能替代共同票据 audience。配置应延续已核实的 Node 集群合同，不能只比较旧 Yii 的变量是否逐字相同。

首次接管时，从复制的运行时 ENV 中整理出只含应用/部署配置的 env 文件，完全移除 `GIT_COMMIT`、`BUILD_TIME`、`PATH`、`NODE_VERSION`、`YARN_VERSION` 这五个镜像自带变量，保留其余应用值。不要把它们设为空，也不要随新镜像手工填写新值。Dockerfile 为每个镜像提供自身的构建元数据和运行时默认值；复制旧值会覆盖新镜像，导致 `/health` 继续报告旧提交和构建时间，或固定旧镜像的运行路径/版本说明。完成这一次整理后，后续更新只需更换 `WECHAT_IMAGE`。

容器实际的 `Config.Env` 仍然会包含镜像默认变量；这不代表干净的 Compose env 文件又加入了覆盖。Portainer 的 Duplicate/Edit 会复制这些完整运行时变量，所以不能把原始运行时 ENV 列表直接用作以后永久复用的配置。后续镜像更新应使用清理后的 Compose env 文件或已经单次对齐的 Stack 应用环境，不再重复复制旧容器的镜像默认值。

| 参数 | 处理方式 |
| --- | --- |
| `WECHAT_IMAGE` | 两端使用同一个完整镜像引用；优先固定 digest，或固定已经核对 digest 的 `sha-<完整提交 SHA>` 标签。不要使用隐含 `main` / `latest` 默认值。 |
| `PUBLIC_ORIGIN` | 明确保留现有应用 origin，包括已有前端使用的路径；它可能与接管的 API 主机名不同，不能从路由域名自动推导。 |
| `WECHAT_ROUTE_RULE` | 每端都保留两个原 `x2` Host 别名，再加本端已获授权的 canonical Host；下方列出各自三个域名的完整规则。它只决定入口匹配，不改写 `PUBLIC_ORIGIN`。 |
| `WECHAT_ROUTE_ID` | 现有网络内唯一的路由/服务标识，例如 `wechat2-b0`、`wechat2-b1`。 |
| `WECHAT_ROUTE_PRIORITY` | 若迁移时并存新旧 router，明确设置高于所有重叠规则的优先级，包括既有 Node `x2` router 和 canonical router，而不只比较 Yii。现场原双 `x2` 规则的基线为 48，canonical 为 22；部署时以实际有效规则及显式优先级复核，不能使用低于原规则的新默认值或同优先级竞争。 |
| `BACKEND_NETWORK` | 本机已经存在且可连接原 MySQL、Redis、场景服务和 Traefik 的 Docker 网络名称。网络名可以不同。 |
| `WECHAT_ENV_FILE` | 本次部署实际可读取的环境文件；CLI 同时通过 `--env-file` 把同一文件用于 Compose 插值。 |
| `GAME_KEYS_VOLUME` | 本机已经存在的 Docker 外部命名密钥卷的完整名称，沿用当前 Node 服务挂载来源；以只读方式挂载到 `/run/game-keys`，不创建、复制或轮换密钥。 |
| `JWT_KEY_FILE` | 该卷内原业务 HS256 密钥的相对路径；`JWT_SECRET` 非空时会优先于 `JWT_KEY`，必须保留既有有效值，避免两个来源冲突。 |
| `ADMIN_JWT_KEY_FILE` / `ADMIN_JWT_PUB_KEY_FILE` | 该卷内既有管理端 EC P-256 私钥/公钥的相对路径；与 Yii 保持一致。 |
| `ADMIN_AUTH_ISSUER` / `ADMIN_SCAN_LOGIN_ORIGIN` | 当前两端均保留 `https://c.4mr.cn`；不能从本机 canonical API 主机名或旧 Yii 的弃用扫码站点推导。 |
| `SCENE_SERVER_BASE_URL` | 本环境现有场景服务地址；显式设置，避免源码中的 b0 默认地址被 b1 继承。 |
| `MYSQL_CHARSET` | 保留原连接字符集；现有 Yii 为 `utf8` 时保持 `utf8`，不因镜像升级转换数据库或数据。 |
| `GAME_DEV_AUTH` | 当前 b0、b1 均已获用户明确授权，分别保留 `1`。通用模板为新环境保留安全默认 `0`，不能把两端现有授权推广为其他环境的默认值。 |
| `TRUST_PROXY` | 当前两端保留已有值 `1`。`src/application.ts` 会把字符串 `1` 显式转为数值 1，Express 按一个 hop 处理；这不等于已经核验整条前端/Traefik 代理链的原始客户 IP。本文不扩大可信范围或推荐未经验证的 CIDR。没有可信代理的新环境可留空；字符串 `0` 不会被转成布尔 false。 |
| `TRAEFIK_ENTRYPOINT` | 沿用本环境已有 HTTPS 入口名称。模板仅设置 `tls=true`，继续使用已有默认 TLS 配置，不强加证书解析器。确需显式 resolver 的环境，可以额外增加该 router 的 `.tls.certresolver` label。 |
| `TRAEFIK_MIDDLEWARES` | 明确保留现有 middleware 列表及 provider 后缀，例如演示值 `example-compress@file`；没有自动推断或默认真实名称。 |

Node 应用只读取 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_CHARSET`、`MYSQL_POOL_SIZE`。`compose.image.yaml` 在 Compose 边界自动把旧 Yii 的 `MYSQL_DB` 映射为 `MYSQL_DATABASE`、`MYSQL_NAME` 映射为 `MYSQL_USER`；非空现代变量优先，同一参数的两个来源都缺失/为空时明确报错。可以保留复制来的旧别名及其余应用 env，无需手动重命名。直接运行 Node 或不用该 Compose 文件时，应用自身没有这两个别名回退，仍须提供现代变量。容器内 `127.0.0.1` 指向本容器，数据库/Redis 位于其他容器时必须沿用可从所选 Docker 网络访问的服务名和端口。

场景地址校验允许 HTTPS，或当前明确允许的内部 `http://y1-p:8080`，路径为空或 `/v1/server`。b1 若使用 HTTP 内部服务，需要在其网络内保留该既有别名；不能仅把地址换成任意 HTTP 容器名而假定能够通过校验。

业务 Redis 使用 `REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、`REDIS_PASSWORD`；非空 `REDIS_URL` 会优先确定实际连接，保留时应核对它与这些分项的关系。`ADMIN_AUTH_REDIS_HOST/PORT/DB/PASSWORD` 留空会继承业务配置；有独立认证 Redis 时保留全部原值和 DB 编号。设置任一专用认证 Redis 参数后，认证连接不再沿用 `REDIS_URL`，应把其余分项也明确填写。不能把业务或管理认证数据改到新空 DB。

微信/腾讯云现代变量及旧 Yii 别名的对应关系见 [集成说明](../src/integrations/README.md)。现代变量非空时通常优先于旧别名；不要把 `.env.example` 的演示路径或演示 URL 加入已有配置，遮蔽仍有效的旧值。支付 PEM、平台证书列表和商户证书所引用的每个路径都必须在容器内存在。只读卷内的文件继续使用原相对布局，并保留已经可用的 `/run/game-keys/…` 路径；密钥字节保持原样。

## 镜像部署模板

环境文件既供应用读取，也供 Compose 插值。不要仅填写 `env_file` 而遗漏 CLI 的 `--env-file`：前者不会自动为 `image`、网络、挂载和 labels 提供插值值。

直接使用仓库中的 [compose.image.yaml](../compose.image.yaml)，不要和用于本地构建的两个 Compose 文件叠加。参数省略时，镜像、origin、路由、网络、外部密钥卷和密钥文件名都会明确报错；通用设备认证策略保持 `GAME_DEV_AUTH=0`。

容器只在既有 Docker 网络上提供内部端口 8080，无 `ports`、无 `build`、无前端或附加基础设施。Dockerfile 已使用 `node` 用户和 `/health` 健康检查；不要覆盖成 root，也不要把服务绑定到容器内 loopback。镜像启动命令是 `node dist/main.js`，不会自动迁移。固定镜像且关闭 Watchtower，可避免此次人工切换之后又跟随其他浮动标签。

容器 UID 为 1000。卷内目录需要允许该身份遍历，所需文件需要可读；只读挂载本身不会赋予读取权限。部署前核对现有已成功运行的密钥卷和权限，不要盲目更改 Yii 原文件的所有者或把私钥设成所有人可读。外部卷缺失时应先核对环境和卷名；不要创建一个同名空卷，也不要重新运行历史 Stack 的 root 密钥准备任务临时掩盖问题。模板的 `external: true` 和 `nocopy: true` 保证不会把新卷或镜像目录作为密钥来源。

分环境配置可以保存在仓库外；以下示意文件名不要求固定目录：

```dotenv
# b0 文件；所有连接、凭据、provider 与管理配置仍从本环境现有配置保留。
WECHAT_ENV_FILE=./deploy/b0.env
WECHAT_IMAGE=registry.example.invalid/team/wechat2@sha256:<verified-digest>
PUBLIC_ORIGIN=https://frontend.example.invalid/api
WECHAT_ROUTE_RULE='Host(`x2.b0.01xr.com`) || Host(`x2.b1.01xr.com`) || Host(`x.b0.01xr.com`)'
WECHAT_ROUTE_ID=wechat2-b0
WECHAT_ROUTE_PRIORITY=<reviewed-priority-above-all-overlapping-routers>
BACKEND_NETWORK=<existing-network>
GAME_KEYS_VOLUME=<existing-external-named-key-volume>
JWT_KEY_FILE=<existing-relative-business-key>
ADMIN_JWT_KEY_FILE=<existing-relative-admin-private-key>
ADMIN_JWT_PUB_KEY_FILE=<existing-relative-admin-public-key>
TRAEFIK_ENTRYPOINT=<existing-https-entrypoint>
TRAEFIK_MIDDLEWARES=<existing-middleware-list-with-provider-suffix>
MYSQL_CHARSET=utf8
GAME_DEV_AUTH=1
TRUST_PROXY=1
```

b1 使用自己的文件、路由标识、优先级、网络和密钥卷；`WECHAT_IMAGE`、共同扫码 origin 和管理 issuer 相同，本端 `GAME_DEV_AUTH` 也明确保留已授权的 `1`。其完整 Host 规则为：

```dotenv
WECHAT_ROUTE_RULE='Host(`x2.b0.01xr.com`) || Host(`x2.b1.01xr.com`) || Host(`x.b1.01xr.com`)'
```

两个 `x2` 别名必须在每个 Node 都保留，才能同时服务前端转发、备用与故障切换；canonical Host 仅添加本端已获授权的一项。不加入 `x.4mr.cn` 或其他未获授权的 canonical 域名。除这些已核实的公开 Host 规则外，上面仍含占位值，必须替换为本环境既有配置，不能直接部署。含 `$` 的 bcrypt 哈希或其他秘密应按所用 env 文件/平台的字面量规则保存，避免 Compose 插值改变其字节；保留现有已验证的表达方式。

## Compose 操作与 Portainer 对应关系

现有 b0、b1 Node 容器分别位于各自 Docker 主机，保留的 Compose 标签均为 `project=wechat2`、`service=wechat2`。更新现有服务时，两台主机都沿用 `-p wechat2` 和服务名 `wechat2`，只切换本机对应的 env 文件。不要使用 `-p wechat2-b0` / `-p wechat2-b1` 创建平行项目；路由标识可以分环境命名，Compose 项目名应与当前管理身份一致。

下面命令是完成一次管理方式接管核对后的操作示例。现有业务容器曾经通过 Portainer 单独替换，仓库文件不会自动同步 Portainer 保存的 Stack 定义。首次改由 `compose.image.yaml` 管理时，应对照当前实际容器核对项目/服务标签、镜像、全部应用 env、镜像默认变量、只读卷、网络和路由所有权，并明确后续以文件还是已同步的 Stack 为管理来源。保留项目标签只是必要条件，不能据此声称已完成接管或 Stack 已同步。

在 b0 主机的仓库/部署目录准备本环境文件后，先运行 [部署预检查](../scripts/check-image-deployment.py)。需要 Python 3 与支持 `config --format json` 的 Docker Compose。工具只调用本仓库 `compose.image.yaml` 的 `config`，沿用当前操作环境及 `--env-file` 的正常 Compose 取值规则；不导出 env、不改输入文件、不拉取镜像、不调用 Docker daemon 或外部服务。`WECHAT_ENV_FILE` 仍须指向本次实际应用文件，与直接运行 Compose 时一致。

工具私下捕获 Compose 输出，只检查解析后的 `wechat2.environment`：发现上述镜像变量时只输出名称与数量，返回 1；参数、Compose 或 JSON 解析失败只输出通用错误，返回 2；没有镜像变量覆盖时返回 0。它不会显示变量值或原始错误。检查通过只证明解析配置没有这五项覆盖，不能证明镜像、远端密钥卷、权限、网络或外部服务可用。

```sh
python3 scripts/check-image-deployment.py --env-file ./deploy/b0.env --project-name wechat2
docker compose -p wechat2 --env-file ./deploy/b0.env -f compose.image.yaml config --images
docker compose -p wechat2 --env-file ./deploy/b0.env -f compose.image.yaml pull wechat2
```

生产镜像含已编译迁移与 SQL。只有确认本数据库需要升级、备份已核实且本次迁移已授权后，才使用同一镜像、同一连接配置执行普通迁移；已有业务库不能使用 `--bootstrap`：

```sh
docker compose -p wechat2 --env-file ./deploy/b0.env -f compose.image.yaml run --rm --no-deps --label traefik.enable=false wechat2 npm run migrate:prod
```

同一数据库只串行执行一次，不因两端共用镜像而重复创建迁移任务；镜像重启或普通版本升级也不自动运行它。一次性迁移容器关闭 Traefik 标签，不参与业务路由。对旧主线 schema 的本地演练结果及价格/设备映射限制见 [旧主线兼容性说明](LEGACY_MAIN_COMPATIBILITY.md)。

服务更新只针对这一个服务，保留已知可用的 Node 镜像引用、仅含应用/部署配置的 env 文件及挂载配置用于版本回滚：

```sh
docker compose -p wechat2 --env-file ./deploy/b0.env -f compose.image.yaml up -d --no-deps --no-build wechat2
docker compose -p wechat2 --env-file ./deploy/b0.env -f compose.image.yaml ps wechat2
```

b1 在 b1 主机执行，项目名仍为 `wechat2`，将 env 文件换成 `./deploy/b1.env`，其余命令一致。预检查的 `--project-name` 默认也是 `wechat2`。完成接管后，日后只更换经过验证的 `WECHAT_IMAGE`，重新运行预检查，再拉取与更新指定服务即可。不要加入 `--remove-orphans`，也不要执行不限定服务的整栈更新；同项目中的历史辅助容器不属于本次业务镜像更新范围。

Portainer 应选用户当前打开的目标环境及当前业务容器，以实际容器配置为准；历史 Stack 21 保存的旧镜像和辅助任务没有因为单容器替换而自动同步，不能直接点击旧 Stack 的更新/重新部署。仓库中的新文件是可审查的后续部署方案，不表示该 Stack 已更新。先保留现有环境、挂载、网络、labels 和回滚镜像，再按模板核对差异；如决定继续由 Stack 管理，应先完成其保存内容与当前业务配置的单次对齐，再执行限定范围的更新。

通过 Web Editor 部署时，必须使用该部署方式实际支持的环境文件：若平台提供 `stack.env`，将 `WECHAT_ENV_FILE` 设为 `stack.env`，并在 Stack 环境变量中保留应用变量及上述插值参数，排除五个镜像默认变量。仅在宿主机某目录放置文件，不代表 Portainer 的 Stack 工作目录能读取它。若当前部署方式无法提供 env 文件，就沿用已核对的显式 `environment` 映射，保留全部应用变量；不要删除它们后只留下模板中的少数覆盖项，也不要把旧镜像元数据重新写入 Stack。

既有 Stack 若还含备份、迁移、密钥准备等一次性服务，整栈重新部署可能重跑它们。镜像更新应限定到已核对的 Node 业务服务；不要顺便重新运行历史备份或密钥任务，也不要把新模板直接合并到未审查的辅助服务配置中。模板保留一项服务的原因是让下一次镜像更新同样可控。

首次入口切换为 Node 使用独立于 Yii 的 router/service 标识，保留 Yii router 和容器，供另行审阅的路由回退使用。已经切换的 Node 服务更新时，核对其现有全部路由，再合并为本端上面的三个 Host；不能遗漏原双 `x2` 规则。若管理接管必须暂时并存新的 Node router，其显式优先级必须高于所有重叠的旧 Node/Yii router，不能只高于 canonical 规则却低于原双 `x2` 规则。完成单次接管后沿用已确认的路由所有权，不另起同 Host、同优先级的平行 Node router。

本轮已在实际 f 环境通过 UI 读取运行时生成的 Nginx 配置，并在该前端容器内核验 DNS。统一前端已经使用两个 Node `x2` 入口：管理 API 按请求在 `x2.b0.01xr.com` 与 `x2.b1.01xr.com` 的池之间各分配 50%，每个池以另一端为 backup；小程序 API 以 `x2.b0.01xr.com` 为 primary、`x2.b1.01xr.com` 为 backup。管理池和小程序代理均使用共同的 `x2.b0.01xr.com` Host / TLS SNI，并开启 TLS 证书验证。前端容器 DNS 将两个上游解析到不同节点地址。

因此 b1 作为池目标或备用端也会收到 b0 的 `x2` Host；每端完整保留两个原 `x2` 别名是已经核实的运行要求。只核对每台服务器自身的 canonical 域名不能证明管理分流及小程序主备路径有效。前端配置、只读身份证明与当前验收范围见 [验证记录](VALIDATION.md)；不根据单次健康抽样推断全部故障切换或真实扫码登录已经验收。

版本回滚首选恢复已知可用的 Node 镜像及其应用配置文件，继续保留两端 `x2` 别名、网络、只读密钥卷与共同的 `https://c.4mr.cn` 扫码 origin/issuer。恢复的配置仍须排除旧镜像自带的五个环境变量，并通过部署预检查；随后核对实际入口健康及镜像身份。不要通过重新部署保存内容尚未同步的旧 Stack 执行回滚。

删除本轮新增的 `x.b0.01xr.com` / `x.b1.01xr.com` 五项 canonical 路由标签，只会回退相应 canonical 入口；f 前端仍通过 `x2.b0.01xr.com` / `x2.b1.01xr.com` 访问 Node 池。保留的 Yii 容器不是这些前端池的自动备用端。若要让前端整体退回 Yii，必须另行审阅 f 的管理池、小程序主备配置、`x2` 路由目标及共同扫码 origin，明确批准并实施对应路由修改，再验证 Host / TLS SNI、证书和跨节点票据连续性。仅删除 canonical 标签或停止一个 Node，不构成前端已退回 Yii 的证据。

切换后从本环境的真实 HTTPS 入口检查 `/health` 返回的提交 SHA、MySQL/Redis 健康状态，再验证管理登录、现有业务 Token、设备请求及支付通知入口。`PUBLIC_ORIGIN` 保留既有前端 origin，显式支付/退款回调与可信代理链分别核对；显式旧回调变量不会随路由主机名自动改变。已经执行的数据库 DDL 不随入口或镜像回滚自动撤销。

本文依据仓库现有 Dockerfile、Compose、迁移脚本及环境变量读取代码核对。模板的结构验证使用纯合成参数；本轮实际部署与环境核对见 [验证记录](VALIDATION.md)。此新文件尚未导入或同步 Portainer 保存的 Stack，不能用它推断平台保存内容已经与当前业务容器一致。后续管理接管仍需核对实际标签、配置和路由所有权。

`compose.image.yaml` 已用本机 Docker Compose 5.1.2 和纯合成参数执行 `config` 验证，覆盖新环境安全默认、显式免签，以及仅旧数据库变量、仅现代变量、两者冲突时现代变量优先的配置；检查了固定镜像、显式 origin、多别名路由、优先级、middleware、外部只读密钥卷、无宿主机端口、无构建及单服务结构。本地实际 Express / proxy-addr 合成链验证确认环境值 `1` 经当前代码转换后使用数值 hop 计数，直接传原字符串 `1` 并不等价。结构和代理语义检查均未连接 Docker daemon 或外部网络，不能代替实际部署和客户端验收。
