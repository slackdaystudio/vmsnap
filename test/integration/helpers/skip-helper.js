import { checkLibvirtAvailable } from './vm-manager.js';

/**
 * Creates a test environment check that can be used in beforeAll/beforeEach
 * to skip tests when libvirt is not available.
 *
 * Usage in test file:
 *
 * ```js
 * import { createLibvirtCheck } from '../helpers/skip-helper.js';
 *
 * const libvirtCheck = createLibvirtCheck();
 *
 * describe('My Tests', () => {
 *   beforeAll(async () => {
 *     await libvirtCheck.init();
 *     if (!libvirtCheck.available) return;
 *     // ... rest of setup
 *   });
 *
 *   beforeEach((context) => {
 *     libvirtCheck.skipIfUnavailable(context);
 *   });
 * });
 * ```
 */
export function createLibvirtCheck() {
  let available = false;
  let error = null;
  let initialized = false;

  return {
    get available() {
      return available;
    },

    get error() {
      return error;
    },

    async init() {
      if (initialized) return available;

      const result = await checkLibvirtAvailable();
      available = result.available;
      error = result.error;
      initialized = true;

      if (!available) {
        console.log('\n⚠️  Skipping integration tests: libvirt not available');
        console.log(`   Reason: ${error}\n`);
      }

      return available;
    },

    skipIfUnavailable(context) {
      if (!available) {
        context.skip();
      }
    },
  };
}

export default createLibvirtCheck;
