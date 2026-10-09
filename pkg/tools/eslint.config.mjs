// typescript-eslint, strict and type-checked, over src.
//   cd pkg && npm run lint

import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["**/*.d.ts"] }, ...tseslint.configs.strictTypeChecked, {
  languageOptions: {
    parserOptions: { project: "./tsconfig.json", tsconfigRootDir: fileURLToPath(new URL("..", import.meta.url)) },
  },
  rules: {
    // The reference's messages spell counts and limits as numbers
    "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    // A rule closure, `each(() => check(x))`, is the house style of the models
    "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
  },
});
