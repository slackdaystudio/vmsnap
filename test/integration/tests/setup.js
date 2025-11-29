import { beforeAll, afterAll } from 'vitest';
import { checkLibvirtAvailable, checkKVMAvailable } from '../helpers/vm-manager.js';

// Global state for libvirt availability
export let libvirtAvailable = false;
export let kvmAvailable = false;
export let skipReason = '';

// Check environment before all tests
beforeAll(async () => {
  // Check KVM
  kvmAvailable = await checkKVMAvailable();
  if (!kvmAvailable) {
    skipReason = 'KVM is not available (/dev/kvm not found)';
    console.log(`\n⚠️  ${skipReason}`);
    console.log('   Integration tests require a KVM-enabled environment.\n');
    return;
  }

  // Check libvirt
  const libvirtCheck = await checkLibvirtAvailable();
  libvirtAvailable = libvirtCheck.available;
  if (!libvirtAvailable) {
    skipReason = `libvirt is not available: ${libvirtCheck.error}`;
    console.log(`\n⚠️  ${skipReason}`);
    console.log('   Make sure libvirtd is running and you have appropriate permissions.\n');
    return;
  }

  console.log('\n✓ KVM and libvirt are available - running integration tests\n');
}, 30000);

/**
 * Helper to skip test if environment isn't ready
 */
export function skipIfNoLibvirt() {
  if (!libvirtAvailable) {
    return skipReason || 'libvirt not available';
  }
  return false;
}
