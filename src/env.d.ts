// Replaced by build.mjs with package.json's version.
declare const __APP_VERSION__: string;

// The built-in font (src/assets), as base64; build.mjs's loader makes it so.
declare module '*.ttf' {
  const data: string;
  export default data;
}
