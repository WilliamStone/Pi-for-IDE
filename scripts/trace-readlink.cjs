// 构建诊断：谁在 realpath/lstat/readlink Temp 路径。EPERM 的 readlink 是
// libuv 层调用名，JS 层入口可能是 realpath*/lstat/stat——全部打桩。
// NODE_OPTIONS="--require <this>" 预载，子进程继承 env 同样生效。
const fs = require("fs");
const seen = new Set();
const hit = (s) => /Temp[\\/]|AppData.Local.Temp/i.test(String(s));
function report(tag, p) {
  const s = `${tag}:${p}`;
  if (seen.has(s)) return;
  seen.add(s);
  console.error(`\n[TRACE ${tag}] ${p}\n${new Error().stack}`);
}
function wrap(obj, name, tag, isDirProbe) {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (p, ...rest) {
    if (hit(p)) {
      if (isDirProbe || /Temp[\\/]/.test(String(p))) report(tag, p);
    }
    return orig.call(this, p, ...rest);
  };
}
for (const n of ["realpathSync", "lstatSync", "statSync", "readlinkSync", "readdirSync"]) {
  wrap(fs, n, n, true);
}
for (const n of ["realpath", "lstat", "stat", "readlink", "readdir"]) {
  wrap(fs, n, n, true);
  wrap(fs.promises, n, "promises." + n, true);
}
// graceful-fs 若被加载也会走同一 fs——无需单独补丁（它包的是同一对象）。
