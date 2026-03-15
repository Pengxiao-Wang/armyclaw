// Ambient WebAssembly type declarations for Node.js
// Node.js includes WebAssembly globally but TypeScript needs DOM/WebWorker lib to see the types.
// This brings in just the WebAssembly namespace without pulling in the full DOM lib.
/// <reference lib="webworker" />
