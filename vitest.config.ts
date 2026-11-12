import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This checkout is a read-only PHP oracle. Its frontend and vendored JS
    // have separate runners and must not become tests of the Node backend.
    exclude: [...configDefaults.exclude, '**/.oracle/**'],
  },
});
