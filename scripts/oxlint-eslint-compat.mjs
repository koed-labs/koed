// Preserve the four ESLint rule implementations that lack equivalent native coverage.
import { builtinRules } from "eslint/use-at-your-own-risk";

const names = [
  "no-dupe-args",
  "no-octal",
  "no-unsafe-optional-chaining",
  "no-useless-assignment"
];

export default {
  rules: Object.fromEntries(names.map((name) => [name, builtinRules.get(name)]))
};
