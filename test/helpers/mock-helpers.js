import { vi } from 'vitest';

// Mock responses for various commands
export const mockCommandOutputs = {
  virshListAll: `Id   Name           State
---  -------------  ----------
-    ubuntu-vm      shut off
-    centos-vm      running`,

  virshCheckpointList: `Name   Creation Time             Parent
----   -----------------     ------
vmsnap-20240301-100000    2024-03-01 10:00:00 +0000   --
vmsnap-20240315-100000    2024-03-15 10:00:00 +0000   vmsnap-20240301-100000`,

  qemuImgInfo: {
    virtualSize: 10737418240,
    actualSize: 5368709120,
    format: 'qcow2',
    bitmaps: [
      { name: 'vmsnap-20240301-100000', granularity: 65536 },
      { name: 'vmsnap-20240315-100000', granularity: 65536 }
    ]
  }
};

// Mock external dependencies
export const mockDependencies = {
  commandExists: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
};

// Helper to setup common mocks
export const setupCommonMocks = () => {
  vi.mock('command-exists', () => ({
    default: mockDependencies.commandExists
  }));

  vi.mock('child_process', () => ({
    exec: mockDependencies.exec,
    spawn: mockDependencies.spawn
  }));

  vi.mock('fs/promises', () => ({
    access: mockDependencies.access,
    rm: mockDependencies.rm,
    mkdir: mockDependencies.mkdir,
    readdir: mockDependencies.readdir,
    stat: mockDependencies.stat
  }));
};

// Reset all mocks
export const resetAllMocks = () => {
  Object.values(mockDependencies).forEach(mock => mock.mockReset());
};