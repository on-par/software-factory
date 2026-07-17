// The real config lives in tools/lint so its typescript-eslint imports resolve
// against that workspace's nested TypeScript 5.x (root TS is the native compiler).
export { default } from './tools/lint/eslint.config.mjs';
