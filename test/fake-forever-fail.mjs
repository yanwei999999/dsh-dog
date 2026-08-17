#!/usr/bin/env node
// 永远失败的假 dsh：模拟一个烂到无法通过「逐步禁用」解决的 profile，看门狗必须走
// 「禁用所有第三方插件」的终极兜底。无需真实 dsh。
// 用法（由 guard-e2e.test.mjs 通过 DSH_BIN 拉起）：
//   node fake-forever-fail.mjs <profile> <…dshArgs>
process.stderr.write("dsh: plugin tree failed to load: some-plugin did not activate\n");
process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'mystery-pkg'\n");
process.exit(1);
