// Re-export google.maps types globally
// The @types/google.maps package uses a dot in its folder name,
// which prevents TypeScript from auto-discovering it.
// This file explicitly loads the declarations.
import '@types/google.maps';
