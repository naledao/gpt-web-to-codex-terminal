/**
 * `?raw` imports hand back the file's text at build time. Vite supports this,
 * but the main-process TS project does not include Vite's client types, so the
 * module shape is declared here.
 */
declare module '*?raw' {
  const content: string
  export default content
}
