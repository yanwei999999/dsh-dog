#!/usr/bin/env node
// 永远「端口被占用」的假 dsh：模拟已有另一个 dsh 实例占着端口时的启动失败。
// 看门狗应当识别出 EADDRINUSE，只提示用户关闭其他 dsh 实例，绝不禁用任何插件。
// 用法（由 port-busy-e2e.test.mjs 通过 DSH_BIN 拉起）：
//   node fake-port-busy.mjs <profile> <…dshArgs>
process.stderr.write("dsh: fatal load failure: Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n");
process.exit(1);
