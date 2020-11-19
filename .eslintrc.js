module.exports = {
  env: {
    node: true,
  },
  root: true,
  parser: "@typescript-eslint/parser",
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
    "prettier/@typescript-eslint",
  ],
  ignorePatterns: ["dist/**/*"],
};
