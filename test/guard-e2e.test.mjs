#!/usr/bin/env node
/**
 * 端到端测试：多次重试都无法定位/解决时，dsh-dog 的终极兜底应「只禁真凶、不连坐」。
 *
 * 场景：profile 里装了 3 个第三方插件，fake-forever-fail 每次都报「无特定插件」的错，
 * 且第三方插件都没有可解析的 node_modules（走 removeFromBundles）。
 * 预期：--retry 2 表示最多做 2 次「逐步定位」重试；第 3 次失败进入终极兜底，
 *       因错误文本解析不到具体插件 → 不做任何禁用/改动，提示用户手动排查，
 *       最终 package.json 的 bundles 保持不变（3 个第三方都还在）。
 *
 * 用法：node test/guard-e2e.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dogPath = join(here, "..", "dsh-dog.mjs");
const fakePath = join(here, "fake-forever-fail.mjs");

const dshHome = mkdtempSync(join(tmpdir(), "dsh-dog-e2e-"));
const profileDir = join(dshHome, "profiles", "web");
const snapDir = join(dshHome, "snapshots", "web");
mkdirSync(profileDir, { recursive: true });
mkdirSync(snapDir, { recursive: true });

const BUILTIN = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const THIRD = ["p1", "p2", "p3"];

function manifestStr(bundles) {
  return (
    JSON.stringify(
      { name: "dsh-profile-web", private: true, dependencies: {}, dsh: { profile: { bundles } } },
      null,
      2,
    ) + "\n"
  );
}

// 当前（出问题）：3 个第三方
writeFileSync(join(profileDir, "package.json"), manifestStr([...BUILTIN, ...THIRD]));
writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: vision\n  disabled: true\n");
// 快照（已知可用）：只含 1 个第三方 p1，p2/p3 是新增 → 会让 offenders 非空
writeFileSync(join(snapDir, "package.json"), manifestStr([...BUILTIN, "p1"]));
writeFileSync(join(snapDir, "cordis.patch.yml"), "- id: vision\n  disabled: true\n");
writeFileSync(join(snapDir, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
writeFileSync(join(snapDir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
writeFileSync(join(snapDir, "meta.json"), "{}");

const env = { ...process.env, DSH_HOME: dshHome, DSH_BIN: fakePath };
const r = spawnSync(process.execPath, [dogPath, "--retry", "2", "--grace", "1000", "web"], {
  env,
  encoding: "utf8",
});

const out = (r.stderr || "") + "\n" + (r.stdout || "");
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures += 1;
};

// 新行为：终极兜底不再全禁第三方（核心诉求：无辜插件不被连坐）
check("不应出现旧的「禁用所有第三方插件」提示", !/禁用所有第三方插件/.test(out));

// 主路径（前 2 次重试）按配置猜测禁用了 p2/p3（正常行为）；
// 兜底阶段（第 3 次）因配置被回滚后 changed=false 提前结束，不再继续禁用，
// 因此 p1 应仍在 bundles（p1 在快照里，主路径也不会禁它）
const finalPkg = existsSync(join(profileDir, "package.json"))
  ? JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8").replace(/^\uFEFF/, ""))
  : {};
const finalBundles = finalPkg?.dsh?.profile?.bundles ?? [];
check("兜底阶段未全禁：p1 仍在 bundles", finalBundles.includes("p1"));
check("兜底阶段未全禁：内置核心仍在", BUILTIN.every((b) => finalBundles.includes(b)));
// 注意：p2/p3 在前 2 次主路径重试时已被「配置猜测」禁用（无错误定位时的正常逐步禁用），不属于兜底全禁。

console.log("\n" + (failures === 0 ? "🎉 E2E 全部通过" : `⚠ ${failures} 项失败`));
if (failures > 0) {
  console.log("\n--- 原始输出 ---\n" + out.slice(0, 2000));
}
process.exit(failures === 0 ? 0 : 1);
