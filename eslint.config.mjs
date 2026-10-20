import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // demo/ is a separate Next.js project with its own lint config.
  { ignores: ["demo/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    // vscode-extension 编译输出（gitignored，本地 tsc -p . 产物）不进入 lint。
    ignores: ["vscode-extension/out/**", "vscode-extension/node_modules/**"],
  },
  {
    // 纯 Node CJS 脚本允许 require()：扩展打包脚本、仓库构建/打包脚本、
    // .cjs 文件——这些文件随 Node 直接运行，不是被 import 的模块。
    files: ["vscode-extension/scripts/**/*.js", "scripts/**", "**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
