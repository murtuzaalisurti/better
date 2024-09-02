import globals from "globals";
import google from "eslint-config-google";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      ".husky/**",
      "eslint.config.js",
      ".github/**",
    ]
  },
  {
    languageOptions: {
      globals: globals.node
    },
    plugins: {
      jsdoc,
      google,
      prettier
    },
    rules: {
      "jsdoc/no-undefined-types": "warn",
      "no-irregular-whitespace": "error",
      "no-unreachable": "error",
      "no-unused-vars": "warn",
      "no-empty-function": "error",
      "no-use-before-define": "error",
      "no-var": "warn",
      "no-empty": "error",
      "prefer-const": "warn",
      camelcase: "off",
      "new-cap": "off",
      "no-invalid-this": "warn",
    }
  },
];