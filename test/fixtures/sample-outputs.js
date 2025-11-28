// Sample command outputs for testing

// Virsh command outputs
export const sampleVirshList = `Id   Name           State
---  -------------  ----------
-    ubuntu-vm      shut off
-    centos-vm      running
1    web-server     running`;

export const sampleVirshListNames = `ubuntu-vm
centos-vm
web-server`;

export const sampleCheckpointList = `Name                        Creation Time               Parent
----                        -------------               ------
vmsnap-20240301-100000     2024-03-01 10:00:00 +0000   --
vmsnap-20240315-100000     2024-03-15 10:00:00 +0000   vmsnap-20240301-100000
vmsnap-20240315-120000     2024-03-15 12:00:00 +0000   vmsnap-20240315-100000`;

export const sampleCheckpointListNames = `virtnbdbackup.123
virtnbdbackup.456
virtnbdbackup.789`;

export const sampleDomainBlockList = `Type       Device     Target     Source
file       disk       vda        /var/lib/libvirt/images/ubuntu-vm.qcow2
file       disk       vdb        /var/lib/libvirt/images/ubuntu-vm-data.qcow2
file       cdrom      hdc        -`;

// Qemu-img command outputs
export const sampleQemuImgInfo = {
  image: '/var/lib/libvirt/images/ubuntu-vm.qcow2',
  fileFormat: 'qcow2',
  virtualSize: 10737418240,
  diskSize: 5368709120,
  clusterSize: 65536,
  bitmaps: [
    {
      name: 'vmsnap-20240301-100000',
      granularity: 65536,
      count: 163840,
      status: ['IN_USE']
    },
    {
      name: 'vmsnap-20240315-100000',
      granularity: 65536,
      count: 32768,
      status: ['IN_USE']
    }
  ]
};

export const sampleQemuImgInfoQcow2 = {
  'virtual-size': 10737418240,
  'actual-size': 5368709120,
  'format': 'qcow2',
  'format-specific': {
    'data': {
      'bitmaps': [
        { name: 'virtnbdbackup.123' },
        { name: 'virtnbdbackup.456' }
      ]
    }
  }
};

export const sampleQemuImgInfoRaw = {
  'virtual-size': 10737418240,
  'actual-size': 10737418240,
  'format': 'raw'
};

export const sampleFileStats = {
  size: 1073741824,
  isDirectory: () => false,
  isFile: () => true
};

// Backup-related test data
export const backupFolderNames = {
  monthly: {
    current: 'vmsnap-backup-monthly-2024-03',
    previous: 'vmsnap-backup-monthly-2024-02'
  },
  quarterly: {
    current: 'vmsnap-backup-quarterly-2024-Q1',
    previous: 'vmsnap-backup-quarterly-2023-Q4'
  },
  biAnnual: {
    current: 'vmsnap-backup-bi-annually-2024-p1',
    previous: 'vmsnap-backup-bi-annually-2023-p2'
  },
  yearly: {
    current: 'vmsnap-backup-yearly-2024',
    previous: 'vmsnap-backup-yearly-2023'
  }
};

// CLI and output test data
export const sampleStatus = {
  'test-vm': {
    checkpoints: ['checkpoint1', 'checkpoint2'],
    disks: [
      {
        disk: 'vda',
        virtualSize: 10737418240,
        actualSize: 5368709120,
        bitmaps: ['checkpoint1', 'checkpoint2']
      }
    ],
    overallStatus: 0,
    backupDirStats: {
      path: '/backup/test-vm/vmsnap-backup-monthly-2024-03',
      totalFiles: 5,
      totalSize: 1073741824,
      checkpoints: 2
    }
  }
};

export const sampleStatusInconsistent = {
  'problem-vm': {
    checkpoints: ['checkpoint1', 'checkpoint2'],
    disks: [
      {
        disk: 'vda',
        virtualSize: 10737418240,
        actualSize: 5368709120,
        bitmaps: ['checkpoint1'] // Missing one bitmap
      }
    ],
    overallStatus: 1
  }
};

export const cliArguments = {
  valid: {
    backup: { domains: 'test-vm', output: '/backup', backup: true },
    scrub: { domains: 'test-vm', scrub: 'checkpoint' },
    status: { domains: 'test-vm' }
  },
  invalid: {
    multipleCommands: { backup: true, scrub: true, status: true },
    noDomains: { domains: null, backup: true },
    noOutput: { domains: 'test-vm', backup: true, output: null }
  }
};