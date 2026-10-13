# 发布流程

## 准备一个版本

更新根目录和 `desktop/` 的 `package.json` 版本号及对应锁文件，保持两者一致。为该版本添加 `docs/releases/v版本号.md`，记录用户可见变化、适用平台和已知限制。发布标签必须为 `v` 加版本号，例如 `v1.0.0`。

先完成静态检查、测试与桌面打包，并在全新数据目录中检查首次设置访问密钥、登录、创建订阅、重启后的数据保留及退出操作。发布资产应只有应用及许可文件，不能包含个人账本、联系方式、SMTP 配置、密钥或本机路径。

合并到 `main` 后创建标签并推送：

```powershell
git tag -a v1.0.0 -m "订阅管家 v1.0.0"
git push origin v1.0.0
```

## 自动构建与发布

标签触发 `release.yml`。工作流先核对标签、应用版本和桌面版本，再安装锁定依赖、运行检查与测试，构建 Windows x64 可执行文件，并在 runner 临时数据目录中检查成品能否启动服务、打开登录页和报告正确版本。

发布资产包括：

- `SubscriptionButler-版本号-Windows-x64.exe`
- `SHA256SUMS.txt`，包含应用、`LICENSE`、`NOTICE` 的 SHA-256
- `LICENSE`，保留原项目的 Apache License 2.0
- `NOTICE`，说明上游来源与改造范围

Releases 的说明来自对应版本的 Markdown 文件。工作流只使用当前仓库的 `GITHUB_TOKEN`，发布任务申请 `contents: write`；主分支验证只申请读取权限。

同一个版本标签对应同一组发布内容。工作流在发布前检查该标签的 Release 是否已存在；若已存在，保留原资产和说明并成功结束，避免替换本地验证过的发布包。修复程序时递增版本号并发布新标签。

## 核对下载文件

在 Windows PowerShell 中计算下载的可执行文件校验值，与同一 Release 的 `SHA256SUMS.txt` 对照：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath './SubscriptionButler-1.0.0-Windows-x64.exe'
```

校验文件用来核对文件内容，不代替 Windows 代码签名。发布是否带签名应在版本说明中如实记录。
