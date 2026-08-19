#!/usr/bin/env node
/**
 * 针对 dsh-dog 的 parsePluginFromStderr 的行为验证：
 * 用真实（或贴近真实）的 dsh 启动报错样本来确认「能从错误里定位到真正报错的插件」。
 *
 * 覆盖重点（来自一次真实事故）：
 *   - dsh-vault 的 Junction 坏了 → 报 Cannot find package 'dsh-vault'。
 *     旧版 dsh-dog 只会按「相对快照新增插件」猜测而误禁用无辜的新插件；
 *     新版应从错误文本解析出 dsh-vault，而不是 dsh-market。
 *
 * 用法：node test/parse-plugin.test.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginFromStderr, pickDisableCandidates, computeOffenders, allThirdPartyBundles, detectPortBusy } from "../dsh-dog.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 真实样本 1：dsh-vault 链接损坏（本次事故的核心场景）
const SAMPLE_DASH_VAULT = `Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-vault (dsh-vault): Cannot find package 'dsh-vault' imported from C:\\Users\\Administrator\\.dsh\\profiles\\web\\
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dsh-vault' imported from C:\\Users\\Administrator\\.dsh\\profiles\\web\\
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
    at packageResolve (node:internal/modules/esm/resolve:768:81)`;

// 真实样本 2：某第三方插件在加载阶段直接崩溃（did not activate）
const SAMPLE_PLUGIN_CRASH = `dsh: plugin tree failed to load: broken-plugin did not activate
    at Entry._init (...)
Error [ERR_MODULE_NOT_FOUND]`;

// 真实样本 3：错误里没有明确插件名（靠兜底 imported from …node_modules\x）
const SAMPLE_IMPORTED_FROM = `Error: Cannot find package 'dsh-emoji' imported from C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\.pnpm\\some-pkg@1.0.0\\node_modules\\some-pkg\\
File (C:/...)`;

// 真实样本 4：空 / 无关错误（不应解析出任何插件）
const SAMPLE_EMPTY = `error: unknown option '--foo'`;

let failures = 0;

function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) {
    failures += 1;
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实得: ${JSON.stringify(got)}`);
  }
}

// 1) 真凶是 dsh-vault（link 坏），绝不能被猜成新的 @dsh-market/plugin
let got = parsePluginFromStderr(SAMPLE_DASH_VAULT, "web");
check("Cannot find package 'dsh-vault' 应定位到 dsh-vault", got, ["dsh-vault"]);

// 2) 明确的插件崩溃名
got = parsePluginFromStderr(SAMPLE_PLUGIN_CRASH, "web");
check("did not activate 应定位到 broken-plugin 或更高层入口", got.includes("broken-plugin"), true);

// 3) imported from …node_modules 兜底
got = parsePluginFromStderr(SAMPLE_IMPORTED_FROM, "web");
check("imported from …node_modules\\dsh-emoji 兜底", got.includes("dsh-emoji"), true);

// 4) 无关错误
got = parsePluginFromStderr(SAMPLE_EMPTY, "web");
check("无关错误不应解析出插件", got, []);

// ─────────────────────────────────────────────────────────────
// 集成决策：真正报错插件优先于「配置新增猜测」被禁用
// （本次事故：坏的是 dsh-vault 链接，但配置层新增的是 @dsh-market/plugin）
// ─────────────────────────────────────────────────────────────
const baseManifest = (bundles, deps = {}) => ({
  dependencies: deps,
  dsh: { profile: { bundles } },
});

// 快照（已知可用）：有 dsh-vault，没有 @dsh-market/plugin
const goodManifest = baseManifest(
  ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-vault"],
  { "dsh-vault": "link:E:\\x\\dsh-vault" },
);
// 当前（出问题）：新增了 @dsh-market/plugin（无辜），真正的元凶是 dsh-vault 坏链接
const currentManifest = baseManifest(
  ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-vault", "@dsh-market/plugin"],
  { "dsh-vault": "link:E:\\x\\dsh-vault", "@dsh-market/plugin": "^0.2.1" },
);
// 真实启动错误：指向 dsh-vault
const realStderr = SAMPLE_DASH_VAULT;

const { combined, fromError } = pickDisableCandidates(currentManifest, goodManifest, realStderr, "web");
check("fromError 应定位到 dsh-vault（真正元凶）", fromError, ["dsh-vault"]);
check("combined 应包含 dsh-vault", combined.includes("dsh-vault"), true);
check("combined 不应误含无辜的 @dsh-market/plugin", combined.includes("@dsh-market/plugin"), false);

// 反向对照：如果完全没有错误文本，则回退到配置猜测（会带上 @dsh-market/plugin）
const noErr = pickDisableCandidates(currentManifest, goodManifest, "", "web");
check("无错误文本时回退到配置猜测 @dsh-market/plugin", noErr.combined, ["@dsh-market/plugin"]);

// ─────────────────────────────────────────────────────────────
// 终极兜底：多次重试仍失败 →「禁用所有第三方插件」
// ─────────────────────────────────────────────────────────────
const mixedManifest = baseManifest(
  ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-vault", "dsh-balance", "@liustack/modelens"],
  {},
);
const allThird = allThirdPartyBundles(mixedManifest);
check(
  "allThirdPartyBundles 只列第三方、排除 @deepseek-ai/*",
  allThird,
  ["dsh-vault", "dsh-balance", "@liustack/modelens"],
);

const onlyBuiltin = allThirdPartyBundles(
  baseManifest(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]),
);
check("只有内置核心时应返回空（无第三方可禁）", onlyBuiltin, []);

// ─────────────────────────────────────────────────────────────
// 端口被占用（EADDRINUSE）：看门狗必须识别出来，绝不参与插件禁用
// ─────────────────────────────────────────────────────────────

// 真实形态：installFailLoud 打出的 fatal load failure 里带着 EADDRINUSE
const SAMPLE_PORT_BUSY = `dsh: fatal load failure: Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
    at Server.setupListenHandle (node:net:1900:21)
    at Server.listen (node:net:2042:10)`;

got = detectPortBusy(SAMPLE_PORT_BUSY);
check("EADDRINUSE 应识别为端口占用并提取地址 127.0.0.1:3080", got, "127.0.0.1:3080");

// 只有 EADDRINUSE 关键字、没有明确地址 → 也识别为端口占用（返回未知地址）
got = detectPortBusy("Error: listen EADDRINUSE");
check("只有 EADDRINUSE 关键字也应识别（地址未知）", got, "未知地址");

// 端口占用即使出现在插件报错样本里也不应被误判（EADDRINUSE 是强信号，这里验证普通插件错）
got = detectPortBusy(SAMPLE_DASH_VAULT);
check("普通插件报错（Cannot find package）不应判定为端口占用", got, null);

got = detectPortBusy(SAMPLE_EMPTY);
check("无关错误不应判定为端口占用", got, null);

got = detectPortBusy("");
check("空 stderr 不应判定为端口占用", got, null);

// ─────────────────────────────────────────────────────────────
// nuke（手动全禁）：nukeAllThirdParty 应禁用所有第三方、保留内置
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { nukeAllThirdParty } from "../dsh-dog.mjs";

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-dog-nuke-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm, { recursive: true });
  // 真实 package.json（3 个第三方 + dsh-toolbox）
  const pkgPath = join(dir, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify(
      { name: "web", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "p1", "p2", "p3", "dsh-toolbox", "meow-memory"] } } },
      null,
      2,
    ),
  );
  // p1/p2 有 cordis.patch.yml（能提取 entry id）；p3 无 node_modules（走 removeFromBundles）
  for (const p of ["p1", "p2"]) {
    const pkgDir = join(nm, p);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: p, dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    );
    writeFileSync(join(pkgDir, "cordis.patch.yml"), `- insert:\n    - id: ${p}\n      name: ${p}\n`);
  }
  // dsh-toolbox 目录存在（有 patch，能提取 entry id）—— 验证它被保留
  {
    const pkgDir = join(nm, "dsh-toolbox");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "dsh-toolbox", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    );
    writeFileSync(join(pkgDir, "cordis.patch.yml"), `- insert:\n    - id: dsh-toolbox\n      name: dsh-toolbox\n`);
  }
  // meow-memory 目录存在 —— 硬保护：nuke 时也保留
  {
    const pkgDir = join(nm, "meow-memory");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "meow-memory", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    );
    writeFileSync(join(pkgDir, "cordis.patch.yml"), `- insert:\n    - id: meow-memory\n      name: meow-memory\n`);
  }
  const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
  const count = nukeAllThirdParty(dir, manifest, ["dsh-toolbox", "meow-memory"]); // 模拟本机 DSH_DOG_KEEP
  check("nuke 应处理 3 个第三方（keep 指定插件保留）", count, 3);
  // p1/p2 → 追加 disabled 到 profile 的 cordis.patch.yml
  const patchPath = join(dir, "cordis.patch.yml");
  const patchTxt = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  check("p1 被追加禁用", patchTxt.includes("id: p1") && patchTxt.includes("disabled: true"), true);
  check("p2 被追加禁用", patchTxt.includes("id: p2") && patchTxt.includes("disabled: true"), true);
  check("内置核心不受影响", !patchTxt.includes("dsh-base"), true);
  check("dsh-toolbox 不被禁用（硬保护）", !patchTxt.includes("id: dsh-toolbox") || !patchTxt.includes("disabled: true"), true);
  check("meow-memory 不被禁用（硬保护）", !patchTxt.includes("id: meow-memory") || !patchTxt.includes("disabled: true"), true);
  // p3 → 从 bundles 移除
  const after = JSON.parse(readFileSync(pkgPath, "utf8"));
  check("p3 从 bundles 移除", !after.dsh.profile.bundles.includes("p3"), true);
  check("dsh-toolbox 仍在 bundles（硬保护）", after.dsh.profile.bundles.includes("dsh-toolbox"), true);
  check("meow-memory 仍在 bundles（硬保护）", after.dsh.profile.bundles.includes("meow-memory"), true);
  check("内置核心仍在 bundles", after.dsh.profile.bundles.includes("@deepseek-ai/dsh-base"), true);
}

// 默认 HARD_KEEP 为空：不带 keep 时 nuke 应处理全部第三方（不硬编码任何插件，不影响其他用户）
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-dog-nuke-empty-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm, { recursive: true });
  const pkgPath = join(dir, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify(
      { name: "web", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "p1", "p2"] } } },
      null,
      2,
    ),
  );
  const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
  const count = nukeAllThirdParty(dir, manifest); // 不传 keep → HARD_KEEP 默认空
  check("默认无硬保护时 nuke 处理全部第三方（2 个）", count, 2);
  const after = JSON.parse(readFileSync(pkgPath, "utf8"));
  check("p1 被移除", !after.dsh.profile.bundles.includes("p1"), true);
  check("p2 被移除", !after.dsh.profile.bundles.includes("p2"), true);
}

console.log("\n" + (failures === 0 ? "🎉 全部通过" : `⚠ ${failures} 项未通过`));
process.exit(failures === 0 ? 0 : 1);
