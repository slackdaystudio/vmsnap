module.exports = {
    "parser": '@babel/eslint-parser',
    "parserOptions": {
        "ecmaVersion": 13,
        "requireConfigFile": false,
        "babelOptions": {
          "parserOpts": {
            "plugins": ["importAssertions"]
          }
        }
      },
      "extends": "eslint:recommended",
      "env": {
        "es6": true
    },
};