# Integration Test Plan for VMSnap with Alpine Linux VMs

## Overview

This document outlines the integration testing strategy for VMSnap using lightweight Alpine Linux VMs. Integration tests verify that VMSnap correctly interfaces with real KVM/libvirt infrastructure and produces functional backups.

## Test Environment Architecture

### Alpine Linux VM Rationale
- **Minimal footprint**: ~5-10MB disk images
- **Fast boot**: 2-3 second startup times
- **Full Linux kernel**: Real filesystem operations
- **Package manager**: Can install test utilities
- **Reproducible**: Consistent base images

### Test Infrastructure Setup

```
test/
├── integration/
│   ├── setup/
│   │   ├── create-test-vms.sh
│   │   ├── alpine-base.xml.template
│   │   └── cleanup-test-env.sh
│   ├── fixtures/
│   │   ├── alpine-minimal.qcow2
│   │   ├── test-domain-configs/
│   │   └── expected-outputs/
│   ├── tests/
│   │   ├── backup-operations.test.js
│   │   ├── incremental-backup.test.js
│   │   ├── rotation-pruning.test.js
│   │   ├── scrubbing-operations.test.js
│   │   └── error-scenarios.test.js
│   └── helpers/
│       ├── vm-manager.js
│       ├── test-assertions.js
│       └── cleanup-helpers.js
```

## VM Test Environment

### Base Alpine VM Specifications
```xml
<!-- alpine-base.xml.template -->
<domain type='kvm'>
  <name>vmsnap-test-{VM_ID}</name>
  <memory>128000</memory> <!-- 128MB RAM -->
  <vcpu>1</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>
  </os>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='{VM_DISK_PATH}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='user'>
      <model type='virtio'/>
    </interface>
    <console type='pty'/>
  </devices>
</domain>
```

### VM Creation Script
```bash
#!/bin/bash
# create-test-vms.sh

create_alpine_vm() {
    local vm_name=$1
    local disk_size=${2:-100M}
    
    # Create disk image
    qemu-img create -f qcow2 "${vm_name}.qcow2" $disk_size
    
    # Define domain
    sed "s/{VM_ID}/${vm_name}/g; s|{VM_DISK_PATH}|$(pwd)/${vm_name}.qcow2|g" \
        alpine-base.xml.template > "${vm_name}.xml"
    
    virsh define "${vm_name}.xml"
}

# Create test VMs
create_alpine_vm "alpine-test-1" "100M"
create_alpine_vm "alpine-test-2" "200M"
create_alpine_vm "alpine-running" "150M"
```

## Test Categories

### 1. Basic Backup Operations

**Test: Single VM Backup**
```javascript
describe('Basic Backup Operations', () => {
  let testVM;
  
  beforeEach(async () => {
    testVM = await createTestVM('alpine-basic-test');
    await startVM(testVM);
  });
  
  afterEach(async () => {
    await destroyVM(testVM);
  });
  
  test('creates first backup successfully', async () => {
    const result = await execVMSnap([
      '--domains=alpine-basic-test',
      '--output=/tmp/vmsnap-test',
      '--backup'
    ]);
    
    expect(result.exitCode).toBe(0);
    expect(await backupExists('/tmp/vmsnap-test', 'alpine-basic-test')).toBe(true);
    expect(await checkpointsExist(testVM, 1)).toBe(true);
  });
});
```

**Test: Multiple VM Backup**
```javascript
test('backs up multiple VMs with wildcard', async () => {
  await createTestVM('alpine-multi-1');
  await createTestVM('alpine-multi-2');
  
  const result = await execVMSnap([
    '--domains=*',
    '--output=/tmp/vmsnap-test',
    '--backup'
  ]);
  
  expect(result.exitCode).toBe(0);
  expect(await backupExists('/tmp/vmsnap-test', 'alpine-multi-1')).toBe(true);
  expect(await backupExists('/tmp/vmsnap-test', 'alpine-multi-2')).toBe(true);
});
```

### 2. Incremental Backup Testing

**Test: Second Backup is Incremental**
```javascript
describe('Incremental Backups', () => {
  test('second backup creates incremental backup', async () => {
    const testVM = await createTestVM('alpine-incremental');
    
    // First backup
    await execVMSnap(['--domains=alpine-incremental', '--output=/tmp/vmsnap-test', '--backup']);
    const firstBackupSize = await getBackupSize('/tmp/vmsnap-test', 'alpine-incremental');
    
    // Modify VM (write some data)
    await writeDataToVM(testVM, '/tmp/testfile', '1MB');
    
    // Second backup
    await execVMSnap(['--domains=alpine-incremental', '--output=/tmp/vmsnap-test', '--backup']);
    const secondBackupSize = await getBackupSize('/tmp/vmsnap-test', 'alpine-incremental');
    
    // Second backup should be much smaller (only incremental changes)
    expect(secondBackupSize).toBeLessThan(firstBackupSize * 0.5);
    expect(await checkpointsExist(testVM, 2)).toBe(true);
  });
});
```

### 3. Backup Rotation and Grouping

**Test: Monthly Grouping**
```javascript
describe('Backup Rotation', () => {
  test('creates monthly grouped directories', async () => {
    const testVM = await createTestVM('alpine-rotation');
    
    await execVMSnap([
      '--domains=alpine-rotation',
      '--output=/tmp/vmsnap-test',
      '--groupBy=month',
      '--backup'
    ]);
    
    const currentMonth = dayjs().format('YYYY-MM');
    const expectedDir = `/tmp/vmsnap-test/vmsnap-backup-monthly-${currentMonth}`;
    
    expect(await directoryExists(expectedDir)).toBe(true);
    expect(await backupExists(expectedDir, 'alpine-rotation')).toBe(true);
  });
  
  test('prunes old backups when conditions met', async () => {
    // Mock date to be past middle of month
    const mockDate = dayjs().date(20); // 20th of month
    jest.setSystemTime(mockDate.toDate());
    
    const testVM = await createTestVM('alpine-prune');
    
    // Create "old" backup directory structure
    await createMockBackup('/tmp/vmsnap-test', 'alpine-prune', mockDate.subtract(1, 'month'));
    
    await execVMSnap([
      '--domains=alpine-prune',
      '--output=/tmp/vmsnap-test',
      '--backup',
      '--prune'
    ]);
    
    const oldBackupDir = `/tmp/vmsnap-test/vmsnap-backup-monthly-${mockDate.subtract(1, 'month').format('YYYY-MM')}`;
    expect(await directoryExists(oldBackupDir)).toBe(false);
  });
});
```

### 4. Scrubbing Operations

**Test: Checkpoint Scrubbing**
```javascript
describe('Scrubbing Operations', () => {
  test('scrubs specific checkpoint', async () => {
    const testVM = await createTestVM('alpine-scrub');
    
    // Create multiple backups to generate checkpoints
    await execVMSnap(['--domains=alpine-scrub', '--output=/tmp/vmsnap-test', '--backup']);
    await execVMSnap(['--domains=alpine-scrub', '--output=/tmp/vmsnap-test', '--backup']);
    
    const checkpointsBefore = await getCheckpoints(testVM);
    expect(checkpointsBefore.length).toBe(2);
    
    // Scrub specific checkpoint
    await execVMSnap([
      '--domains=alpine-scrub',
      '--scrub',
      '--scrubType=checkpoint',
      '--checkpointName=virtnbdbackup.0'
    ]);
    
    const checkpointsAfter = await getCheckpoints(testVM);
    expect(checkpointsAfter.length).toBe(1);
    expect(checkpointsAfter).not.toContain('virtnbdbackup.0');
  });
  
  test('scrubs all checkpoints and bitmaps', async () => {
    const testVM = await createTestVM('alpine-scrub-all');
    
    // Create backups
    await execVMSnap(['--domains=alpine-scrub-all', '--output=/tmp/vmsnap-test', '--backup']);
    await execVMSnap(['--domains=alpine-scrub-all', '--output=/tmp/vmsnap-test', '--backup']);
    
    // Verify checkpoints exist
    expect(await getCheckpoints(testVM)).toHaveLength(2);
    expect(await getBitmaps(testVM)).toHaveLength(2);
    
    // Scrub everything
    await execVMSnap([
      '--domains=alpine-scrub-all',
      '--scrub',
      '--scrubType=*'
    ]);
    
    expect(await getCheckpoints(testVM)).toHaveLength(0);
    expect(await getBitmaps(testVM)).toHaveLength(0);
  });
});
```

### 5. Status and Information Commands

**Test: Status Output**
```javascript
describe('Status Commands', () => {
  test('displays VM status correctly', async () => {
    const testVM = await createTestVM('alpine-status');
    await execVMSnap(['--domains=alpine-status', '--output=/tmp/vmsnap-test', '--backup']);
    
    const result = await execVMSnap(['--domains=alpine-status', '--status']);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Overall status: OK');
    expect(result.stdout).toContain('Checkpoints found for alpine-status:');
    expect(result.stdout).toContain('virtnbdbackup.0');
  });
  
  test('outputs JSON format correctly', async () => {
    const testVM = await createTestVM('alpine-json');
    await execVMSnap(['--domains=alpine-json', '--output=/tmp/vmsnap-test', '--backup']);
    
    const result = await execVMSnap([
      '--domains=alpine-json',
      '--status',
      '--json',
      '--machine'
    ]);
    
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveProperty('alpine-json');
    expect(output['alpine-json']).toHaveProperty('checkpoints');
    expect(output['alpine-json']).toHaveProperty('disks');
    expect(output['alpine-json']).toHaveProperty('overallStatus');
  });
});
```

### 6. Error Scenarios

**Test: Missing Dependencies**
```javascript
describe('Error Scenarios', () => {
  test('fails gracefully when virsh is missing', async () => {
    // Mock missing virsh command
    jest.mocked(commandExists).mockImplementation(cmd => 
      cmd === 'virsh' ? Promise.reject(new Error()) : Promise.resolve()
    );
    
    const result = await execVMSnap(['--domains=test', '--status']);
    
    expect(result.exitCode).toBe(4); // ERR_REQS
    expect(result.stderr).toContain('virsh');
  });
  
  test('handles non-existent domain gracefully', async () => {
    const result = await execVMSnap(['--domains=non-existent-vm', '--status']);
    
    expect(result.exitCode).toBe(1); // ERR_DOMAINS
    expect(result.stderr).toContain('non-existent-vm');
  });
  
  test('handles permission errors', async () => {
    // Create VM with restricted permissions
    const testVM = await createTestVM('alpine-perms');
    await restrictVMPermissions(testVM);
    
    const result = await execVMSnap([
      '--domains=alpine-perms',
      '--output=/tmp/vmsnap-test',
      '--backup'
    ]);
    
    expect(result.exitCode).toBe(3); // ERR_MAIN
    expect(result.stderr).toContain('permission');
  });
});
```

## Test Helpers and Utilities

### VM Manager Helper
```javascript
// helpers/vm-manager.js
export class VMManager {
  async createTestVM(name, options = {}) {
    const diskSize = options.diskSize || '100M';
    const ramMB = options.ram || 128;
    
    // Create disk image
    await execCommand(`qemu-img create -f qcow2 ${name}.qcow2 ${diskSize}`);
    
    // Generate domain XML
    const xmlContent = generateDomainXML(name, ramMB);
    await fs.writeFile(`${name}.xml`, xmlContent);
    
    // Define domain
    await execCommand(`virsh define ${name}.xml`);
    
    return new TestVM(name);
  }
  
  async destroyVM(vm) {
    await execCommand(`virsh destroy ${vm.name} || true`);
    await execCommand(`virsh undefine ${vm.name} || true`);
    await fs.unlink(`${vm.name}.qcow2`).catch(() => {});
    await fs.unlink(`${vm.name}.xml`).catch(() => {});
  }
}
```

### Test Assertions
```javascript
// helpers/test-assertions.js
export async function backupExists(backupDir, vmName) {
  const vmBackupDir = path.join(backupDir, vmName);
  try {
    const stats = await fs.stat(vmBackupDir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function checkpointsExist(vm, expectedCount) {
  const result = await execCommand(`virsh checkpoint-list ${vm.name} --name`);
  const checkpoints = result.stdout.trim().split('\n').filter(line => line.trim());
  return checkpoints.length === expectedCount;
}

export async function getBackupSize(backupDir, vmName) {
  const result = await execCommand(`du -sb ${path.join(backupDir, vmName)}`);
  return parseInt(result.stdout.split('\t')[0]);
}
```

## Test Environment Management

### Setup Script
```javascript
// setup/test-environment.js
export async function setupTestEnvironment() {
  // Ensure test directories exist
  await fs.mkdir('/tmp/vmsnap-test', { recursive: true });
  
  // Check libvirt connection
  await execCommand('virsh version');
  
  // Create base Alpine image if not exists
  if (!await fs.access('./alpine-minimal.qcow2').catch(() => false)) {
    await createAlpineBaseImage();
  }
}

export async function cleanupTestEnvironment() {
  // Clean up test VMs
  const testVMs = await execCommand("virsh list --all --name | grep 'vmsnap-test\\|alpine-test'");
  for (const vmName of testVMs.stdout.trim().split('\n')) {
    if (vmName.trim()) {
      await execCommand(`virsh destroy ${vmName} || true`);
      await execCommand(`virsh undefine ${vmName} || true`);
    }
  }
  
  // Clean up test files
  await execCommand('rm -rf /tmp/vmsnap-test');
  await execCommand('rm -f alpine-test-*.qcow2 alpine-test-*.xml');
}
```

## CI/CD Integration

### Docker Test Environment
```dockerfile
# Dockerfile.test
FROM alpine:latest

RUN apk add --no-cache \
    qemu-system-x86_64 \
    libvirt \
    nodejs \
    npm

COPY . /app
WORKDIR /app

RUN npm install
CMD ["npm", "run", "test:integration"]
```

### GitHub Actions Workflow
```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on: [push, pull_request]

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup KVM
        run: |
          sudo apt-get update
          sudo apt-get install -y qemu-kvm libvirt-daemon-system
          sudo usermod -a -G kvm,libvirt $USER
          
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm install
        
      - name: Run integration tests
        run: npm run test:integration
```

## Performance Considerations

### Test Parallelization
- Run VM creation/destruction in parallel where possible
- Use different VM names to avoid conflicts
- Implement resource pooling for CI environments

### Resource Management
- Limit concurrent VMs (max 3-4 for CI)
- Clean up resources aggressively
- Monitor disk usage during test runs

### Test Timing
- Set realistic timeouts for VM operations
- Use retries for flaky infrastructure operations
- Implement proper test teardown

## Success Criteria

### Test Coverage
- **End-to-end workflows**: 100% of main user scenarios
- **Error conditions**: All documented error codes
- **Command combinations**: All valid CLI flag combinations

### Performance Targets
- **Test suite runtime**: < 10 minutes
- **VM startup time**: < 30 seconds per VM
- **Backup operations**: < 2 minutes for small VMs

### Reliability
- **Flake rate**: < 1% test failures due to infrastructure
- **Cleanup success**: 100% resource cleanup after tests
- **Repeatability**: Tests pass consistently across environments