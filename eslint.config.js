import globals from "globals";
import pluginJs from "@eslint/js";
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
    }
  },
  // pluginJs.configs.recommended,
  // {
  //   plugins: {
  //     jsdoc: jsdoc
  //   },
  //   rules: {
  //     "jsdoc/no-undefined-types": "warn",
  //   }
  // }
];