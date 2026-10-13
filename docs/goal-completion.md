# V2 / V3 / V4 目标完成记录

本记录说明 **4.0.4 的界面调整**及 V2 / V3 / V4 既有功能。新版按确定的桌面使用方式安排入口：经典侧栏保留，首页改为续费日历和 7 天内即将到期 / 逾期列表，“客户”放在“订阅”下方。4.0.4 已通过应用与桌面回归、构建及运行时准备，以及运行时、经营 / 同步 HTTP 和网页 / PWA 检查；成品界面和便携版维护验收尚待完成。下文按版本列出已确认结果与待验收项目。

V2、V3、V4 是目标阶段名称，功能整合在 4.x 中交付。常见桌面入口是首页续费日历 `/`、订阅 `/spaces` 和客户 `/customers`，均使用经典侧栏。订阅页面继续保留紧凑主列表、按需展开详情及 Business / Pro 汇总布局。高级网页工作区 `/workspace` 和原运营 API 保留，用于网页 / PWA、协作及完整账务操作。

## V2：管好日常订阅

| 原目标 | 已实现的行为与入口 | 关键源码及回归证据 |
| --- | --- | --- |
| 通用订阅中心 | 桌面继续使用经典订阅列表及现有套餐；高级网页保留通用服务、套餐模板、标签、分组和自用 / 出租视图 | [经典订阅页](../src/app/(protected)/spaces/page.tsx)、[高级工作区](../src/components/workspace/workspace.tsx)；[OperationsStore.save](../src/db/operations.ts)；[模板容量及自用回归](../src/db/operations.test.ts) |
| 客户档案 | 经典侧栏“订阅”下新增客户入口，集中管理客户记录；客户与多条租赁、联系资料和历史的关系保留 | [经典侧栏](../src/components/nav/sidebar.tsx)、[客户页](../src/app/(protected)/customers/page.tsx)；[运营记录类型](../src/lib/operations/types.ts)；[同客户多位置与生命周期用例](../src/db/operations.test.ts) |
| 账号与成员关系 | 订阅、登录账号 / 位置、租赁、客户分别保存，使用稳定 ID；旧记录保留来源映射 | [旧记录映射](../src/lib/operations/legacy.ts)、[关系及历史约束](../src/db/operations.ts)；[稳定旧 ID、母号归并及 Pro 迁移用例](../src/db/operations.test.ts) |
| 租期管理 | 加入、续租、退出和换号保存历史；停用保留原因和审计。续租生成账期，实际收款另行登记 | [join / renewRental / exitRental / rental.switch / disable](../src/db/operations.ts)；[完整生命周期和重复续租用例](../src/db/operations.test.ts)、[历史占位验收](../src/lib/workspace/acceptance-audit.test.ts) |
| 今日工作台 | 桌面侧栏移除独立工作台入口，首页提供订阅及有效租赁的续费日历、7 天内即将到期和逾期列表；高级网页仍保留待收款及闲置位置视图 | [首页](../src/app/(protected)/page.tsx)、[经典侧栏](../src/components/nav/sidebar.tsx)、[续费日历规则](../src/lib/workspace/renewal-calendar.ts)；[日历边界及母号 / Pro 映射回归](../src/lib/workspace/renewal-calendar.test.ts)、[可用位置回归](../src/lib/workspace/view-model.test.ts) |
| 高效操作 | 桌面从日历及到期列表进入对应订阅；高级网页保留全局搜索、批量续租及位置状态调整，批量操作遇冲突整批回滚 | [首页](../src/app/(protected)/page.tsx)、[高级网页操作](../src/components/workspace/workspace.tsx)；[renewal.batch / status.batch](../src/db/operations.ts)；[批量事务及日历用例](../src/db/operations.test.ts) |
| 桌面使用完善 | 托盘运行、系统通知、备份恢复入口和升级前恢复点；恢复先校验，失败可回滚 | [桌面菜单与托盘](../desktop/main.js)、[ReminderManager](../desktop/reminders.js)、[BackupManager](../desktop/backups.js)；[桌面运行回归](../desktop/tests/runtime.test.cjs)、[备份与通知回归](../desktop/tests/backups.test.cjs) |

V2 发布验收中的“新增客户 → 分配账号 → 续租 → 退出 → 查看历史”、稳定编号、重复操作不重复续期、旧记录可追溯均有回归覆盖。备份用例核对数据库完整性、账户、金额、登录及 MFA 配置，覆盖损坏包拒绝、恢复失败回滚、升级暂存验证和旧版客户端降级阻止。真实桌面表单与重启检查由 [ui-smoke.js](../desktop/ui-smoke.js) 实现；本记录不将旧版本的成品结果当作新安装包已重新验收。

## V3：看清经营收益

| 原目标 | 已实现的行为与入口 | 关键源码及回归证据 |
| --- | --- | --- |
| 统一收款与应收对账 | Business 母号、子账号及 Pro 成员通过同一租赁 / 账单模型关联客户和账期；分别显示应收、实收、未收，支持部分收款和补款 | [issueBill / receive](../src/db/operations.ts)、[billSummary](../src/lib/workspace/bill-summary.ts)；[分次收款与余额回归](../src/db/operations.test.ts)、[账单显示回归](../src/lib/workspace/bill-summary.test.ts) |
| 支出记录与调整处理 | 购买及续费支出保存原币、手续费和服务期；退款引用原收款，退租保留租赁历史，优惠和作废保留原因 | [cost / refund / bill.discount / void](../src/db/operations.ts)；[退款、优惠、作废及年付费用回归](../src/db/operations.test.ts)、[独立账务验收](../src/lib/workspace/acceptance-audit.test.ts) |
| 经营报表 | 按日期、订阅、客户和渠道查看预计收益、现金结余、按期经营收益及欠款；来源行可打开原记录 | [buildOperationsReport](../src/lib/operations/report.ts)、[工作区经营分析](../src/components/workspace/workspace.tsx)；[客户成本份额、截点应收和汇率回归](../src/db/operations.test.ts) |
| 当前估算与历史汇率 | 五分钟刷新影响当前估算；自动报表刷新沿用最后一次成功计算的筛选条件。已确认收支与账单保留冻结金额和汇率 | [汇率调度](../src/lib/fx/scheduler.ts)、[ReportSession](../src/lib/workspace/report-session.ts)；[筛选和异步刷新回归](../src/lib/workspace/report-session.test.ts)、[历史冻结回归](../src/db/operations.test.ts) |
| 定价与拼车测算 | 比较收费、保本单价、保本规模及空闲位置影响，测算不写账本 | [calculatePricing](../src/lib/operations/report.ts)、[工作区 Pricing](../src/components/workspace/workspace.tsx)；[手续费及占用容量用例](../src/db/operations.test.ts) |
| 分摊规则 | 按实际服务日、固定金额或位置权重分摊；年付成本按天归属，各月可对账，空置成本保留归属 | [allocateCostToRentals](../src/lib/operations/report.ts)、[金额及周期工具](../src/lib/operations/utils.ts)；[年度、固定权重、固定金额和换号分摊回归](../src/db/operations.test.ts)、[历史区间验收](../src/lib/workspace/acceptance-audit.test.ts) |
| 数据交换 | 客户、订阅、收款 CSV 模板、预览、重复检测、整批提交、错误报告及明细导出；错误行号对应源文件物理行 | [CSV 解析与预览](../src/lib/workspace/csv.ts)、[importRows](../src/db/operations.ts)；[跨行、空行及重复过滤回归](../src/lib/workspace/csv.test.ts)、[原子导入回归](../src/db/operations.test.ts) |

三种口径分别核对，不能相加作为“总收益”：预计收益使用当前约定收入和折算成本；现金结余使用实际收付；按期经营收益使用归属服务期的收入和成本。分次付款、跨月服务期、年付费用、退款、客户成本份额和历史汇率不变已有回归证据，详细规则见 [运营模型与账务规则](operations-model.md)。

## V4：支持跨设备与协作

| 原目标 | 已实现的行为与入口 | 关键源码及回归证据 |
| --- | --- | --- |
| 多设备同步 | 自建中心交换业务记录、命令及变更，不同步运行中的 SQLite 文件；稳定设备 ID、明确初始化方向、版本冲突和幂等重试 | [OperationsSync](../src/lib/operations/sync.ts)、[HTTP 契约](../src/lib/operations/http.ts)；[同步回归](../src/lib/operations/sync.test.ts)、[真实双进程验收](../scripts/smoke-sync.cjs) |
| 断网恢复 | 浏览器请求失败时将操作存入 IndexedDB；连接中心的本机服务把未确认操作存入 SQLite 队列，中心确认前不伪造收款。管理员可检查队列、填写原因取消，或断开已无待处理操作的中心 | [浏览器离线存储](../src/lib/workspace/offline.ts)、[同步队列](../src/lib/operations/sync.ts)、[工作区设备页](../src/components/workspace/workspace.tsx)；[离线、丢失确认及撤销回归](../src/lib/operations/sync.test.ts)、[真实断网 / 重启验收](../scripts/smoke-sync.cjs) |
| 手机网页 / PWA | 手机适配工作区、应用 manifest 和公开程序壳缓存已实现；真实 UI 验收验证同一已认证会话离线读取及新窗口缓存隔离 | [工作区样式](../src/components/workspace/workspace.css)、[manifest](../src/app/manifest.ts)、[Service Worker](../public/operations-sw.js)；[程序壳缓存回归](../src/lib/operations/pwa.test.ts)、[真实界面验收](../scripts/smoke-workspace-ui.cjs) |
| 协作权限 | admin、operator、read-only 服务端权限检查；签发、到期及撤销成员凭证，Bearer 身份不借管理员 Cookie 提权 | [OperationsAccessStore 与角色检查](../src/lib/operations/access.ts)、[HTTP 端点](../src/lib/operations/http.ts)；[权限回归](../src/lib/operations/http.test.ts)、[安全回归](../src/lib/operations/security.test.ts)、[只读设备真实验收](../scripts/smoke-sync.cjs) |
| 客户入口 | 客户仅查看绑定客户自己的账期和收付状态，其他客户、库存、成本及内部备注不进入响应 | [filterOperationsSnapshot](../src/lib/operations/access.ts)；[快照、变更和报表隔离回归](../src/lib/operations/http.test.ts)、[客户隔离及撤销真实验收](../scripts/smoke-sync.cjs) |
| 外部数据接入 | 提供管理员受控的 CSV 和 import 接口，验证大小、字段、权限、重复和整批事务；具体外部服务适配未列为已完成 | [import 接口](../src/lib/operations/http.ts)、[importRows](../src/db/operations.ts)；[导入和输入边界回归](../src/lib/operations/http.test.ts)、[导入事务回归](../src/db/operations.test.ts) |
| 操作追溯 | 记录执行者、操作、关联记录及原因；冲突保留两方内容，明确选择后写审计，队列取消不删除已确认账务 | [业务审计](../src/db/operations.ts)、[权限和同步审计](../src/lib/operations/access.ts)、[冲突决议](../src/lib/operations/sync.ts)；[审计与冲突回归](../src/lib/operations/sync.test.ts)、[真实显式决议验收](../scripts/smoke-sync.cjs) |

离线私有快照仅供同一次已联网认证的浏览器会话使用；首次使用或新会话需联网验证身份。缓存会话与当前身份绑定，成员缓存还绑定当前成员凭证，不能仅靠旧的持久身份标识读取。身份切换会使旧请求失效，登出清除离线资料。对应 [cache-session](../src/lib/workspace/cache-session.ts)、[身份作用域](../src/lib/workspace/identity.ts) 和各自回归测试。

同步中心支持自行部署，但目前没有获得授权的用户服务器或域名用于实际部署，因此不宣称已完成公网 TLS、反向代理和跨设备生产部署验收。部署步骤见 [同步与权限](sync-and-permissions.md)。HTTPS 保护传输，本机连接凭证加密保存；中心能读取托管账本。目标中可选的端到端加密尚未实施，不能将本机凭证加密称为账本端到端加密。

## 4.0.4 桌面界面调整

- 首页由仪表盘改为续费日历，并在同页列出未来 7 天内即将到期和逾期项目。
- 经典侧栏保留，“今日工作台”独立入口移出常见桌面流程，“客户”新增在“订阅”下方。
- 订阅页原有紧凑列表、展开详情及 Business / Pro 汇总布局保留。
- 客户记录、租赁历史、账务、同步及权限能力继续保留；高级网页工作区仍可按原路径使用。

这些调整以用户确定的入口和布局为准。日历规则的定向回归已验证订阅及有效母号 / 子账号 / Pro 成员的到期事项、同邮箱母号归并、查询及日期边界，完整应用回归也已通过。经典首页、嵌入客户页、桌面启动及成品兼容检查按本版本单独验收，并在 CI 与发布流程中要求三项新版界面检查全部出现。

## 4.0.3 已有修复

- 闲置位置必须属于存在且有效的订阅，停用和缺失订阅的候选被排除。
- 作废账单显示作废状态，实际净收款独立从有效收款 / 退款计算，不因未收归零而显示为已经收款。
- CSV 错误定位保留原始物理行号，包括空行、过滤重复及引号内跨行字段。
- 经营分析自动刷新沿用已计算的筛选条件，较旧异步响应不能覆盖更新的计算结果。
- 离线私有缓存绑定当前已认证会话和成员凭证，防止新会话使用旧身份读取缓存。
- 设备页补齐未确认队列检查、原因取消和断开入口，并按中心凭证权限限制写入及冲突选择。

对应回归见 [view-model](../src/lib/workspace/view-model.test.ts)、[bill-summary](../src/lib/workspace/bill-summary.test.ts)、[csv](../src/lib/workspace/csv.test.ts)、[report-session](../src/lib/workspace/report-session.test.ts)、[cache-session](../src/lib/workspace/cache-session.test.ts) 及 [HTTP 权限](../src/lib/operations/http.test.ts)。

## 4.0.3 已确认的历史验收

| 验收 | 已确认结果 | 范围说明 |
| --- | --- | --- |
| 4.0.3 应用回归 | 55 个测试文件、364 个用例通过 | 运营模型、账务、迁移、导入、汇率、权限、同步和纯视图 / 缓存规则；不等同于所有界面的人工验收 |
| 4.0.3 桌面回归 | 40 个用例通过 | 本机配置、运行时、权限、备份恢复、版本保护和系统通知；使用合成测试资料 |
| 4.0.3 准备后的运行时 | 桌面运行时烟雾检查通过 | [smoke-runtime.cjs](../scripts/smoke-runtime.cjs) 在合成资料下验证受保护页面、登录和服务重启后的数据保留 |
| 4.0.3 经营 HTTP | 25 次 API 请求通过 | [smoke-operations.cjs](../scripts/smoke-operations.cjs) 验证租赁生命周期、重试、部分收款 / 退款、历史汇率冻结及客户隔离 / 撤销，并检查公开页面壳不含账本 |
| 4.0.3 真实同步 HTTP | 60 次请求通过 | 两份独立合成 SQLite 账本和两个实际 Node 服务；明确上传 / 下载、中心停服、客户端重启保留队列、中心原库重启、收款只确认一次、同 ID 重试、显式冲突、只读和客户隔离 / 撤销 |
| 4.0.3 网页 / PWA 关键界面 | 4 项真实 UI 检查通过 | 作废账单实收为零并显示作废；汇率变化后刷新报表且保持已应用筛选；停服后同一已认证会话离线读取；新窗口共享旧身份标识和缓存但没有认证标记 / 凭证时拒绝读取。使用独立合成资料和真实页面，不等同于所有手机浏览器兼容性验收 |
| 4.0.3 成品桌面界面 | 10 项流程通过，无控制台错误 | 首次免密进入、客户 / 订阅 / 分配 / 续租 / 部分收款表单、租期历史、服务及窗口重启后的身份和数据保留；窗口隐藏且使用独立合成资料 |
| 4.0.3 便携成品维护 | 通过 | 成品健康检查、免密身份、版本一致、本机加密备份、恢复及回滚恢复点 |
| 外部中心部署 | 未开展 | 尚无获授权的服务器 / 域名；本机回环 HTTP 不替代公网部署验收 |

真实同步脚本通过 `npm run desktop:sync-smoke` 运行；真实界面脚本见 [smoke-workspace-ui.cjs](../scripts/smoke-workspace-ui.cjs)。4.0.3 的本机构建、打包及成品验收结果保留在此作为历史记录。检查使用独立合成账本，并已加入 CI 与发布流程；4.0.4 的结果单独记录。

## 4.0.4 验收进度

| 验收 | 当前记录 |
| --- | --- |
| 续费日历规则回归 | 8 项定向用例通过，见 [renewal-calendar.test.ts](../src/lib/workspace/renewal-calendar.test.ts)；已包含在完整应用用例数中 |
| 完整应用回归 | 56 个测试文件、372 个用例通过 |
| 桌面回归 | 40 个用例通过 |
| 应用构建及桌面运行时准备 | 通过 |
| 桌面运行时烟雾检查 | 通过；独立合成资料下核对登录、受保护页面及重启后的数据保留 |
| 经营 HTTP | 25 次 API 请求通过 |
| 真实同步 HTTP | 60 次 API 请求通过；使用两份独立合成账本与实际 Node 服务 |
| 高级网页 / PWA 关键界面 | 4 项检查通过；使用独立合成资料验证账单状态、当前估算刷新及会话离线缓存隔离 |
| 成品桌面打包 | Windows 安装版 / 便携版打包通过 |
| 经典首页、侧栏、客户及重启流程 | 13 项成品流程通过，无控制台错误；包括侧栏顺序、客户表单、日历账号、即将到期 / 逾期、搜索、月份切换及重启后的数据保留 |
| 成品维护、加密备份与恢复 | 便携成品健康、免密身份、版本、本机加密备份、恢复及回滚检查通过 |

## 4.0.6 续费状态与历史

日历表格新增“已续费”，按原到期日延长一期；原期保留绿色历史，下一期另列，月份内同时显示已续和待续事项。经典页面的明确续费按钮也保存历史，普通日期编辑不推断为已续费。费用、联系人、账号与所属订阅的历史快照保留；后续经典编辑继续更新当前资料。成员续期不生成实际收款。

关键回归见 [续费事务](../src/db/calendarRenewal.test.ts)、[经典续费历史](../src/db/classicRenewalHistory.test.ts)、[日历显示](../src/lib/workspace/renewal-calendar.test.ts)。本版通过 58 个应用测试文件的 420 个用例、40 个桌面用例、14 项真实成品界面流程（无控制台错误），以及运行时持久化、25 次经营接口请求、60 次双实例同步请求和 4 项网页 / PWA 检查。原生流程验证双击、同一命令重放、原期和下一期并存、刷新与重启后的保留。

公开完成记录只列功能、源码和合成验收范围，不包含用户账本、使用规模、联系资料或本机备份位置。
