# dsh-plugin-skill-updater

DSH(DeepSeek Harness)插件:启动时自动检查已安装插件与 Skill 的更新,并在 Web 界面**弹窗**列出
「当前版本 → 最新版本」,由你决定是否更新。

## 行为

1. **启动即检查**:宿主侧插件加载后约 0.3 秒开始在后台检查(不阻塞 DSH 启动)。
   检查期间界面保持安静,结果就绪后自动弹出版本面板。

2. **每次打开都会弹出版本面板**(每个浏览器会话一次 —— 重开 DSH 会重新弹,F5 刷新不会重复打扰):
   - **没有更新时**:标题为「插件与 Skill 版本」,绿色横幅「全部已是最新 · 无需更新」,
     下面完整列出**每一个已安装插件与 Skill 的当前版本**(含被跳过的项及其原因);
     底栏只有「重新检查 / 关闭」,关闭后本次会话不再自动弹出。
   - **有更新时**:标题为「发现 N 项可更新」,逐项显示类型(插件 / Skill)、所属 profile、名称、
     当前版本 → 最新版本,以及备注(如「超出声明范围」「仍在发布冷却期内」)。
     默认全部勾选,可逐项取消;点「稍后」即关闭本次面板。
   - 关闭后如需再次打开,可在浏览器控制台执行 `dshSkillUpdater.open()`。

   > 关于左下角按钮:原先的「更新中心 / N 项可更新」胶囊按钮**已移除** —— 它会与 DSH 桌面端
   > 自带的「更多」控件重叠,因此连「正在检查更新」的提示也一并去掉了。

3. **确认后更新**(后台任务,带实时进度与日志):
   - **插件**:调用 DSH 自带 CLI 的 `plugin update`(与手工命令完全同一条路径);
     更新后**重新读取实际版本复核**,不只看退出码。插件升级需要重启 DSH 才生效。
   - **Skill**:优先用 Skill 自带的 `skill-release.json.updateManifestUrl`;
     下载官方产物并**用 manifest 里的 sha256 校验**,再原子替换(旧版本备份为 `<名字>.bak-<时间戳>`)。
     没有 manifest 的走内置来源表(重新运行上游安装器)。

## 什么会被跳过(不参与检查)

- 声明为 `link:` / `file:` / `git:` / `github:` / 路径 的依赖 —— 即**自己写的、没发布到网上的**
- npm registry 上查不到(404)的包
- 没有已知上游来源的本地 Skill,例如你自己放的 Skill
- 本插件自己(以 `link:` 安装,所以天然被跳过)

## 安装 / 卸载

```powershell
# 先克隆本仓库到一个固定目录(link 安装后不能移动目录),再安装
dsh plugin --profile desktop add link:<本仓库的绝对路径>

# 卸载
dsh plugin --profile desktop remove dsh-plugin-skill-updater
```

> **装完需要重启一次 DSH / 重开桌面客户端**才会出现弹窗:桌面端的脚本注入表是在宿主启动时
> **一次性收集**的,插件在运行期才加载的话,注入行进不了那张表(宿主路由与检查逻辑仍然生效)。

## 路由(全部受 DSH 浏览器信任栅栏保护,写操作额外要求回环来源)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-plugin-skill-updater/status.json` | 检查结果(`entries` 全量清单 / `items` 待更新 / `skipped` 已跳过 / `host` 环境信息) |
| POST | `/dsh-plugin-skill-updater/recheck` | 重新检查 |
| POST | `/dsh-plugin-skill-updater/apply` | 开始更新,body `{"ids":[...]}` |
| GET | `/dsh-plugin-skill-updater/job.json` | 任务进度(步骤状态 + 日志) |
| GET | `/dsh-plugin-skill-updater/client.js` | 前端弹窗脚本 |
| GET | `/dsh-plugin-skill-updater/version.json` | 本插件自身的名称与版本 |

## 手动验证(不依赖界面)

```powershell
# DSH 自带的 Node(也可以直接用 PATH 上的 node)
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$lib  = '<本仓库的绝对路径>\lib\index.js'

# 只检查(只读),打印与 /status.json 相同的 JSON
& $node $lib --check

# 检查并执行指定项的更新(按 id 或名字)
& $node $lib --apply skill:skills:archify
```

浏览器控制台里也可以随时打开面板(即使当前没有更新):

```js
dshSkillUpdater.open()
dshSkillUpdater.status().then(console.log)
```

## 状态文件

| 文件 | 用途 |
|---|---|
| `<DSH_HOME>/.dsh-skill-updater.json` | 最近一次检查摘要 + 无版本文件 Skill 的基线版本 |
| `<DSH_HOME>/.dsh-skill-updater.client` | 前端脚本最近一次被页面拉取的时间(判断 Web 半区是否生效) |

## 备注

- **检查是并发的**:所有 registry 与上游查询并行发出(同一个包只查一次,内容相同的 URL 只取一次),
  因此总耗时约等于「最慢的那一个请求」,而不是各请求之和;单次直连超时 8 秒,
  超时或连接被丢弃时自动改用系统代理通道重试。
- 检查结果缓存在宿主进程内,**刷新页面不会重新检查**;只有点「重新检查」或重启 DSH 才会重取。
- 发布冷却期与 DSH 内置 pnpm 一致(默认 24 小时):刚发布不久的版本不会被列为可更新,
  因为 `pnpm` 会跳过它们;这类项会显示为「仍在冷却期内」。
- 本机若配置了系统代理:Node 的 `fetch` 不走系统代理,插件在直连失败时会自动改用
  PowerShell(`Invoke-WebRequest`,使用系统代理)兜底 —— `github.com` 的 release 资产通常需要这条通道。
- 依赖:无(零第三方依赖;解压用系统自带 `tar`,代理兜底用系统自带 PowerShell)。

## 许可

[MIT](LICENSE) © 2026 Dilin
