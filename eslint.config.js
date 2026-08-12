const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        // `const { payments: _p, ...basic } = row` is how this codebase strips
        // fields before returning a record. The omitted binding is the POINT of
        // the expression, so flagging it as unused is noise.
        ignoreRestSiblings: true,
        // `catch (_)` is a deliberate "it failed and the reason does not
        // matter". Anything named otherwise is still flagged, so a genuinely
        // swallowed error still shows up.
        caughtErrorsIgnorePattern: '^_',
      }],

      'no-constant-condition': ['warn', { checkLoops: false }],
      'prefer-const': 'warn',
      'no-var': 'warn',

      // `x == null` is the idiomatic single test for "null or undefined", and
      // rewriting it to `x === null` silently changes behaviour — undefined
      // would stop matching. Every one of the 155 eqeqeq warnings this rule
      // raised was that idiom; not one was a genuine loose comparison. So
      // `===` stays required everywhere EXCEPT against null.
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
    },
  },
  {
    // Command-line tooling: stdout IS the interface here, so console is the
    // correct call rather than a stray debug statement. Scoped to these entry
    // points rather than relaxed across the app.
    files: ['scripts/**/*.js', 'src/db/migrate.js', 'src/db/seed.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'uploads/'],
  },
];
