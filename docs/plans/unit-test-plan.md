# Unit Test Plan for VMSnap

## Overview

This document outlines the comprehensive unit testing strategy for VMSnap, a Node.js-based KVM backup tool. The plan focuses on testing individual modules in isolation by mocking external dependencies.

## Test Framework Setup

**Recommended Stack:**
- **Test Runner**: Vitest (fast, ESM-native, good mocking capabilities)
- **Assertion Library**: Built-in Vitest assertions
- **Mocking**: Vitest's vi.mock() for command execution
- **Coverage**: Vitest's built-in c8 coverage

**Alternative Stack:**
- **Test Runner**: Jest with ESM support
- **Mocking**: Jest mocks for child_process and file system

## Test Structure

```
test/
├── unit/
│   ├── libs/
│   │   ├── general.test.js
│   │   ├── libnbdbackup.test.js
│   │   ├── virsh.test.js
│   │   ├── qemu-img.test.js
│   │   ├── print.test.js
│   │   └── serialization.test.js
│   ├── vmsnap.test.js
│   └── helpers/
│       └── mock-helpers.js
├── fixtures/
│   ├── sample-domains.xml
│   ├── sample-outputs/
│   └── mock-responses/
└── setup.js
```

## Module-by-Module Test Plans

### 1. libs/general.js

**Functions to Test:**
- `checkCommand(command)` - Verify command existence
- `checkDependencies()` - Validate all required tools
- `fileExists(path)` - File system checks
- `parseArrayParam(param)` - Parse comma-separated domains
- `scrubCheckpointsAndBitmaps()` - Cleanup operations

**Test Cases:**
```javascript
describe('general.js', () => {
  describe('checkCommand', () => {
    test('returns true for existing command', async () => {
      vi.mocked(commandExists).mockResolvedValue(true);
      expect(await checkCommand('virsh')).toBe(true);
    });
    
    test('returns false for missing command', async () => {
      vi.mocked(commandExists).mockRejectedValue(new Error());
      expect(await checkCommand('missing')).toBe(false);
    });
  });

  describe('parseArrayParam', () => {
    test('parses single domain', () => {
      expect(parseArrayParam('vm1')).toEqual(['vm1']);
    });
    
    test('parses comma-separated domains', () => {
      expect(parseArrayParam('vm1,vm2,vm3')).toEqual(['vm1', 'vm2', 'vm3']);
    });
    
    test('handles wildcard', () => {
      expect(parseArrayParam('*')).toEqual(['*']);
    });
  });
});
```

### 2. libs/libnbdbackup.js

**Functions to Test:**
- `performBackup()` - Main backup orchestration
- Date/time formatting functions
- Directory structure creation
- Backup rotation logic
- Pruning functionality

**Key Test Areas:**
- Backup directory naming with different groupBy values
- Incremental vs full backup decision logic
- Pruning conditions (middle of period calculations)
- Error handling during backup operations

**Test Cases:**
```javascript
describe('libnbdbackup.js', () => {
  describe('backup directory naming', () => {
    test('monthly grouping creates correct directory', () => {
      const date = dayjs('2024-03-15');
      expect(getBackupDirectory(date, 'month')).toBe('vmsnap-backup-monthly-2024-03');
    });
    
    test('quarterly grouping creates correct directory', () => {
      const date = dayjs('2024-03-15');
      expect(getBackupDirectory(date, 'quarter')).toBe('vmsnap-backup-quarterly-2024-Q1');
    });
  });

  describe('pruning logic', () => {
    test('prunes when past middle of period', () => {
      const date = dayjs('2024-03-20'); // Past 15th
      expect(shouldPrune(date, 'month')).toBe(true);
    });
    
    test('does not prune before middle of period', () => {
      const date = dayjs('2024-03-10'); // Before 15th
      expect(shouldPrune(date, 'month')).toBe(false);
    });
  });
});
```

### 3. libs/virsh.js

**Functions to Test:**
- `fetchAllDomains()` - Domain discovery
- `domainExists(name)` - Domain validation
- `cleanupCheckpoints()` - Checkpoint management
- XML parsing functions

**Mocking Strategy:**
```javascript
// Mock virsh command execution
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, callback) => {
    if (cmd.includes('virsh list --all')) {
      callback(null, mockDomainListOutput);
    } else if (cmd.includes('virsh checkpoint-list')) {
      callback(null, mockCheckpointOutput);
    }
  })
}));
```

### 4. libs/qemu-img.js

**Functions to Test:**
- Disk information gathering
- Bitmap management operations
- Image format detection

**Test Cases:**
- Bitmap listing and cleanup
- Disk size calculations
- Error handling for corrupted images

### 5. libs/print.js

**Functions to Test:**
- Status formatting
- JSON/YAML output
- Pretty printing utilities
- Machine-readable output

**Test Cases:**
- Output formatting consistency
- JSON schema validation
- Terminal width handling

### 6. vmsnap.js (Main Entry Point)

**Functions to Test:**
- CLI argument parsing
- Error code definitions
- Main workflow coordination
- Logging setup

**Test Cases:**
```javascript
describe('vmsnap main', () => {
  test('exits with ERR_DOMAINS when no domains specified', () => {
    const argv = { domains: null };
    expect(() => validateArgs(argv)).toThrow();
  });
  
  test('exits with ERR_OUTPUT_DIR when no output specified for backup', () => {
    const argv = { domains: 'vm1', backup: true, output: null };
    expect(() => validateArgs(argv)).toThrow();
  });
});
```

## Mocking Strategy

### External Commands
Mock all external command executions:
```javascript
// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn()
}));

// Mock command-exists
vi.mock('command-exists', () => ({
  default: vi.fn()
}));
```

### File System Operations
Mock file system operations:
```javascript
// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn()
}));
```

### Date/Time
Use fixed dates for consistent testing:
```javascript
beforeEach(() => {
  vi.setSystemTime(new Date('2024-03-15T10:00:00Z'));
});
```

## Test Data and Fixtures

### Sample Command Outputs
Store realistic command outputs in fixtures:
- `virsh list --all` output
- `virsh checkpoint-list` output  
- `qemu-img info` JSON output
- Error responses from commands

### Mock Domain Configurations
Create sample VM configurations for testing different scenarios.

## Coverage Goals

**Target Coverage:**
- **Overall**: 90%+
- **Functions**: 95%+
- **Lines**: 90%+
- **Branches**: 85%+

**Priority Areas:**
1. Core backup logic (libnbdbackup.js)
2. Command execution wrappers
3. Error handling paths
4. Date/time calculations

## Test Execution

**Commands to Add to package.json:**
```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run test/unit",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest watch"
  }
}
```

## Continuous Integration

**Pre-commit Hooks:**
- Run unit tests
- Check coverage thresholds
- Lint test files

**CI Pipeline:**
- Run on multiple Node.js versions (18, 20, 22)
- Generate coverage reports
- Fail if coverage drops below thresholds

## Implementation Priority

1. **Phase 1**: Core utilities (general.js, serialization.js)
2. **Phase 2**: Command wrappers (virsh.js, qemu-img.js)
3. **Phase 3**: Main backup logic (libnbdbackup.js)
4. **Phase 4**: CLI and output (vmsnap.js, print.js)
5. **Phase 5**: Edge cases and error scenarios