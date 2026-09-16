/**
 * Type shim for the inner pdf-parse entry point. We import
 * 'pdf-parse/lib/pdf-parse.js' (not the package root) because the root
 * index.js runs a self-test when `module.parent` is null, which crashes
 * under bundled / dynamic-import paths — see kb-ingest.ts and the
 * register-map API route. @types/pdf-parse only declares the root module.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse from 'pdf-parse';
  export default pdfParse;
}
