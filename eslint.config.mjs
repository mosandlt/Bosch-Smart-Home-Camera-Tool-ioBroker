import config from "@iobroker/eslint-config";

export default [
    ...config,
    {
        // Build output and generated assets are not linted
        ignores: [
            "build/**",
            "admin/build/**",
            "admin/words.js",
            "node_modules/**",
            "coverage/**",
            "test/**",
            ".eslintrc.json",
        ],
    },
    {
        // JSDoc backfill is incremental — many handlers have @param tags without
        // descriptions but the parameter names are self-explanatory. Downgrade to
        // warnings so they do not block CI lint until the doc sweep lands.
        rules: {
            "jsdoc/no-blank-blocks": "off",
            "jsdoc/require-param": "warn",
            "jsdoc/require-param-description": "warn",
            "jsdoc/require-param-type": "off",
            "jsdoc/require-returns": "warn",
            "jsdoc/require-returns-description": "warn",
        },
    },
];
