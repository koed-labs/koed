import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "**/.venv/**",
      "**/dist/**",
      "apps/desktop/dist-electron/**",
      "apps/desktop/dist-types/**",
      "apps/desktop/release/**",
      "**/coverage/**",
      "**/target/**",
      "node_modules/**"
    ]
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir
      }
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  {
    files: ["apps/explorer/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: [
      "apps/api/src/**/*.ts",
      "apps/worker/src/**/*.ts",
      "packages/*/src/**/*.ts"
    ],
    ignores: ["**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/require-await": "error"
    }
  },
  {
    files: [
      "apps/api/src/server.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.spec.ts",
      "packages/*/tests/**/*.test.ts",
      "packages/*/tests/**/*.spec.ts"
    ],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error"
    }
  },
  {
    files: [
      "eslint.config.js",
      "*.config.ts",
      "apps/*/env-config.ts",
      "apps/*/vite.config.ts",
      "apps/api/**/*.ts",
      "apps/worker/**/*.ts",
      "packages/**/*.ts",
      "packages/*/scripts/**/*.{js,mjs,cjs}",
      "scripts/**/*.{js,mjs,cjs}"
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest
      }
    }
  },
  prettier
);
