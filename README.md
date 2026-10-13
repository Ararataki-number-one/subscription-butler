# 订阅管家 · Subscription Butler

一个以 Windows 本地使用为主的订阅经营软件，管理通用服务、ChatGPT Business、Pro 拼车、客户、租期、收支对账和到期事项。金额以人民币为主，同时显示美元参考值。也提供手机 PWA 和自行部署 HTTPS 中心的多设备同步。

[下载 Windows 版本](https://github.com/Ararataki-number-one/subscription-butler/releases/latest) · [运营工作区](docs/workspace-usage.md) · [桌面备份](docs/desktop-maintenance.md) · [同步与权限](docs/sync-and-permissions.md) · [开发与构建](docs/development.md)

## 能做什么

- **客户与租期**：客户档案关联多个账号或成员，保存加入、续租、退出和换号历史；续租与收款分开，重复或过期操作不会把租期推进两次。
- **今日工作台**：集中处理到期、待收款、逾期与闲置位置，支持全局搜索、日历、批量续租及状态调整。通用服务、套餐模板、标签、分组和自用/出租视图均可使用。
- **经营账本**：统一账期应收、部分收款、补款、购买费用、退款、优惠及作废。区分预计收益、实际现金结余、按期经营收益，报表可追到每一笔来源；包含定价和分摊测算、CSV 预览导入及明细导出。
- **桌面维护**：托盘后台运行、系统到期通知、本机加密备份、验证恢复及升级前恢复点。数据和安全配置与 EXE 分开保存。
- **多设备与权限**：记录与变更同步、离线队列、幂等重试和明确冲突处理；管理员、运营、只读和仅自己账期的客户入口。同步中心自行部署，软件不会默认上传到第三方服务。
- **Business 账号管理**：管理母号和子账号的出租资料、联系方式、备注、约定收费、付款日与续费。同邮箱的出租记录归到母号，避免重复计算收入。
- **Pro 拼车管理**：只管理实际拼车成员，记录每人的收款和续费，不额外生成一个主账号出租席位。
- **支付渠道列表**：管理常用渠道、归档状态、关联订阅与费用；手续费只填百分比，自动计入订阅总成本。
- **当前成本与收益**：程序运行期间，每 5 分钟检查汇率并重算当前订阅成本、约定收入和预计收益；已登记的实际收款保留当时的记账金额。
- **到期提醒**：显示订阅到期与成员付款状态，可在设置中配置 SMTP 邮件提醒。
- **本地数据与访问验证**：使用 SQLite 保存数据，支持访问密钥、身份验证器双因素认证，以及当前 Windows 账户加密保存登录密钥。

## 开始使用

1. 从 [Releases](https://github.com/Ararataki-number-one/subscription-butler/releases/latest) 优先下载 `SubscriptionButler-版本号-Setup-Windows-x64.exe` 并安装；安装后从固定目录启动。
2. 双击启动，桌面版打开即进入工作区，内部安全配置自动生成。发布版本已包含运行环境，无需另装 Node.js 或 Git。
3. 在今日工作台新增客户、订阅和可用位置，再分配给客户或登记自用。
4. 续租后在“收支对账”登记实际收款，购买支出也单独记账；在“经营分析”核对各口径及来源。现有 Business/Pro 记录会保留来源映射迁移到工作区。

软件面向 Windows x64。数据保存在当前 Windows 用户的应用数据目录，与可执行文件分开；版本变化时自动生成升级前备份。公开源码和发布包不包含任何个人账本、联系人或登录密钥。本机备份绑定原 Windows 用户；跨设备使用业务记录同步，本机密钥和 SMTP 不同步。

## 金额如何计算

订阅总成本为原币订阅金额加支付手续费，手续费按渠道填写的百分比计算，并按币种精度取整。当前成本和约定收入按最近一次成功取得的汇率折算，再用于预计收益计算。

“报价日期”表示来源的汇率日期，“最近检查时间”表示软件获取数据的时间。每 5 分钟检查一次不代表上游每 5 分钟发布一笔新报价。网络暂时不可用时继续使用最近一次成功保存的汇率。

实际收款属于历史记录，汇率刷新不会改写这笔收款当时的折算值。详细口径见 [使用说明](docs/usage.md)。

## 开发

使用 Node.js **24.18.x**，依赖以两个 `package-lock.json` 为准。完整步骤见 [开发与构建](docs/development.md)。

```powershell
npm ci
npm --prefix desktop ci
npm test
npm run desktop:test
npm run desktop:package
npm run desktop:smoke
npm run desktop:operations-smoke
```

桌面打包会构建页面、准备本地服务及运行环境，并生成 Windows x64 可执行文件。GitHub Actions 检查主分支和 Pull Request；推送与版本号一致的 `v*` 标签时构建发布包、生成 SHA-256 校验文件并发布到 Releases。见 [发布流程](docs/releasing.md)。

## 开源来源

本项目基于 [Userchenentao5/team-account-manager](https://github.com/Userchenentao5/team-account-manager) 改造，增加了“订阅管家”品牌、独立桌面运行与面向出租运营的功能。原项目使用 Apache License 2.0；本仓库保留 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)，原有代码的许可和归属继续适用。
