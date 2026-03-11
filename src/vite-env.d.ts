/// <reference types="vite/client" />

// Google Maps global types
// @types/google.maps provides namespace declarations but TypeScript
// can't auto-discover it due to the dot in the package name.
// We re-export the types and declare the global variable.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Window {
    google: typeof google;
  }
}
