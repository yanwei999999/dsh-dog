#!/usr/bin/env node
/**
 * 端到端测试：端口被占用（EADDRINUSE）时，看门狗只提示「请关闭其他 dsh 实例」，
 * 绝不禁用/移除任何插件 —— 即使当前配置相对快照有明显的新增插件（正常看门狗会禁用它们）。
 *
 * 场景：profile 里装了 3 个第三方插件（快照里只有 1 个 → p2/p3 都是「新增」），
 *       fake-port-busy 每次启动都报 EADDRINUSE。
 * 预期：输出端口占用提示 + 「关闭其他 dsh」指引；不出现任何「已禁用」提示；
 *       package.json 的 bundles 一个不少；cordis.patch.yml 不被追加禁用条目。
 *
 * 用法：node test/port-busy-e2e.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dogPath = join(here, "..", "dsh-dog.mjs");
const fakePath = join(here, "fake-port-busy.mjs");

const dshHome = mkdtempSync(join(tmpdir(), "dsh-dog-portbusy-"));
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

// 当前（出问题）：3 个第三方 → 按正常看门狗逻辑，p1 算「变更」、p2/p3 算「新增」，都会被列为候选
writeFileSync(join(profileDir, "package.json"), manifestStr([...BUILTIN, ...THIRD]));
writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: vision\n  disabled: true\n");
// 快照（已知可用）：只有 1 个第三方 p1
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

check("stderr 出现「端口被占用」提示", /端口被占用/.test(out));
check("提示包含占用地址 127.0.0.1:3080", /127\.0\.0\.1:3080/.test(out));
check("提示用户关闭其他 dsh 实例", /关闭其他 dsh/.test(out));
check("明确说明未禁用任何插件", /未禁用/.test(out));
check("没有出现「已禁用」插件提示", !/已禁用（未删除）插件/.test(out));
check("没有出现「禁用所有第三方插件」兜底", !/禁用所有第三方插件/.test(out));
check("退出码非 0（端口占用视为启动失败）", r.status === 1);

// 关键：一个插件都不许被动
const finalPkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
const finalBundles = finalPkg?.dsh?.profile?.bundles ?? [];
check("p1 仍保留在 bundles", finalBundles.includes("p1"));
check("p2 仍保留在 bundles", finalBundles.includes("p2"));
check("p3 仍保留在 bundles", finalBundles.includes("p3"));
const patch = readFileSync(join(profileDir, "cordis.patch.yml"), "utf8");
check("cordis.patch.yml 未被追加任何禁用条目", !/disabled: true\n- id:/.test(patch) && !/p\d\n  disabled: true/.test(patch));

console.log("\n" + (failures === 0 ? "🎉 E2E 全部通过" : `⚠ ${failures} 项失败`));
if (failures > 0) {
  console.log("\n--- 原始输出 ---\n" + out.slice(0, 2000));
}
process.exit(failures === 0 ? 0 : 1);
