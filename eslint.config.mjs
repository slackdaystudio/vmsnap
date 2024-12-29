import babelParser from "@babel/eslint-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [...compat.extends("eslint:recommended"), {
    languageOptions: {
        globals: {},
        parser: babelParser,
        ecmaVersion: 13,
        sourceType: "module",
        parserOptions: {
            requireConfigFile: false,
            babelOptions: {
                parserOpts: {
                    plugins: ["importAssertions"],
                },
            },
        },
    },
}];