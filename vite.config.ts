/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import glsl from 'vite-plugin-glsl'

export default defineConfig({
  // Deployed to GitHub Pages under /<repo>/, so assets must be relative.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    // `#include` support so colour functions are shared between shaders rather
    // than duplicated. See docs/SHADER_CONVENTIONS.md.
    //
    // removeDuplicatedImports is required, not a preference: a shared chunk
    // reached through two different include paths in one shader would otherwise
    // be emitted twice and fail to compile on duplicate function definitions.
    glsl({
      include: ['**/*.glsl', '**/*.vert', '**/*.frag'],
      removeDuplicatedImports: true,
      warnDuplicatedImports: false,
      // Keep shader source readable in devtools and byte-stable for goldens.
      minify: false,
    }),
  ],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
