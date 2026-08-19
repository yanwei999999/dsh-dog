#!/usr/bin/env node
// 永远失败的假 dsh：报一个「无法从错误文本解析出具体插件名」的错，
// 模拟烂到无法通过「逐步禁用」解决的 profile。看门狗重试用尽后，
// 因定位不到真凶 → 不做任何禁用/改动，提示用户手动排查。
// 无需真实 dsh。
// 用法（由 guard-e2e.test.mjs 通过 DSH_BIN 拉起）：
//   node fake-forever-fail.mjs <profile> <…dshArgs>
process.stderr.write("dsh: fatal load failure: plugin tree failed to load\n");
process.stderr.write("Error: loader entries failed to apply (no specific plugin identified)\n");
process.exit(1);
