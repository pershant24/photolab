/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import glsl from 'vite-plugin-glsl'

/**
 * Cross-origin isolation, for the dev and preview servers.
 *
 * The deployed copy gets these from `public/_headers`; a static file server
 * cannot, so they are set here too — otherwise the memory measurement works in
 * production and not in the tests that are supposed to verify it.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * `#include` support so colour functions are shared between shaders rather than
 * duplicated. See docs/SHADER_CONVENTIONS.md.
 *
 * `removeDuplicatedImports` is required, not a preference: a shared chunk reached
 * through two different include paths in one shader would otherwise be emitted
 * twice and fail to compile on duplicate function definitions.
 */
const shaders = () =>
  glsl({
    include: ['**/*.glsl', '**/*.vert', '**/*.frag'],
    removeDuplicatedImports: true,
    warnDuplicatedImports: false,
    // Keep shader source readable in devtools and byte-stable for goldens.
    minify: false,
  })

export default defineConfig({
  // Relative, so the built site works under a path prefix as well as at a root.
  base: './',
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
  plugins: [
    react(),
    tailwindcss(),
    shaders(),
  ],
  /**
   * Workers get their own plugin pipeline, and the export worker imports the
   * pass chain — which imports shaders. Without this the worker bundle reaches
   * a `.vert` file with no loader for it and the build fails on the first line
   * of GLSL it meets. The decode worker never hit this because it touches no
   * shader.
   */
  worker: {
    format: 'es',
    plugins: () => [shaders()],
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
