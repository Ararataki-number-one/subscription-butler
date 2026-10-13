# 开发与构建

## 环境

桌面版本在 Windows x64 上构建，开发使用 Node.js **24.18.x**。GitHub Actions 固定为 **24.18.0**，与打包内置的 Node 运行环境保持一致。应用依赖和桌面依赖分别锁定在根目录及 `desktop/` 的 `package-lock.json` 中。

```powershell
npm ci
npm --prefix desktop ci
```

## 页面开发

复制 `.env.example` 为本地 `.env.local`，设置 `APP_AUTH_SECRET` 和 `APP_LOGIN_KEY_HASH`。前者使用随机密钥，后者是访问密钥 UTF-8 内容的 SHA-256 十六进制值。可用以下命令分别生成随机值和计算哈希；在哈希命令中替换示例文本，不要把真实密钥写入源码。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').createHash('sha256').update('replace-with-your-login-key').digest('hex'))"
```

`APP_MFA_ISSUER` 可设为 `订阅管家`，`APP_MFA_ACCOUNT_NAME` 为身份验证器中显示的本地账户名称。

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

页面服务默认使用本地 `data/app.db`，可用 `DB_FILE_NAME` 指定开发数据库。`.env.local`、数据库、日志和桌面个人配置不应提交。

## 验证

```powershell
npm run lint
npm test
npm run desktop:test
npm run build
```

测试覆盖数据库查询、账号归并、付款日期、手续费、汇率刷新及当前金额重算等逻辑。构建前后不要把个人数据库用作测试输入。

## 桌面打包

```powershell
npm run desktop:package
npm run desktop:smoke
```

`desktop:package` 构建 Next.js 页面和本地服务，准备独立运行所需的文件，并通过 Electron Builder 生成 Windows x64 portable 可执行文件。输出位于 `desktop/dist/`，命名为 `SubscriptionButler-版本号-Windows-x64.exe`。

`desktop:smoke` 在打包准备的运行环境中创建独立测试配置和空白数据库，以合成登录会话访问仪表盘、订阅、支付渠道和设置页；写入合成渠道并重启服务，核对数据保留。测试数据位于被忽略的 `test-artifacts/` 中，不读取个人账本。

发布包包含运行环境、页面、本地服务、数据库迁移和初始币种；首次运行在当前用户的数据目录创建空白账本和登录配置。包中应保留 `LICENSE`、`NOTICE` 及运行环境的第三方许可，不应携带开发数据库、环境文件或用户配置。

## 持续集成

- `.github/workflows/ci.yml` 检查主分支和 Pull Request：锁定依赖安装、静态检查、测试、页面构建，以及 Windows 桌面打包和成品启动检查。
- `.github/workflows/release.yml` 在推送版本标签时验证版本号，执行测试、打包和成品启动检查，生成校验文件后上传发布资产。相同标签的 Release 已存在时保留其资产和说明。

两个打包流程先执行 `desktop:smoke` 检查受保护页面和重启后的数据保留，再执行成品启动检查。成品检查使用 `--smoke-test` 和位于 runner 临时目录中的独立 `SUBSCRIPTION_BUTLER_USER_DATA`，核对服务健康状态、登录页面与程序版本，结束后自动退出。两种检查均不读取日常使用的账本。

工作流中的 Actions 固定到官方发布的提交 SHA，版本依据 [checkout](https://github.com/actions/checkout/releases/tag/v7.0.0)、[setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0)、[upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.0)。发布使用 GitHub CLI 的 [gh release create](https://cli.github.com/manual/gh_release_create)。
