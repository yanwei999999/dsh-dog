// 查询仓库当前可见性
import { execSync } from "node:child_process";
const cred = execSync('cmd /c echo username=git&echo host=github.com&echo protocol=https&git credential fill 2>nul', { encoding: "utf8" });
let token = "";
for (const l of cred.split(/\r?\n/)) if (l.startsWith("password=")) token = l.slice(9);
if (!token) { console.log("无 token"); process.exit(1); }

const hdr = { 'User-Agent': 'dsh-agent', 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' };
const repos = ["baomi", "dsh-dog", "dsh-guard"];
for (const repo of repos) {
  try {
    const r = await (await fetch(`https://api.github.com/repos/yanwei999999/${repo}`, { headers: hdr })).json();
    console.log(`${repo}: private=${r.private}  description=${r.description}`);
  } catch (e) {
    console.log(`${repo}: 查询失败 ${e.message}`);
  }
}
