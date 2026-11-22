import vue from 'eslint-plugin-vue';

export default [
  ...vue.configs['flat/recommended'],
  {
    files: ['frontend/src/**/*.{js,vue}'],
    rules: {
      'no-constant-condition': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
