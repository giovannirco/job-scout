import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

// The linter needs the TS 6 compiler API. This workspace isolates it from the
// application's native TS 7 compiler; pnpm typecheck still uses TS 7.
export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.data/**", "**/migrations/meta/**", "packages/lint-config/**"] },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "scripts/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      // Honor stdin/editor buffers too, not just immutable CLI disk snapshots.
      parserOptions: { project: "./tsconfig.json", disallowAutomaticSingleRunInference: true, tsconfigRootDir: fileURLToPath(new URL("../../", import.meta.url)) },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "no-debugger": "error",
      "no-control-regex": "error",
      "prefer-regex-literals": "warn",
    },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "ImportDeclaration[importKind!='type'][source.value=/^node:/] > ImportSpecifier[importKind!='type']",
        message: "Shared modules are evaluated by the browser. Use a namespace import and defer Node access until a server-only function is called.",
      }],
    },
  },
];
