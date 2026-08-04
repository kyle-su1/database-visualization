import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // THE DATA-SOURCE BOUNDARY: sql.js may only be imported inside
    // src/datasource/sqljs/. Everything else must go through the
    // DataSource interface (src/datasource/types.ts).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['sql.js', 'sql.js/*'],
              message:
                'sql.js may only be imported inside src/datasource/sqljs/ — everything else depends on the DataSource interface.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/datasource/sqljs/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
