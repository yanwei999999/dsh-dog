# dsh-dog

> 仓库地址：<https://github.com/yanwei999999/dsh-dog> · MIT License
> npm：`npm install -g dsh-dog`

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）加一层「启动看门狗 + 自动回滚」。

> 安装第三方插件后 `dsh web` 打不开了？只要启动失败一次，dsh-dog 就自动**禁用**导致
> 问题的插件（**保留已下载的文件和依赖，不删除**），然后自动重试——一个坏插件再也
> 不会让你的 profile 永久打不开。

## 为什么是「看门狗」而不是 dsh 插件

坏插件会让 dsh 在**插件树加载 / 启动阶段**就崩溃，此时任何插件自身都还没机会运行。
所以自动回滚必须待在 dsh 进程之外——这就是 dsh-dog 作为独立命令行工具存在的原因。

## 核心原则：禁用，不删除

dsh-dog 默认**不动别人已下载的东西**：

| 情况 | 自动处理 |
| --- | --- |
| 新装的第三方插件导致启动失败 | 在 `cordis.patch.yml` 里加 `disabled: true`，插件留在 `dependencies` 和 `node_modules` 里，在 dsh 插件清单中显示为「已禁用」 |
| 升级某个第三方插件后启动失败 | 同上，禁用它（保留下载） |
| 你自己改坏了 `cordis.patch.yml` 等配置 | 回滚这几个配置文件（不影响已下载插件） |
| 端口被占用（已有另一个 dsh 实例在运行） | **不做任何改动**，只在命令行提示「请关闭其他 dsh 实例/进程」后退出 |

只有你**显式**运行 `dsh-dog restore` 才会做硬回滚（把 profile 完全恢复到快照，移除快照后新增的插件）。

## 安装

### 方式一（npm 全局安装，推荐）

npm 全局安装会**自动把 `dsh-dog` 命令放进 PATH**，开箱即用：

```bash
npm install -g dsh-dog
# 或直接从 GitHub 装：
npm install -g github:yanwei999999/dsh-dog
```

安装后 `dsh-dog` 就是一条普通命令，直接运行即可。

### 方式二（Windows 脚本，装在 `~/.dsh/tools/dsh-dog`）

脚本会把 `dsh-dog` 装到 `~/.dsh/tools/dsh-dog`，**自动把它加入用户 PATH**（新终端生效），
并可选择给 `dsh web` 加别名：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1            # 装命令 + 加 PATH
powershell -ExecutionPolicy Bypass -File .\install.ps1 -InstallProfile   # 同时让 `dsh web` 自动受保护
```

> 该脚本会自动往用户环境变量 `PATH` 里追加安装目录，因此安装完在**新开的终端**里
> 直接敲 `dsh-dog` 就能用。

### 方式三（手动）

`dsh-dog.mjs` 是零编译的 Node ESM 脚本，唯一依赖是 `js-yaml`；
把它和 `package.json` 放到任意目录后 `npm install`，再用 `node dsh-dog.mjs web` 即可。

## 使用

```powershell
dsh-dog web                      # 等价于 dsh web，失败自动禁用坏插件并重试
dsh-dog web --host 127.0.0.1     # web 后面的参数原样传给 dsh
dsh-dog --grace 30000 web        # 启动成功判定窗口调到 30 秒

dsh-dog snapshot web             # 把当前配置标记为「已知可用」（不启动）
dsh-dog restore web              # 硬回滚到快照（会移除快照后新增的插件）
dsh-dog status web               # 查看当前配置与快照差异、将被禁用的插件
dsh-dog --help
```

### 让 `dsh web` 直接受保护

`install.ps1 -InstallProfile`（或手动）会在 PowerShell 的 `$PROFILE` 里加一个别名：

```powershell
function global:dsh {
    if ($args.Count -ge 1 -and ($args[0] -in @('web','tui','headless'))) {
        & node (Join-Path $env:USERPROFILE '.dsh\tools\dsh-dog\dsh-dog.mjs') @args
    } else {
        & dsh.cmd @args
    }
}
```

之后 `dsh web` 自动走看门狗；`dsh plugin`、`dsh --dump-config` 等其它命令仍原样转发给真正的 dsh。

## 工作原理

1. **成功即快照**：每次 `dsh web` 真正打开（控制台打印出 `dsh web: http://127.0.0.1:…`
   那行 URL，或进程稳定存活超过启动窗口）后，把 profile 的 4 个文件拍成「已知可用」快照，
   存在 `~/.dsh/snapshots/<profile>/`：

   - `package.json`（插件依赖 + `dsh.profile.bundles`）
   - `cordis.patch.yml`
   - `pnpm-lock.yaml`
   - `pnpm-workspace.yaml`

2. **失败即禁用**：下次启动检测到致命加载错误（`fatal load failure`、
   `plugin tree failed to load`、`cannot resolve profile bundle` 等），就对比快照找出
   「新增 / 版本变化」的第三方插件，读取它的 bundle patch 得到条目 id，在
   `cordis.patch.yml` 末尾追加 `disabled: true`，然后自动重试。全程不改 `package.json`
   的依赖、不跑 `pnpm install`，因此**什么都不删除**。

3. **端口被占用不背锅**：如果 stderr 里出现 `EADDRINUSE` / `address already in use`
   （多半是已有另一个 dsh 实例占着端口），看门狗**不会**走进禁用逻辑——直接在命令行
   提示「请关闭其他 dsh 实例/进程（或换一个端口）后再启动」，不改动任何配置即退出。

4. **没变化就不动**：当前配置与快照一致时，什么都不做，只把退出码原样返回。

## 注意事项

- 判定「成功打开」的可靠信号是 `dsh web: http://127.0.0.1:…` 那行 URL（由 `dsh-web-app`
  在树 settle 且 web 服务器绑定后打印，等价于「真的能打开了」）。
- 如果坏插件不是启动崩溃，而是「起来了但页面白屏 / 报错」，看门狗抓不到（进程没死）；
  此时用 `dsh-dog restore web` 手动硬回滚即可。
- `dsh plugin` 每次运行会根据 `dependencies` 重新调和 `dsh.profile.bundles`：已用
  `disabled: true` 禁用的插件**不会被重新启用**（它仍在 bundles 里，只是被禁用）；只有
  「移除 bundles 保留依赖」的兜底方式会在下次 `dsh plugin` 时被重新加回，此时看门狗会
  再次自动禁用。
- 兜底禁用（读不到插件 entry id 时）会把它从 `package.json` 的 `dsh.profile.bundles`
  **移除**（保留依赖与下载）。若保险库/记忆库等突然"消失"，先检查 bundles 列表是否被动过。

## 配套备份插件 dsh-toolbox

[dsh-toolbox](https://github.com/yanwei999999/dsh-toolbox) 是配套的「一键备份」插件：在 dsh 顶栏加一组按钮，
把**配置、记忆库、保险库、会话、看门狗快照、第三方插件源码**整体打包成带时间戳的备份快照。
看门狗负责「启动失败自动回滚」，dsh-toolbox 负责「数据日常备份」，两者互补。

### 安装

```bash
dsh plugin --profile web add dsh-toolbox
# 或直接从 GitHub 装：
dsh plugin --profile web add github:yanwei999999/dsh-toolbox
```

### 首次使用：设置备份路径

1. 重启 `dsh web` 后，顶栏右侧出现「工具箱」按钮组；
2. 点「完整备份」或「插件备份」，**第一次会弹出引导卡片**要求设置备份路径；
3. 填入备份目录（如 `D:\backups\dsh` 或 `~/.dsh/backups`，可填移动硬盘/网盘同步目录），点「保存并备份」；
4. 路径保存在 `~/.dsh/toolbox.config.json`，之后点一下按钮即可一键备份。

插件不写死任何本机路径，任何机器上安装后都能用。

### 备份内容

- **完整备份**：profile 配置 + 记忆库 + 保险库（含 `machine.key`，仅本机可解密）+ 全局设置 + 会话 + 看门狗快照与程序文件 + 第三方插件源码 + 已装插件清单
- **插件源码备份**：仅第三方插件源码（跳过 `.pnpm` 依赖树与官方核心）

### 恢复

把备份快照里的文件拷回 `~/.dsh` 对应位置，再用 `dsh plugin` 重新安装依赖即可。

## 与 dsh 的关联

- 兼容 dsh 的 `$DSH_HOME` 约定（默认 `~/.dsh`，可用 `DSH_HOME` 覆盖）。
- 沿用 dsh 的原生禁用语义（`cordis.patch.yml` 的 `disabled: true`，与 dsh 自带的
  `vision-router` 禁用方式一致），禁用后插件在 dsh 插件清单里仍可见、标记为禁用。
- npm 关键词 `deepseek-harness` / `dsh` / `cordis`，便于在 npm 上被搜到。

## License

[MIT](./LICENSE)
