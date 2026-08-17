import eslint from "@eslint/js";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import promisePlugin from "eslint-plugin-promise";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsFiles = ["**/*.ts", "**/*.tsx"];

export default tseslint.config(
    {
        ignores: [
            ".tmp/**",
            "node_modules/**",
            "dist/**",
            "**/*.d.ts",
            "**/*.test.ts",
            "**/__fixtures__/**",
        ],
    },
    {
        files: tsFiles,
        extends: [
            eslint.configs.recommended,
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            importX.flatConfigs.recommended,
            importX.flatConfigs.typescript,
            promisePlugin.configs["flat/recommended"],
            nodePlugin.configs["flat/recommended-module"],
            unicorn.configs.recommended,
        ],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: { ...globals.node },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        settings: {
            node: {
                version: ">=22.19.0",
                tryExtensions: [".ts", ".js", ".json", ".node", ".mjs", ".cjs"],
            },
            "import-x/resolver-next": [
                createTypeScriptImportResolver({
                    project: "./tsconfig.json",
                    alwaysTryTypes: true,
                }),
                createNodeResolver(),
            ],
        },
        rules: {
            "no-console": "off",
            "no-debugger": "error",
            "import-x/no-duplicates": "error",
            "n/no-missing-import": "off",
            "n/no-unpublished-import": "off",
            "n/no-unpublished-require": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "unicorn/expiring-todo-comments": "off",
            "unicorn/no-null": "off",
            "unicorn/no-array-callback-reference": "off",
            "unicorn/prefer-module": "error",
            "unicorn/prevent-abbreviations": "off",
            "unicorn/switch-case-braces": "error",
            "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { prefer: "type-imports", fixStyle: "separate-type-imports" },
            ],
            "@typescript-eslint/no-misused-promises": [
                "error",
                { checksVoidReturn: { attributes: false } },
            ],
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/restrict-template-expressions": [
                "error",
                { allowBoolean: true, allowNumber: true },
            ],
            "@typescript-eslint/no-base-to-string": "warn",
            "@typescript-eslint/prefer-regexp-exec": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "unicorn/prefer-single-call": "off",
            "unicorn/consistent-function-scoping": "off",
            "unicorn/prefer-ternary": "off",
            "unicorn/no-for-loop": "off",
            "unicorn/no-nested-ternary": "off",
            "unicorn/empty-brace-spaces": "off",
            "unicorn/numeric-separators-style": "off",
            "unicorn/prefer-string-raw": "off",
            "unicorn/prefer-string-replace-all": "off",
            "@typescript-eslint/prefer-for-of": "off",
            "@typescript-eslint/no-empty-function": "off",
            curly: ["error", "all"],
            "brace-style": ["error", "allman"],
            "one-var": ["error", "never"],
            "multiline-ternary": ["error", "always-multiline"],
            "@typescript-eslint/explicit-member-accessibility": "off",
            "max-statements-per-line": ["error", { max: 1 }],
            "import-x/order": [
                "error",
                {
                    groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
                    "newlines-between": "always",
                    alphabetize: { order: "asc", caseInsensitive: true },
                },
            ],
            "comma-dangle": "off",
            "@typescript-eslint/no-unnecessary-condition": [
                "error",
                { allowConstantLoopConditions: "only-allowed-literals" },
            ],
            "padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "*", next: ["class", "function", "export"] },
                { blankLine: "always", prev: ["class", "function"], next: "*" },
                { blankLine: "always", prev: "*", next: ["if", "for", "while", "do", "switch", "try"] },
                { blankLine: "always", prev: ["if", "for", "while", "do", "switch", "try"], next: "*" },
                { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
                { blankLine: "any", prev: ["import"], next: ["import"] },
                { blankLine: "always", prev: "import", next: ["const", "let", "var", "function", "class", "export"] },
            ],
            "import-x/first": "error",
            "import-x/exports-last": "off",
            "@typescript-eslint/member-ordering": "off",
        },
    },
);
