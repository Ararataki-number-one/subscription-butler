# 多设备与协作

经营工作台位于 `/workspace`。旧版订阅页面继续使用原有登录会话；成员凭证只用于经营和同步 API，不会获得旧版页面或 SMTP 设置的访问权。

## 身份与范围

| 身份 | 可读内容 | 可写内容 |
| --- | --- | --- |
| 本机管理员 / admin | 完整经营账本与审计 | 经营操作、受控导入、邀请撤销、同步连接和冲突选择 |
| operator | 完整经营账本、业务审计和同步状态 | 经营操作、拉取、发送已授权队列；不能签发权限、导入记录包或更换中心 |
| read-only | 经营账本和报表 | 无 |
| customer | 绑定客户自己的账期、收款与退款 | 无 |

客户响应不包含其他客户、账号库存、订阅购入成本、支付渠道或内部备注。客户端隐藏按钮之外，每一个 API 都在服务端检查角色。有效 `tam_session` 登录会话对应本机管理员；若请求同时携带成员 Bearer 凭证，始终以成员身份处理，凭证失效不会回退管理员权限。

旧版 29 个账本业务 Server Actions 和 3 个 MFA 管理操作也在函数入口独立校验管理员会话，拒绝成员 Bearer 回退 Cookie。它们不依赖调用页面或 middleware 已通过检查，公开登录页和工作台不能借全局 Action ID 绕过权限。登录、MFA 登录验证和退出会话仍沿用自己的认证流程。

管理员在工作台签发成员凭证，选择角色及客户范围。原始凭证只在创建时显示一次，后续列表仅显示名称、角色、范围和有效期。服务器只保存 SHA-256 哈希，撤销或到期立即禁止新请求；未发送的已撤销成员操作也不会提交到中心。不要把凭证放进 URL、截图或公开 Issue。

在浏览器验证成员凭证成功时，会清除该浏览器原本的管理员会话 Cookie。选择成员身份后，访问旧版页面需要重新输入本机访问密钥；无效凭证或匿名读取不会清除原会话，也不会回退管理员权限。

## 同步中心

中心就是一套正在运行的订阅管家，不依赖第三方云服务。团队使用自己的 HTTPS 域名与受信任反向代理。只有管理员可以设置目标地址和中心签发的成员凭证；地址不允许用户名、密码、查询串或重定向。开发测试的 HTTP 只允许显式勾选的 `127.0.0.1`、`localhost` 或 `::1` 回环地址。

连接先验证中心身份和权限，再把连接凭证使用本机 `APP_AUTH_SECRET` 派生密钥的 AES-GCM 加密保存。连接本身不会上传已有账本：首次使用需明确选择“上传本地初始化”或“从中心下载”。初始化上传使用逐记录创建版本检查，已存在同 ID 的记录不能被覆盖。

传输的是经营记录、命令和变更日志，不是 SQLite 文件。登录配置、成员凭证表、SMTP 配置和本机环境文件不进入记录同步包。HTTPS 保护传输；中心服务仍可以读取它托管的账本，并按角色过滤内容。本版本提供自托管 relay 模式，没有声称对中心运营者隐藏账本。

## 离线队列与冲突

每台设备拥有保存在本机数据库里的稳定 ID。每个操作使用稳定命令 ID，中心事务提交后保留幂等结果；网络在提交后丢失响应时，重试同一 ID 不会重复收款、续期或退款。

后台服务器每 60 秒自动发送队列并拉取已授权记录；失败后逐次退避，最长 15 分钟，成功后恢复 60 秒周期。同一设备的拉取与发送保持单次执行，窗口最小化到托盘时仍可同步，不依赖浏览器触发“重新上线”事件。构建与测试不会启动这个后台定时器。

未连接中心时，经营操作直接写本地账本。连接后中心是权威账本；网络不可用时把操作保存在持久待发送队列，界面显示待同步。中心确认前不会把离线意图伪装为已确认金融记录。页面的 IndexedDB 队列和快照按已认证 `actor.id` 隔离；登出清除两类数据与会话凭证。

更新已有记录需要 `expectedRevision`；续期还需 `expectedPeriod`。冲突保留本地与远端内容，管理员明确选择保留哪一方后再次执行版本检查并写审计。已登记金融记录的金额、冻结汇率和原始账期不能借同步改写；错误账务需要使用作废、退款或冲正的业务操作。未发送操作可由管理员填写原因后取消，取消不会删除已确认账务。

PWA 只缓存确认公开、无账本数据的精确 `/workspace` 页面壳和本次构建的静态资源；API、登录页、旧版服务端页面、请求查询变体和用户账本响应不会进入 CacheStorage。离线冷启动可以加载工作台壳，但私有快照只供当前已经认证的会话身份使用；没有身份时不会展示其他人的缓存。

## 自托管运行

在服务器安装仓库锁定的 Node.js 与依赖，准备独立的持久数据库。使用本机生成的随机 `APP_AUTH_SECRET`、访问密钥的 SHA-256 `APP_LOGIN_KEY_HASH`，设置 `DB_FILE_NAME` 指向持久目录。不要使用示例密码或把配置提交到 Git。

```powershell
npm ci
npm run db:migrate
npm run db:seed
npm run build
npm start -- -H 127.0.0.1 -p 3000
```

反向代理以 HTTPS 服务该进程，保留 Host 与协议转发信息，并将环境变量 `OPS_PUBLIC_ORIGIN` 设置为唯一公开 HTTPS origin，例如 `https://ledger.example.com`，用于管理员 Cookie 写请求的 CSRF 校验。公网使用安全 Cookie，不能沿用桌面回环服务的 `APP_ALLOW_INSECURE_COOKIES=true`。域名、TLS、备份、访问范围和运行进程由自托管者管理；本功能不会自动部署或把账本发送到未配置地址。

用中心管理员登录后创建各成员或设备凭证。在另一台设备的同步设置中输入中心 HTTPS 地址与凭证，验证连接，然后选择初始化方向。备份仍需保留本机数据及安全配置；更换本机密钥后需要重新设置同步连接凭证。

客户使用中心自己的 `/workspace` 页面与客户凭证查看账期，不以客户凭证初始化完整设备账本。设备同步使用 admin、operator 或 read-only 凭证；只读设备可以拉取，但不能建立写入队列。

## API 契约

所有响应 `Cache-Control: no-store`。读取需要有效登录 Cookie 或 `Authorization: Bearer <成员凭证>`。Cookie 写入需匹配当前 origin 或配置的公开 HTTPS origin；Bearer 请求不依赖浏览器环境权限。错误返回 `{ok:false,error:{code,message}}`，不会返回 SQL、堆栈或本机秘密。

| 接口 | 内容 |
| --- | --- |
| GET `/api/operations/snapshot` | `{actor,snapshot,quotes}` |
| GET `/api/operations/report` | `from/to/subscriptionId/customerId/channelId` 筛选；`{actor,report}` |
| POST `/api/operations/commands` | `{id,type,payload}`；已有记录使用 `payload.expectedRevision` |
| POST `/api/operations/import` | 管理员受控 `import.commit` 命令，最多 5 MiB |
| GET / POST `/api/operations/access` | 管理员凭证列表或签发 `{label,role,customerId?,expiresInDays?}` |
| DELETE `/api/operations/access/:id` | 管理员撤销凭证 |
| GET `/api/operations/audit` | 业务审计；管理员另含权限/同步审计 |
| GET `/api/sync/changes?cursor=N` | 角色过滤的变更、当前记录快照、变更游标与设备 ID |
| POST `/api/sync/push` | `{deviceId,commands:[...]}`，最多 100 命令；记录包导入仅管理员 |
| GET `/api/sync/status` | `{deviceId,connected,url?,remoteRole?,cursor,pending,conflicts}`，没有原始 token |
| POST / DELETE `/api/sync/connect` | 管理员连接 `{url,token,allowLoopback?}` 或断开 |
| POST `/api/sync/bootstrap` | 管理员明确 `{direction:'upload'|'download'}` |
| POST `/api/sync/pull` / `/api/sync/flush` | 拉取记录，或重试待发送队列并拉取 |
| GET `/api/sync/conflicts` | 未解决冲突的本地/远端内容 |
| POST `/api/sync/conflicts/:id/resolve` | 管理员 `{choice:'local'|'remote'}`，带审计 |
| GET `/api/sync/outbox` | 待发送/冲突操作列表 |
| POST `/api/sync/outbox/cancel` | 管理员 `{ids:[...],reason}` 取消未确认操作 |

普通命令请求最多 512 KiB，连接与邀请最多 8 KiB，同步记录包最多 5 MiB。限制按实际读取字节实施，不依赖客户端 Content-Length。

`src/lib/operations/sync.test.ts` 使用两个独立 SQLite 账本和真实 Request/Response API 仿真传输，验证记录交换、离线恢复、丢失确认后的幂等重试、版本冲突与明确选择。`http.test.ts` 覆盖所有新端点的匿名、角色、撤销、客户隔离、CSRF、受控导入大小与错误脱敏。
