import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// 本目录独立的 flat 配置——根仓库 eslint.config.js 是 Next 版，对扩展
// devDeps（eslint 8 + typescript-eslint 7）不兼容，不能让 eslint 向上
// 冒泡到它。
export default [
  { ignores: ["out/**", "src/**/*.test.mjs"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...(tsPlugin.configs["flat/recommended"]?.rules ?? tsPlugin.configs.recommended.rules),
      // 务实档：扩展代码允许 any/non-null-assertion（既有风格），未用变量仍查。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
