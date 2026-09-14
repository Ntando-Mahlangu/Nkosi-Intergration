import { fileURLToPath } from "node:url";
import path from "node:path";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "public/**",
      "data/**",
      // ESLint's own bootstrap file — not part of either tsconfig project below.
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit project list (not `projectService: true`) because
        // projectService only auto-discovers files literally named
        // tsconfig.json — it won't find tsconfig.test.json (src/ + tests/)
        // on its own.
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // The two rules that would have caught a real bug this session: a
      // `void fn()` call whose fn threw (an unhandled rejection that
      // crashes the process), and an awaited call with no try/catch left
      // hanging a request. `checksVoidReturn: { arguments: false, returns:
      // false }` is typescript-eslint's own documented override for
      // Express: an async route handler passed straight to
      // `router.get(path, async (req, res) => {...})`, or returned from a
      // middleware factory like requireTenantAuth below, is the standard,
      // intentional pattern here, not a misuse — without the override,
      // every route handler and factory in this codebase would need
      // wrapping.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, returns: false } }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      // Off, with reasons — the recommendedTypeChecked defaults are tuned
      // for codebases with a schema-validation layer at every external
      // boundary. This one doesn't have one: webhook payloads (Twilio/
      // SendGrid, both untyped by their own SDKs), Postgres rows via
      // `pg`/`pg-mem`, and mocked SDK responses in tests are all
      // legitimately `any`-shaped, and the "unsafe" family would otherwise
      // flag most of src/webhooks/index.ts, src/store/postgres.ts, and the
      // test suite's mocks without pointing at an actual bug.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // The in-memory store classes (store/memory.ts) implement the same
      // Promise-returning interfaces as their Postgres counterparts without
      // needing to await anything internally — correct and required for
      // interface compatibility, not a smell.
      "@typescript-eslint/require-await": "off",
    },
  },
  eslintConfigPrettier
);
