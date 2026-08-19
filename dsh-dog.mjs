#!/usr/bin/env node
/**
 * dsh-dog — 给 `dsh <profile>`（例如 `dsh web`）加一层「启动看门狗 + 自动回滚」。
 *
 * 背景：安装第三方插件后 `dsh web` 经常打不开（坏插件让整棵树在启动阶段就崩溃）。
 * 本工具在每次成功启动后把当前 profile 配置拍成「已知可用」快照；下次启动一旦
 * 检测到失败，就自动「禁用」导致问题的插件（**保留已下载的文件和依赖，不删除**）
 * 并重试。
 *
 * 如何定位「导致问题的插件」：
 *   - 优先读取 dsh 启动报错的 stderr，从错误文本里解析出真正报错的插件
 *     （如 `Cannot find package 'dsh-vault' …` → dsh-vault），据此精准禁用;
 *   - 若错误文本解析不到，则回退为「相对上次快照新增/变更的第三方插件」猜测;
 *   - 支持多次重试：一次禁不掉就一直根据下一次错误继续定位（二次、三次…）。
 *   - 重试用尽仍失败时，只会禁用「错误定位到的真凶」；无法定位则停止并提示，
 *     绝不连坐无辜插件、绝不全禁所有第三方。
 *   两种手段都只会「禁用」，不会删除已下载的插件。
 *
 * 为什么是外部工具而不是 dsh 插件：坏插件会在插件树加载/启动阶段就让 dsh 崩溃，
 * 此时任何插件自身都还没机会运行，所以看门狗必须待在 dsh 进程之外。
 *
 * 用法：
 *   dsh-dog web                     看门狗启动 web（失败自动禁用坏插件并重试）
 *   dsh-dog web --host 127.0.0.1    web 后面的参数原样传给 dsh
 *   dsh-dog snapshot web            立刻把当前配置标记为「已知可用」（不启动）
 *   dsh-dog restore web             硬回滚：把 profile 完全恢复到快照（会移除快照后新增的插件）
 *   dsh-dog status web              显示当前配置与快照的差异
 *   dsh-dog --help
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** profile 目录里决定「能不能打开」的配置/清单文件。 */
const CONFIG_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** 启动失败的特征信息（dsh 的 load-failure 诊断都写到 stderr）。 */
const FATAL_MARKERS = [
  /fatal load failure/i,
  /plugin tree failed to load/i,
  /plugin\(s\) failed to load/i,
  /did not activate/i,
  /cannot resolve profile bundle/i,
  /declares no dsh\.bundle/i,
  /failed to parse/i,
  /failed to read overlay/i,
  /failed to read patches/i,
  /config file not found/i,
  /web boot:/i,
];

/** `dsh web` 启动成功时会打印 `dsh web: http://127.0.0.1:<port>`。 */
const SUCCESS_URL = /dsh (web|tui|headless)?:?\s+https?:\/\//i;

const DSH_HOME_ENV = "DSH_HOME";
const DEFAULT_GRACE_MS = 20000;
const DEFAULT_RETRY = 2;

/** 内置核心 bundle 前缀：这些是 dsh 安装自带的，永不参与「禁用」。 */
const INBOX_PREFIX = "@deepseek-ai/";

/**
 * 硬保护列表：这些插件即使在启动失败/全禁时也**永不参与禁用**。
 * 独立于白名单文件（白名单被清空/重建也不受影响）。
 * 默认**为空**（不硬编码任何插件，避免影响其他用户）；
 * 通过环境变量 `DSH_DOG_KEEP`（逗号分隔）或命令行 `--keep <pkg>` 指定。
 * 例：DSH_DOG_KEEP=dsh-toolbox,meow-memory dsh-dog web
 */
const HARD_KEEP = (process.env.DSH_DOG_KEEP || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 白名单文件（按 profile 分文件，放在 $DSH_HOME/guard-allowlist/<profile>.txt）。 */
const ALLOWLIST_DIR = "guard-allowlist";

// ---------------------------------------------------------------------------
// 路径解析（与 DSH 自身 `resolveDshHome` 保持一致）
// ---------------------------------------------------------------------------

function expandHomePath(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function resolveDshHome() {
  const fromEnv = process.env[DSH_HOME_ENV];
  const base = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), ".dsh");
  return resolve(expandHomePath(base));
}

function profileDir(profile) {
  return join(resolveDshHome(), "profiles", profile);
}

function snapDir(profile) {
  return join(resolveDshHome(), "snapshots", profile);
}

/** 白名单文件路径：$DSH_HOME/guard-allowlist/<profile>.txt */
function allowlistPath(profile) {
  return join(resolveDshHome(), ALLOWLIST_DIR, `${profile}.txt`);
}

/**
 * 读取某 profile 的插件白名单（每行一个 bundle 包名，`#` 开头为注释）。
 * 白名单里的插件即使在启动失败时也不会被看门狗禁用。
 * @returns Set<string>
 */
function readAllowlist(profile) {
  const p = allowlistPath(profile);
  const out = new Set();
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      out.add(t);
    }
  } catch {
    /* 读不了就当空白名单。 */
  }
  return out;
}

/** 把某个 bundle 包名加入白名单。返回 true 表示有新增。 */
function allowPlugin(profile, name) {
  const p = allowlistPath(profile);
  const existing = readAllowlist(profile);
  if (existing.has(name)) return false;
  mkdirSync(join(resolveDshHome(), ALLOWLIST_DIR), { recursive: true });
  let content = "";
  if (existsSync(p)) content = readFileSync(p, "utf8");
  if (content && !content.endsWith("\n")) content += "\n";
  content += `${name}\n`;
  writeFileSync(p, content);
  return true;
}

/** 把某个 bundle 包名从白名单移除。返回 true 表示有改动。 */
function disallowPlugin(profile, name) {
  const p = allowlistPath(profile);
  const existing = readAllowlist(profile);
  if (!existing.has(name)) return false;
  const kept = [...existing].filter((n) => n !== name);
  mkdirSync(join(resolveDshHome(), ALLOWLIST_DIR), { recursive: true });
  writeFileSync(p, kept.length ? kept.join("\n") + "\n" : "");
  return true;
}

/**
 * 过滤掉白名单里的插件（失败时保留、不禁用）。
 * 硬保护插件（HARD_KEEP：dsh-toolbox / meow-memory）永远保留，
 * 即使白名单文件被清空/重建也不受影响。
 */
function filterAllowlist(profile, names) {
  const allowlist = readAllowlist(profile);
  const keep = new Set([...HARD_KEEP, ...allowlist]);
  if (keep.size === 0) return names;
  return names.filter((n) => !keep.has(n));
}

// ---------------------------------------------------------------------------
// 配置快照：读取 / 比较 / 写入 / 恢复
// ---------------------------------------------------------------------------

function readConfig(dir) {
  const config = {};
  for (const name of CONFIG_FILES) {
    const p = join(dir, name);
    config[name] = existsSync(p) ? readFileSync(p) : null;
  }
  return config;
}

function readSnapshot(dir) {
  if (!existsSync(join(dir, "meta.json"))) return null;
  const config = {};
  for (const name of CONFIG_FILES) {
    const p = join(dir, name);
    config[name] = existsSync(p) ? readFileSync(p) : null;
  }
  return config;
}

function sameConfig(a, b) {
  for (const name of CONFIG_FILES) {
    const x = a[name];
    const y = b[name];
    if ((x === null) !== (y === null)) return false;
    if (x !== null && !x.equals(y)) return false;
  }
  return true;
}

function writeSnapshot(dir, config) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of CONFIG_FILES) {
    if (config[name] === null) continue;
    writeFileSync(join(dir, name), config[name]);
    files.push(name);
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ savedAt: new Date().toISOString(), files }, null, 2) + "\n");
}

/** 只把快照里选定的文件写回 profile（硬回滚用；不影响其它文件）。 */
function restoreFiles(dir, config, names) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    if (config[name] === null) continue;
    writeFileSync(join(dir, name), config[name]);
  }
}

function restoreSnapshot(dir, config) {
  restoreFiles(dir, config, CONFIG_FILES);
}

// ---------------------------------------------------------------------------
// huifu：从备份目录（默认 E:\gongzuo\jiyi）把最新可用备份整体恢复回 ~/.dsh
// ---------------------------------------------------------------------------

/** 递归把 src 目录内容拷入 dest 目录（创建 dest）。 */
function copyDirContents(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyDirContents(s, d);
    else if (st.isFile()) { mkdirSync(dest, { recursive: true }); copyFileSync(s, d); }
  }
}

/** 从给定备份目录整体恢复到 DSH_HOME；返回是否成功。 */
function restoreFromBackup(dir, profile) {
  const home = resolveDshHome();
  const pDir = profileDir(profile);

  // 关键校验：备份必须包含 profile 配置，否则视为不可用
  if (!existsSync(join(dir, "dsh-profile", "package.json"))) return false;

  // 1. profile 配置
  copyDirContents(join(dir, "dsh-profile"), pDir);
  // 2. 全局设置（settings.yaml / .anonymous-user-id 等顶层文件）
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile()) copyFileSync(p, join(home, f));
  }
  // 3. dsh-memory / dsh-storages → storages
  for (const sub of ["dsh-memory", "dsh-storages"]) {
    copyDirContents(join(dir, sub), join(home, "storages"));
  }
  // 4. dsh-vault → vault
  copyDirContents(join(dir, "dsh-vault"), join(home, "vault"));
  // 5. watchdog 快照
  copyDirContents(join(dir, "dsh-watchdog-snapshots", "snapshots"), join(home, "snapshots"));
  // 6. sessions
  copyDirContents(join(dir, "dsh-sessions", "sessions"), join(home, "sessions"));
  // 7. 第三方插件源码 → node_modules（尽力而为，通常可重新安装）
  copyDirContents(join(dir, "dsh-plugin-sources"), join(pDir, "node_modules"));
  return true;
}

/** 列出备份根目录下所有 backup-YYYYMMDD-HHMMSS 目录，按名字倒序（最新在前）。 */
function listBackups(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => /^backup-\d{8}-\d{6}$/.test(n))
    .sort()
    .reverse();
}

/** 列出所有 node_modules-backup-YYYYMMDD-HHMMSS 目录。 */
function listNodeModulesBackups(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => /^node_modules-backup-\d{8}-\d{6}$/.test(n));
}

/** 把 YYYYMMDD-HHmmss 解析成毫秒时间戳。 */
function stampToMs(s) {
  const m = s && s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
}

/** 找到与给定 backup-<stamp> 时间最接近的 node_modules-backup-* 目录名；没有返回 null。 */
function nearestNodeModulesBackup(root, stamp) {
  const t0 = stampToMs(stamp);
  if (Number.isNaN(t0)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const n of listNodeModulesBackups(root)) {
    const m = n.match(/^node_modules-backup-(\d{8})-(\d{6})$/);
    if (!m) continue;
    const t = stampToMs(`${m[1]}-${m[2]}`);
    const diff = Math.abs(t - t0);
    if (diff < bestDiff) { bestDiff = diff; best = n; }
  }
  return best;
}

function runHuifu(profile, backupDir) {
  const backups = listBackups(backupDir);
  if (backups.length === 0) {
    process.stderr.write(`[dsh-dog] 备份目录里没有可用备份：${backupDir}\n`);
    return 1;
  }
  for (const name of backups) {
    const dir = join(backupDir, name);
    process.stdout.write(`[dsh-dog] 尝试恢复：${name} …\n`);
    const ok = restoreFromBackup(dir, profile);
    if (ok) {
      // 同步配套的 node_modules-backup-*（按时间最接近配对），拷回 node_modules
      const stamp = name.replace(/^backup-/, "");
      const nmBackup = nearestNodeModulesBackup(backupDir, stamp);
      if (nmBackup) {
        copyDirContents(join(backupDir, nmBackup), join(profileDir(profile), "node_modules"));
        process.stdout.write(`[dsh-dog] ✔ 已同步 node_modules-backup（${nmBackup}）到 node_modules\n`);
      } else {
        process.stdout.write("[dsh-dog] （未找到配套的 node_modules-backup-*，跳过 node_modules 同步）\n");
      }
      process.stdout.write(`[dsh-dog] ✔ 已从 ${name} 恢复到 ${resolveDshHome()}\n`);
      process.stdout.write(`[dsh-dog] 提示：重启 dsh 前如依赖有变，可运行 pnpm install（dsh web 重启会自动对齐）。\n`);
      return 0;
    }
    process.stdout.write(`[dsh-dog] ${name} 缺少关键配置（dsh-profile/package.json），跳过，尝试更早备份…\n`);
  }
  process.stderr.write("[dsh-dog] 所有备份均不可用，恢复失败。\n");
  return 1;
}

// ---------------------------------------------------------------------------
// 差异分析：找出「导致启动失败」的第三方 bundle
// ---------------------------------------------------------------------------

function readManifest(config) {
  const raw = config["package.json"];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 找出需要禁用的第三方 bundle：相对快照「新增」的，或依赖版本/来源「改变」的。
 * 内置 `@deepseek-ai/*` 一律排除（禁用它等于让 dsh 本身不可用）。
 * @returns bundle 包名数组。
 */
function computeOffenders(currentManifest, goodManifest) {
  const cur = currentManifest?.dsh?.profile?.bundles ?? [];
  const snap = goodManifest?.dsh?.profile?.bundles ?? [];
  const curDeps = currentManifest?.dependencies ?? {};
  const snapDeps = goodManifest?.dependencies ?? {};
  const out = new Set();
  for (const name of cur) {
    if (name.startsWith(INBOX_PREFIX)) continue;
    if (!snap.includes(name)) out.add(name);
    else if ((curDeps[name] ?? null) !== (snapDeps[name] ?? null)) out.add(name);
  }
  return [...out];
}

/**
 * 从 dsh 启动错误的 stderr 文本里，尽力解析出「真正报错」的插件/包名。
 *
 * 为什么要解析错误：仅靠「相对快照新增/变更的第三方插件」（computeOffenders）去猜测
 * 元凶，会把真正的错怪到新装插件头上。例如某个 link 依赖坏了，报错是
 *   Cannot find package 'dsh-vault' imported from C:\...
 *   failed to import loader entry dsh-vault (dsh-vault): ...
 * 此时元凶其实是 dsh-vault（它没被算成「新增插件」），必须靠错误文本才能定位。
 *
 * 解析策略（按优先级取第一个命中）：
 *   1. `Cannot find package '<pkg>'` → 取 <pkg>
 *   2. `failed to import loader entry <id> (<pkg>)` 或 `loader entry <id> (…)` → 取 <id>
 *   3. `failed to import loader entry <id>`、`cannot load plugin <id>` 等 → 取 <id>
 *   4. 兜底：`imported from C:\…\profiles\<profile>\node_modules\<pkg>` → 取 pkg
 * 结果会过滤掉 node: 内置、路径片段、@deepseek-ai/* 核心包，并做基本去重。
 *
 * @param {string} stderr dsh 启动收集到的 stderr 全文
 * @param {string} profile 当前 profile 名
 * @returns {string[]} 候选出错插件名（未命中则空数组）
 */
function parsePluginFromStderr(stderr, profile = "") {
  if (!stderr) return [];
  const text = stderr.replace(/\0/g, "");
  const seen = new Set();
  const isPlausible = (name) => {
    if (!name || typeof name !== "string") return false;
    const n = name.trim();
    if (n.length === 0) return false;
    if (/^node:/i.test(n)) return false; // node:fs 等内置模块
    if (/[\\]/.test(n)) return false; // 反斜杠路径
    if (n.startsWith("@")) {
      // @scope/name 允许，但必须恰好两段，且段不含奇怪字符
      if (!/^@[^/]+\/[^/]+$/.test(n)) return false;
    } else {
      // 非 scoped：必须是单个短名（dsh-vault 风格），不允许斜杠
      if (n.includes("/")) return false;
    }
    if (/\.(js|mjs|cjs|json|ts)$/i.test(n)) return false; // 文件名
    if (/\.(ds?)$/i.test(n)) return false; // 盘符尾
    return true;
  };
  const push = (name) => {
    if (!name) return;
    const clean = String(name).trim();
    if (clean.startsWith(INBOX_PREFIX)) return;
    if (isPlausible(clean) && !seen.has(clean)) seen.add(clean);
  };

  // 1) Cannot find package '<pkg>'  — 最常见的 ESM 解析失败信号
  const re1 = /Cannot find package '([^']+)'/g;
  let m;
  while ((m = re1.exec(text))) push(m[1]);

  // 2) failed to import loader entry <id> (<pkg>)  或  loader entry <id> (…)
  const re2 = /(?:failed to )?import loader entry ([A-Za-z0-9@._-]+)\s*(?:\(([^)]+)\))?/gi;
  while ((m = re2.exec(text))) {
    push(m[1]);
    if (m[2]) push(m[2]);
  }

  // 3a) `X did not activate` → X 是插件入口名（常见于插件在激活阶段抛错）
  const re3a = /([A-Za-z0-9@._-]+)\s+did not activate/gi;
  while ((m = re3a.exec(text))) push(m[1]);

  // 3b) 明确的插件加载失败动词
  const re3b = /(?:cannot load plugin|could not load plugin|failed to load plugin)\s+'?([A-Za-z0-9@._-]+)/gi;
  while ((m = re3b.exec(text))) push(m[1]);

  // 4) 兜底：imported from …\node_modules\<pkg>  (最后一段才是包名)
  const re4 = /imported from\s+(?:"|')?([^\s"']+)[^"']*(?:"|')?/gi;
  while ((m = re4.exec(text))) {
    const p = m[1];
    const idx = p.toLowerCase().indexOf("node_modules");
    if (idx >= 0) {
      let rest = p.slice(idx + "node_modules".length).replace(/\\/g, "/").replace(/^\//, "");
      // 可能带 @scope/name 或 name/子路径
      const parts = rest.split("/");
      if (parts[0]?.startsWith("@") && parts.length >= 2) push(`${parts[0]}/${parts[1]}`);
      else if (parts[0]) push(parts[0]);
    }
  }

  return [...seen];
}

/**
 * 判断启动失败是否为「端口被占用」（Node 的 EADDRINUSE）。
 *
 * 典型报错（dsh 通过 installFailLoud 打到 stderr）：
 *   dsh: fatal load failure: Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
 * 这种失败和任何插件都无关：多半是已有另一个 dsh 实例占着端口。
 * 看门狗必须识别出来并直接提示用户关闭其他实例，绝不能走进「禁用插件」的逻辑。
 *
 * @param {string} stderr dsh 启动收集到的 stderr 全文
 * @returns {string|null} 命中时返回占用地址描述（如 `127.0.0.1:3080`），否则 null
 */
function detectPortBusy(stderr) {
  if (!stderr) return null;
  const text = stderr.replace(/\0/g, "");
  if (!/EADDRINUSE|already in use|端口被占用/i.test(text)) return null;
  // 优先取 “address already in use <host:port>” 里的地址
  const m = /address already in use\s+([^\s\n]+)/i.exec(text);
  if (m) return m[1];
  // 兜底：在包含 EADDRINUSE 的那一行里找一个 host:port / ip:port 令牌
  const line = (text.split(/\r?\n/).find((l) => /EADDRINUSE|already in use|端口被占用/i.test(l)) ?? "").trim();
  const t = /((?:[0-9]{1,3}\.){3}[0-9]{1,3}:\d{1,5}|\[[^\]]+\]:\d{1,5}|[0-9a-fA-F:]+:\d{1,5})/.exec(line);
  return t ? t[1] : "未知地址";
}

/**
 * 决策「要禁用哪些插件」的纯函数（便于单测）。
 *
 * 优先级：先从启动错误 stderr 定位真正报错的插件；**只要错误定位到了插件，
 * 就以它为准（只禁报错者）**，不会连坐无辜的新装插件。仅当错误里解析不到
 * 任何插件名时，才回退到「相对快照新增/变更」的配置猜测。
 *
 * @param {object} currentManifest 当前 package.json
 * @param {object} goodManifest   快照 package.json
 * @param {string} stderr         dsh 启动错误文本（可为空）
 * @param {string} profile        profile 名
 * @returns {{combined:string[], fromError:string[]}} 合并后候选 + 哪些来自错误解析
 */
function pickDisableCandidates(currentManifest, goodManifest, stderr, profile = "") {
  const errorPlugins = parsePluginFromStderr(stderr, profile);
  const fromError = errorPlugins.filter((n) => n && n !== profile);
  if (fromError.length > 0) {
    return { combined: fromError, fromError };
  }
  const offenders = computeOffenders(currentManifest, goodManifest);
  return { combined: offenders, fromError };
}

/**
 * 收集 profile 里「所有第三方」bundle 名（排除 @deepseek-ai/* 内置核心）。
 * 仅供查询/测试/手动 nuke 命令使用；自动兜底不会全禁第三方。
 * @param {object} manifest 当前 package.json 解析结果
 * @returns {string[]}
 */
function allThirdPartyBundles(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  return bundles.filter((n) => n && !n.startsWith(INBOX_PREFIX));
}

/**
 * 手动「全禁」：禁用 profile 里所有第三方插件（保留下载、不删除），只留内置核心。
 * 仅由用户显式执行 `dsh-dog nuke <profile>` 触发，自动看门狗绝不调用。
 * 默认保留 dsh-toolbox 不禁用（用户要求：工具箱始终可用）。
 * @param {string} profileDirPath profile 目录
 * @param {object} manifest 当前 package.json 解析结果
 * @param {string[]} [keep] 额外保留的插件名（不禁用）
 * @returns {number} 实际处理（禁用/移除）的插件数
 */
function nukeAllThirdParty(profileDirPath, manifest, keep = []) {
  const keepSet = new Set([...HARD_KEEP, ...keep]); // 硬保护：dsh-toolbox / meow-memory 永不全禁
  const all = allThirdPartyBundles(manifest).filter((n) => !keepSet.has(n));
  const unhandled = [];
  let n = 0;
  for (const name of all) {
    const dir = bundleDir(profileDirPath, name);
    const ids = dir ? extractEntryIds(dir) : [];
    if (ids.length > 0) n += disableEntries(profileDirPath, ids);
    else unhandled.push(name);
  }
  if (unhandled.length > 0) removeFromBundles(profileDirPath, unhandled);
  return all.length;
}

// ---------------------------------------------------------------------------
// 「禁用而不删除」的实现
// ---------------------------------------------------------------------------

/** 解析 bundle 包目录（第三方插件由 pnpm 装进 profile 的 node_modules）。 */
function bundleDir(profileDirPath, name) {
  const dir = join(profileDirPath, "node_modules", name);
  return existsSync(join(dir, "package.json")) ? dir : null;
}

/** 从 bundle 的 cordis.patch.yml 里提取它 insert 出来的条目 id。 */
function extractEntryIds(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const patchRel = manifest?.dsh?.bundle?.patch;
    if (!patchRel) return [];
    const patches = yaml.load(readFileSync(join(dir, patchRel), "utf8")) ?? [];
    const ids = [];
    for (const p of patches) {
      if (p && Array.isArray(p.insert)) {
        for (const e of p.insert) if (e && typeof e.id === "string") ids.push(e.id);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * 在 profile 的 `cordis.patch.yml` 末尾追加 `- id: X` / `  disabled: true`，
 * **不改动、不重排已有内容**（保留用户手写的注释与格式）。已存在的禁用项会跳过。
 * @returns 实际新增的禁用条目数量。
 */
function disableEntries(profileDirPath, ids) {
  const patchPath = join(profileDirPath, "cordis.patch.yml");
  const alreadyDisabled = new Set();
  if (existsSync(patchPath)) {
    try {
      const patches = yaml.load(readFileSync(patchPath, "utf8")) ?? [];
      for (const p of patches) if (p && p.id && p.disabled === true) alreadyDisabled.add(p.id);
    } catch {
      /* 读不了就当没有，走文本追加，最多造成一次重复的禁用条目（幂等，无害）。 */
    }
  }
  const toAdd = ids.filter((id) => typeof id === "string" && id.length > 0 && !alreadyDisabled.has(id));
  if (toAdd.length === 0) return 0;

  let content = existsSync(patchPath)
    ? readFileSync(patchPath, "utf8")
    : "# profile patch layer (disabled entries appended by dsh-dog)\n";
  if (content && !content.endsWith("\n")) content += "\n";
  for (const id of toAdd) content += `- id: ${id}\n  disabled: true\n`;
  writeFileSync(patchPath, content);
  return toAdd.length;
}

/**
 * 兜底禁用：当拿不到 bundle 的条目 id 时，把它从 `dsh.profile.bundles` 移除，
 * 但**保留在 dependencies 和 node_modules**（仍然不删除下载的东西）。
 * @returns 是否有改动。
 */
function removeFromBundles(profileDirPath, names) {
  const manifestPath = join(profileDirPath, "package.json");
  const raw = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""); // 容忍 UTF-8 BOM
  const manifest = JSON.parse(raw);
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  const next = bundles.filter((n) => !names.includes(n));
  if (next.length === bundles.length) return false;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// pnpm：硬回滚（restore）后，把 node_modules 对齐到快照的依赖状态
// ---------------------------------------------------------------------------

function runPnpmInstall(dir) {
  const run = (args) => {
    if (process.platform === "win32") {
      const command = ["pnpm", ...args].map(winQuoteArg).join(" ");
      return spawnSync(command, { cwd: dir, stdio: "inherit", shell: true });
    }
    return spawnSync("pnpm", args, { cwd: dir, stdio: "inherit" });
  };
  let r = run(["install", "--frozen-lockfile"]);
  if (r.status === 0) return true;
  if (r.error && r.error.code === "ENOENT") {
    process.stderr.write("[dsh-dog] 未找到 pnpm，跳过 node_modules 对齐（通常不影响回滚后的启动）。\n");
    return false;
  }
  process.stderr.write("[dsh-dog] pnpm install --frozen-lockfile 失败，回退到 pnpm install ...\n");
  r = run(["install"]);
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// 启动 dsh 子进程，实时转发输出，并观察「成功 URL / 致命错误」
// ---------------------------------------------------------------------------

function winQuoteArg(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

function spawnDsh(profile, dshArgs) {
  if (process.env.DSH_BIN) {
    return spawn(process.execPath, [process.env.DSH_BIN, profile, ...dshArgs], {
      stdio: ["inherit", "pipe", "pipe"],
    });
  }
  if (process.platform === "win32") {
    const command = ["dsh", profile, ...dshArgs].map(winQuoteArg).join(" ");
    return spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  }
  return spawn("dsh", [profile, ...dshArgs], { stdio: ["inherit", "pipe", "pipe"] });
}

function runDsh(profile, dshArgs) {
  return new Promise((resolvePromise) => {
    const child = spawnDsh(profile, dshArgs);
    const saw = { url: false, fatal: false };
    let buf = "";
    let stderrBuf = "";

    const feed = (chunk, sink, tag) => {
      const s = chunk.toString();
      sink.write(s);
      if (tag === "stdout") {
        // 成功信号只来自 stdout（`dsh web: http://…` 这行 URL）。
        buf += s;
        if (buf.length > 1_000_000) buf = buf.slice(-200_000);
        if (!saw.url && SUCCESS_URL.test(buf)) saw.url = true;
      } else {
        // 致命信号只来自 stderr。
        stderrBuf += s;
        if (stderrBuf.length > 1_000_000) stderrBuf = stderrBuf.slice(-200_000);
        if (!saw.fatal && FATAL_MARKERS.some((m) => m.test(stderrBuf))) saw.fatal = true;
      }
    };

    child.stdout.on("data", (c) => feed(c, process.stdout, "stdout"));
    child.stderr.on("data", (c) => feed(c, process.stderr, "stderr"));
    child.on("error", (err) => resolvePromise({ error: err, saw, stderr: stderrBuf }));
    child.on("exit", (code, signal) => resolvePromise({ code, signal, saw, stderr: stderrBuf }));
  });
}

// ---------------------------------------------------------------------------
// 启动看门狗主流程
// ---------------------------------------------------------------------------

async function guard(profile, dshArgs, opts) {
  const pDir = profileDir(profile);
  const sDir = snapDir(profile);
  let exhausted = false; // 是否已做「禁用所有第三方插件」的终极兜底（只做一次）

  for (let attempt = 0; ; attempt++) {
    const current = readConfig(pDir);
    const good = readSnapshot(sDir);
    const changed = good === null || !sameConfig(current, good);

    const started = Date.now();
    const result = await runDsh(profile, dshArgs);
    const elapsed = Date.now() - started;

    if (result.error) {
      process.stderr.write(`[dsh-dog] 无法启动 dsh：${result.error.message}\n`);
      process.stderr.write("[dsh-dog] 请确认 dsh 在 PATH 上（可设置 DSH_BIN 指向 bin.js）。\n");
      return 1;
    }

    const { code, signal, saw } = result;
    const cleanExit = code === 0 || code === 130 || signal === "SIGINT" || signal === "SIGTERM";
    const success = saw.url || elapsed >= opts.graceMs;

    // 1) 成功：看到 URL，或撑过了启动窗口。
    if (success) {
      if (changed) writeSnapshot(sDir, current);
      return code ?? 0;
    }

    // 2) 干净退出但没看到 URL（`dsh web --help`，或启动瞬间 Ctrl+C）：不算失败。
    if (cleanExit) return code ?? 0;

    // 2.5) 端口被占用（EADDRINUSE）：这不是坏插件问题，绝不进入「禁用插件」逻辑。
    //      多半是已有另一个 dsh 实例占着端口 —— 重试也只会继续撞同一个端口，
    //      所以直接提示用户关闭其他 dsh 实例并退出，不改动任何配置。
    const portBusy = detectPortBusy(result.stderr ?? "");
    if (portBusy !== null) {
      process.stderr.write(`\n[dsh-dog] ⚠ 端口被占用（${portBusy}）：看起来已经有另一个 dsh 实例在运行。\n`);
      process.stderr.write("[dsh-dog]   请先关闭其他 dsh 实例/进程（或换一个端口）后再启动。\n");
      process.stderr.write("[dsh-dog]   本次未禁用、未改动任何插件。\n\n");
      return code ?? 1;
    }

    // 3) 启动失败。
    const bootFailure = saw.fatal || elapsed < opts.graceMs;

    if (bootFailure && good !== null && changed) {
      // ── 主路径：在指定定位次数内，逐步禁用「候选」插件（错误解析优先） ──
      if (attempt < opts.retry && !exhausted) {
        const { combined, fromError } = pickDisableCandidates(
          readManifest(current),
          readManifest(good),
          result.stderr ?? "",
          profile,
        );
        // 白名单里的插件保留启用；只禁用不在白名单里的。
        const candidates = filterAllowlist(profile, combined);

        if (candidates.length > 0) {
          // 禁用而不删除：保留已下载的插件，只让它不再参与启动。
          const unhandled = [];
          let disabled = 0;
          for (const name of candidates) {
            const dir = bundleDir(pDir, name);
            const ids = dir ? extractEntryIds(dir) : [];
            if (ids.length > 0) disabled += disableEntries(pDir, ids);
            else unhandled.push(name);
          }
          if (unhandled.length > 0) removeFromBundles(pDir, unhandled);

          const fromErr =
            fromError.length > 0
              ? `（依据启动错误定位：${fromError.join(", ")}）`
              : "（依据配置变化猜测：无新增/变更，按错误信号禁用）";
          const skippedAllowlist = combined.length - candidates.length;
          const skipNote = skippedAllowlist > 0 ? `；白名单保留 ${skippedAllowlist} 个不禁用` : "";
          process.stderr.write(
            `\n[dsh-dog] ⚠ 启动失败（第 ${attempt + 1} 次）。已禁用（未删除）插件：${candidates.join(", ")}${skipNote}；其依赖与下载文件均保留。\n`,
          );
          process.stderr.write(`[dsh-dog]    ${fromErr}\n`);
          process.stderr.write(`[dsh-dog] 第 ${attempt + 2} 次尝试启动 …\n\n`);
          continue;
        }

        if (combined.length > 0) {
          // 候选插件全在白名单里：保留，不做禁用，重试。
          process.stderr.write(
            `\n[dsh-dog] ℹ 启动失败（第 ${attempt + 1} 次），但候选插件均在白名单中，已全部保留、不禁用。\n`,
          );
          process.stderr.write(`[dsh-dog] 第 ${attempt + 2} 次尝试启动 …\n\n`);
          continue;
        }

        // 没有第三方插件变更：多半是用户自己改坏了 cordis.patch.yml 等，回滚这几个文件（不动已下载插件）。
        restoreFiles(pDir, good, ["cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
        process.stderr.write(
          `\n[dsh-dog] ⚠ 启动失败（第 ${attempt + 1} 次），且未发现可定位的插件，已回滚 profile 自身的配置改动（未动已下载插件）。\n`,
        );
        process.stderr.write(`[dsh-dog] 第 ${attempt + 2} 次尝试启动 …\n\n`);
        continue;
      }

      // ── 终极兜底：定位次数用尽仍失败 → 只禁「错误定位到的真凶」，绝不连坐/全禁 ──
      if (!exhausted) {
        exhausted = true;
        // 仍从最后一次启动错误里解析真凶：只禁报错者，不连坐无辜插件、不全禁第三方。
        const { fromError } = pickDisableCandidates(
          readManifest(current),
          readManifest(good),
          result.stderr ?? "",
          profile,
        );
        const candidates = filterAllowlist(profile, fromError);
        if (candidates.length > 0) {
          const unhandled = [];
          let n = 0;
          for (const name of candidates) {
            const dir = bundleDir(pDir, name);
            const ids = dir ? extractEntryIds(dir) : [];
            if (ids.length > 0) n += disableEntries(pDir, ids);
            else unhandled.push(name);
          }
          if (unhandled.length > 0) removeFromBundles(pDir, unhandled);
          process.stderr.write(
            `\n[dsh-dog] ⚠ 多次重试（${opts.retry} 轮）仍无法启动，仅禁用错误定位到的插件：${candidates.join(", ")}（保留下载、不删除）。\n`,
          );
          process.stderr.write("[dsh-dog] 最后一次尝试启动 …\n\n");
          continue;
        }
        // 解析不到任何真凶：不再全禁第三方，停止并提示用户手动排查（避免误杀无辜插件）。
        process.stderr.write(
          `\n[dsh-dog] ⚠ 多次重试（${opts.retry} 轮）仍无法启动，且无法从启动错误中定位到具体插件。\n`,
        );
        process.stderr.write("[dsh-dog] 为避免误杀，本次未禁用、未改动任何插件。请手动查看启动日志排查根因。\n");
        return code ?? 1;
      }

      return code ?? 1;
    }

    return code ?? 0;
  }
}

// ---------------------------------------------------------------------------
// 子命令：snapshot / restore / status
// ---------------------------------------------------------------------------

function printStatus(profile) {
  const pDir = profileDir(profile);
  const sDir = snapDir(profile);
  const current = readConfig(pDir);
  const good = readSnapshot(sDir);

  process.stdout.write(`DSH 配置目录 : ${resolveDshHome()}\n`);
  process.stdout.write(`Profile     : ${profile}\n`);
  process.stdout.write(`快照目录     : ${sDir}\n\n`);

  if (good === null) {
    process.stdout.write("还没有「已知可用」快照。第一次成功启动（或运行 snapshot）后会生成。\n");
    return 0;
  }

  let diffCount = 0;
  for (const name of CONFIG_FILES) {
    const c = current[name];
    const g = good[name];
    let state;
    if (c === null && g === null) state = "（两边都没有）";
    else if (c === null) state = "当前缺失";
    else if (g === null) state = "快照缺失";
    else state = c.equals(g) ? "一致" : "不同";
    if (state === "不同" || state === "当前缺失" || state === "快照缺失") diffCount += 1;
    process.stdout.write(`  ${name.padEnd(22)} ${state}\n`);
  }

  const offenders = computeOffenders(readManifest(current), readManifest(good));
  if (offenders.length > 0) {
    process.stdout.write("\n启动失败时会被「禁用」（保留下载、不删除）的插件：\n");
    for (const name of offenders) process.stdout.write(`  - ${name}\n`);
  }

  const allowlist = readAllowlist(profile);
  process.stdout.write("\n白名单（启动失败时保留启用、不禁用的插件）：\n");
  if (allowlist.size === 0) {
    process.stdout.write("  （空）\n");
  } else {
    for (const name of [...allowlist].sort()) process.stdout.write(`  - ${name}\n`);
  }

  process.stdout.write("\n");
  if (diffCount === 0) process.stdout.write("当前配置与快照一致。\n");
  else process.stdout.write(`有 ${diffCount} 个文件与快照不同。自动看门狗会优先「禁用」坏插件（不删除）；如需硬回滚请用 restore。\n`);
  return 0;
}

function printHelp() {
  process.stdout.write(`dsh-dog — dsh 启动看门狗：失败自动禁用坏插件并重试（不删除已下载的东西）

用法：
  dsh-dog [守卫参数] <profile> [传给 dsh 的参数…]
  dsh-dog snapshot <profile>      把当前配置标记为「已知可用」（不启动）
  dsh-dog restore <profile>       硬回滚到快照（会移除快照后新增的插件；请谨慎）
  dsh-dog status <profile>        显示当前配置与快照差异、将被禁用的插件、白名单
  dsh-dog allowlist <profile>     查看插件白名单（启动失败时保留、不禁用）
  dsh-dog allow <profile> <pkg>   把插件加入白名单（失败时保留启用）
  dsh-dog disallow <profile> <pkg> 把插件移出白名单
  dsh-dog nuke <profile>          手动禁用全部第三方插件（保留 dsh-toolbox；仅显式触发，自动看门狗不会全禁）
  dsh-dog huifu [<profile>]       从备份目录按「最新→次新」恢复全部文件到 ~/.dsh（含配套 node_modules-backup；需用 --backup-dir 指定备份目录）
  dsh-dog --help

守卫参数（必须放在 <profile> 前面）：
  --grace <毫秒>       启动成功判定窗口，默认 ${DEFAULT_GRACE_MS}
  --retry <次数>       失败处理后自动重试次数，默认 ${DEFAULT_RETRY}
  --no-install         硬回滚后不跑 pnpm install
  --profile <名字>     显式指定 profile（等价于位置参数）
  --backup-dir <路径>  huifu 的备份目录（必须指定，如 D:\\backup\\dsh）

示例：
  dsh-dog web
  dsh-dog web --host 127.0.0.1
  dsh-dog snapshot web
  dsh-dog allow web dsh-toolbox    # 失败时保留 dsh-toolbox 不禁用
`);
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { graceMs: DEFAULT_GRACE_MS, retry: DEFAULT_RETRY, noInstall: false, backupDir: "", keep: undefined };
  let profile = null;
  let action = null;
  let i = 0;

  const num = (v, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grace") { opts.graceMs = num(argv[++i], DEFAULT_GRACE_MS); continue; }
    if (a === "--retry") { opts.retry = num(argv[++i], DEFAULT_RETRY); continue; }
    if (a === "--profile") { profile = argv[++i]; continue; }
    if (a === "--no-install") { opts.noInstall = true; continue; }
    if (a === "--backup-dir") { opts.backupDir = argv[++i]; continue; }
    if (a === "--keep") { opts.keep = argv[++i]; continue; }
    if (a === "--help" || a === "-h") { printHelp(); return null; }
    break;
  }

  const first = argv[i];

  if (first === "snapshot" || first === "restore" || first === "rollback" || first === "status" || first === "huifu" || first === "nuke") {
    action = first === "rollback" ? "restore" : first;
    profile = profile ?? argv[i + 1] ?? "web";
  } else if (first === "allowlist" || first === "allow" || first === "disallow") {
    action = first;
    profile = profile ?? argv[i + 1] ?? "web";
  } else {
    profile = profile ?? first ?? "web";
    const dshArgs = first === undefined ? [] : argv.slice(i + 1);
    return { action: "guard", profile, dshArgs, opts };
  }

  return { action, profile, dshArgs: [], opts };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const parsed = parseArgs(process.argv.slice(2));
if (parsed === null) process.exit(0);

const { action, profile, dshArgs, opts } = parsed;
const sDir = snapDir(profile);

if (action === "snapshot") {
  writeSnapshot(sDir, readConfig(profileDir(profile)));
  process.stdout.write(`[dsh-dog] ✔ 已把 ${profile} 当前配置标记为「已知可用」：${sDir}\n`);
  process.exit(0);
}

if (action === "restore") {
  const good = readSnapshot(sDir);
  if (good === null) {
    process.stderr.write(`[dsh-dog] 没有可用的快照：${sDir}\n`);
    process.exit(1);
  }
  restoreSnapshot(profileDir(profile), good);
  if (!opts.noInstall) runPnpmInstall(profileDir(profile));
  process.stdout.write(`[dsh-dog] ✔ 已把 ${profile} 硬回滚到上次可用配置（快照后新增的插件会被移除）。\n`);
  process.exit(0);
}

if (action === "status") {
  process.exit(printStatus(profile));
}

if (action === "huifu") {
  if (!opts.backupDir) {
    process.stderr.write("[dsh-dog] 请用 --backup-dir <路径> 指定备份目录（如 D:\\backup\\dsh）。\n");
    process.exit(1);
  }
  process.exit(runHuifu(profile, opts.backupDir));
}

// nuke：手动「禁用所有第三方插件」（仅用户显式触发；自动看门狗不会全禁）
if (action === "nuke") {
  const pDir = profileDir(profile);
  const manifest = readManifest(readConfig(pDir));
  const keepList = opts.keep ? String(opts.keep).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const count = nukeAllThirdParty(pDir, manifest, keepList);
  const keepNames = [...HARD_KEEP, ...keepList];
  process.stdout.write(
    `[dsh-dog] ✔ 已手动禁用第三方插件（${count} 个，保留下载、不删除），仅保留内置核心与硬保护插件（${keepNames.length ? keepNames.join(" / ") : "无"}）。\n`,
  );
  process.stdout.write("[dsh-dog] 提示：如需恢复，请用 `dsh-dog restore <profile>` 回滚到上次可用快照。\n");
  process.exit(0);
}

// allow / disallow / allowlist：管理白名单（放前面处理，不触发 guard）
if (action === "allowlist") {
  const list = readAllowlist(profile);
  process.stdout.write(`[dsh-dog] ${profile} 的白名单（启动失败时保留、不禁用）：\n`);
  if (list.size === 0) process.stdout.write("  （空）\n");
  else for (const name of [...list].sort()) process.stdout.write(`  - ${name}\n`);
  process.stdout.write(`\n白名单文件：${allowlistPath(profile)}\n`);
  process.exit(0);
}

// `allow web pkg` / `disallow web pkg`：从原始 argv 里取 pkg
const rawIdx = process.argv.indexOf(action);
const raw = process.argv.slice(rawIdx + 1); // [profile, pkg...]
const targetProfile = raw[0] || profile;
const pkgs = raw.slice(1).filter((p) => p && !p.startsWith("--"));
if (action === "allow" || action === "disallow") {
  if (pkgs.length === 0) {
    process.stderr.write(`[dsh-dog] 用法：dsh-dog ${action} <profile> <bundle包名…>\n`);
    process.exit(1);
  }
  let changed = 0;
  for (const pkg of pkgs) {
    const ok = action === "allow" ? allowPlugin(targetProfile, pkg) : disallowPlugin(targetProfile, pkg);
    if (ok) changed += 1;
    process.stdout.write(
      `[dsh-dog] ${action === "allow" ? "已加入" : "已移出"}白名单：${pkg}${ok ? "" : "（无变化）"}\n`,
    );
  }
  process.stdout.write(`[dsh-dog] ✔ ${changed} 项变更。白名单文件：${allowlistPath(targetProfile)}\n`);
  process.exit(0);
}

export { parsePluginFromStderr, computeOffenders, readConfig, pickDisableCandidates, allThirdPartyBundles, nukeAllThirdParty, detectPortBusy, listBackups, restoreFromBackup, runHuifu, listNodeModulesBackups, nearestNodeModulesBackup, readAllowlist, allowPlugin, disallowPlugin };

// 只有作为 CLI 主入口直接运行时才启动看门狗（被 import 做测试时跳过）。
// Windows 上必须把 argv[1] 规范成与 import.meta.url 一致的绝对路径再比较（/ vs \、大小写）。
const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(pathToFileURL(process.argv[1])).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  guard(profile, dshArgs, opts).then((code) => {
    process.exitCode = code ?? 0;
  });
}
