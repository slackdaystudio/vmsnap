import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Connection URI for libvirt - use system connection when running as root
const LIBVIRT_URI = process.getuid?.() === 0 ? 'qemu:///system' : null;

/**
 * Get virsh command with optional connection URI
 */
function getVirshCmd(subcommand) {
  if (LIBVIRT_URI) {
    return `virsh -c ${LIBVIRT_URI} ${subcommand}`;
  }
  return `virsh ${subcommand}`;
}

/**
 * Check if libvirt is available and accessible
 * @returns {Promise<{available: boolean, error?: string}>}
 */
export async function checkLibvirtAvailable() {
  try {
    await execAsync(getVirshCmd('version'));
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error.message,
    };
  }
}

/**
 * Check if KVM is available on the system
 * @returns {Promise<boolean>}
 */
export async function checkKVMAvailable() {
  try {
    await fs.access('/dev/kvm');
    return true;
  } catch {
    return false;
  }
}

// Default test configuration
const TEST_CONFIG = {
  testDir: '/tmp/vmsnap-integration-test',
  vmPrefix: 'vmsnap-test',
  defaultDiskSize: '100M',
  defaultRam: 128,
  defaultVcpus: 1,
};

/**
 * Represents a test VM for integration testing
 */
export class TestVM {
  constructor(name, diskPath) {
    this.name = name;
    this.diskPath = diskPath;
  }

  /**
   * Start the VM
   */
  async start() {
    await execAsync(getVirshCmd(`start ${this.name}`));
  }

  /**
   * Shutdown the VM gracefully
   */
  async shutdown() {
    try {
      await execAsync(getVirshCmd(`shutdown ${this.name}`));
      // Wait for shutdown to complete
      await this.waitForState('shut off', 30000);
    } catch {
      // Force destroy if graceful shutdown fails
      await this.destroy();
    }
  }

  /**
   * Force destroy the VM
   */
  async destroy() {
    try {
      await execAsync(getVirshCmd(`destroy ${this.name}`));
    } catch {
      // Ignore if already stopped
    }
  }

  /**
   * Wait for VM to reach a specific state
   */
  async waitForState(targetState, timeoutMs = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const { stdout } = await execAsync(getVirshCmd(`domstate ${this.name}`));
        if (stdout.trim() === targetState) {
          return true;
        }
      } catch {
        // Domain might not exist yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `VM ${this.name} did not reach state ${targetState} within ${timeoutMs}ms`
    );
  }

  /**
   * Get the current state of the VM
   */
  async getState() {
    try {
      const { stdout } = await execAsync(getVirshCmd(`domstate ${this.name}`));
      return stdout.trim();
    } catch {
      return 'undefined';
    }
  }

  /**
   * Get checkpoints for this VM
   */
  async getCheckpoints() {
    try {
      const { stdout } = await execAsync(
        getVirshCmd(`checkpoint-list ${this.name} --name`)
      );
      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
    } catch {
      return [];
    }
  }

  /**
   * Get bitmaps for this VM's disk
   */
  async getBitmaps() {
    try {
      const { stdout } = await execAsync(
        `qemu-img info --output=json ${this.diskPath}`
      );
      const info = JSON.parse(stdout);
      if (info['format-specific']?.data?.bitmaps) {
        return info['format-specific'].data.bitmaps.map((b) => b.name);
      }
      return [];
    } catch {
      return [];
    }
  }
}

/**
 * Manages test VMs for integration testing
 */
export class VMManager {
  constructor(config = {}) {
    this.config = { ...TEST_CONFIG, ...config };
    this.createdVMs = [];
  }

  /**
   * Initialize the test environment
   */
  async setup() {
    // Ensure test directory exists
    await fs.mkdir(this.config.testDir, { recursive: true });

    // Verify libvirt connection
    try {
      await execAsync(getVirshCmd('version'));
    } catch (error) {
      throw new Error(
        `Cannot connect to libvirt: ${error.message}. Make sure libvirtd is running and you have appropriate permissions.`
      );
    }
  }

  /**
   * Generate domain XML for a test VM
   */
  generateDomainXML(name, diskPath, options = {}) {
    const ram = options.ram || this.config.defaultRam;
    const vcpus = options.vcpus || this.config.defaultVcpus;

    return `<domain type='kvm'>
  <name>${name}</name>
  <memory unit='MiB'>${ram}</memory>
  <vcpu>${vcpus}</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${diskPath}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='user'>
      <model type='virtio'/>
    </interface>
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
  </devices>
</domain>`;
  }

  /**
   * Create a test VM with a minimal disk image
   */
  async createTestVM(name, options = {}) {
    const fullName = `${this.config.vmPrefix}-${name}`;
    const diskSize = options.diskSize || this.config.defaultDiskSize;
    const diskPath = path.join(this.config.testDir, `${fullName}.qcow2`);
    const xmlPath = path.join(this.config.testDir, `${fullName}.xml`);

    // Create disk image
    await execAsync(`qemu-img create -f qcow2 ${diskPath} ${diskSize}`);

    // Generate and write domain XML
    const xmlContent = this.generateDomainXML(fullName, diskPath, options);
    await fs.writeFile(xmlPath, xmlContent);

    // Define the domain
    await execAsync(getVirshCmd(`define ${xmlPath}`));

    const vm = new TestVM(fullName, diskPath);
    this.createdVMs.push(vm);

    return vm;
  }

  /**
   * Destroy and undefine a VM
   */
  async destroyVM(vm) {
    try {
      // Try to destroy if running
      await execAsync(getVirshCmd(`destroy ${vm.name}`) + ' 2>/dev/null || true');
    } catch {
      // Ignore
    }

    try {
      // Delete all checkpoints first
      const checkpoints = await vm.getCheckpoints();
      for (const checkpoint of checkpoints) {
        await execAsync(
          getVirshCmd(`checkpoint-delete ${vm.name} ${checkpoint}`) + ' 2>/dev/null || true'
        );
      }
    } catch {
      // Ignore checkpoint deletion errors
    }

    try {
      // Undefine the domain
      await execAsync(getVirshCmd(`undefine ${vm.name} --checkpoints-metadata`));
    } catch {
      // Try without checkpoints-metadata flag
      try {
        await execAsync(getVirshCmd(`undefine ${vm.name}`));
      } catch {
        // Ignore
      }
    }

    // Clean up disk and XML files
    const diskPath = path.join(this.config.testDir, `${vm.name}.qcow2`);
    const xmlPath = path.join(this.config.testDir, `${vm.name}.xml`);

    await fs.rm(diskPath, { force: true }).catch(() => {});
    await fs.rm(xmlPath, { force: true }).catch(() => {});

    // Remove from tracked VMs
    this.createdVMs = this.createdVMs.filter((v) => v.name !== vm.name);
  }

  /**
   * Clean up all created VMs
   */
  async cleanup() {
    const vmsToClean = [...this.createdVMs];
    for (const vm of vmsToClean) {
      await this.destroyVM(vm);
    }

    // Also clean up any orphaned test VMs
    try {
      const { stdout } = await execAsync(getVirshCmd('list --all --name'));
      const allVMs = stdout.trim().split('\n').filter(Boolean);
      const testVMs = allVMs.filter((name) =>
        name.startsWith(this.config.vmPrefix)
      );

      for (const vmName of testVMs) {
        const orphanVM = new TestVM(
          vmName,
          path.join(this.config.testDir, `${vmName}.qcow2`)
        );
        await this.destroyVM(orphanVM);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * List all test VMs
   */
  async listTestVMs() {
    try {
      const { stdout } = await execAsync(getVirshCmd('list --all --name'));
      return stdout
        .trim()
        .split('\n')
        .filter((name) => name.startsWith(this.config.vmPrefix));
    } catch {
      return [];
    }
  }
}

/**
 * Execute vmsnap command with given arguments
 */
export async function execVMSnap(args, options = {}) {
  const vmSnapPath = path.resolve(
    process.cwd(),
    options.vmsnapPath || 'vmsnap.js'
  );

  // Add connection URI if running as root
  const argsWithConnect = [...args];
  if (LIBVIRT_URI && !args.some(arg => arg.startsWith('--connect'))) {
    argsWithConnect.push(`--connect=${LIBVIRT_URI}`);
  }

  const command = `node ${vmSnapPath} ${argsWithConnect.join(' ')}`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: options.timeout || 120000,
      env: { ...process.env, ...options.env },
    });
    return { exitCode: 0, stdout, stderr, command };
  } catch (error) {
    // Node's exec throws on non-zero exit codes
    // Extract the actual exit code from the error
    const exitCode = error.code || 1;
    return {
      exitCode,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      command,
    };
  }
}

export default VMManager;
