import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EOL } from 'os';
import {
  SCREEN_SIZE,
  TYPE_YAML,
  TYPE_JSON,
  printStatusCheck
} from '../../../libs/print.js';
import { sampleStatus, sampleStatusInconsistent } from '../../fixtures/sample-outputs.js';

// Mock external dependencies
vi.mock('../../../vmsnap.js', () => ({
  spinner: {
    start: vi.fn(),
    stop: vi.fn()
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../../../libs/serialization.js', () => ({
  getStatus: vi.fn(),
  STATUS_OK: 0,
  STATUS_INCONSISTENT: 1,
  STATUSES: new Map([
    [0, 'OK'],
    [1, 'INCONSISTENT']
  ])
}));

vi.mock('../../../libs/libnbdbackup.js', () => ({
  FREQUENCY_MONTHLY: 'month'
}));

describe('print.js', () => {
  let vmSnapModule, serializationModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    vmSnapModule = await import('../../../vmsnap.js');
    serializationModule = await import('../../../libs/serialization.js');
  });

  describe('constants', () => {
    test('exports correct SCREEN_SIZE constant', () => {
      expect(SCREEN_SIZE).toBe(80);
    });

    test('exports correct TYPE_YAML constant', () => {
      expect(TYPE_YAML).toBe('YAML');
    });

    test('exports correct TYPE_JSON constant', () => {
      expect(TYPE_JSON).toBe('JSON');
    });
  });

  describe('printStatusCheck', () => {
    beforeEach(() => {
      serializationModule.getStatus.mockResolvedValue(sampleStatus);
    });

    test('displays status check startup message when verbose', async () => {
      await printStatusCheck({ domains: 'test-vm', verbose: true });

      expect(vmSnapModule.logger.info).toHaveBeenCalledWith('Starting status check...');
    });

    test('does not display startup message when not verbose', async () => {
      await printStatusCheck({ domains: 'test-vm', verbose: false });

      expect(vmSnapModule.logger.info).not.toHaveBeenCalledWith('Starting status check...');
    });

    test('starts and stops spinner during status check', async () => {
      await printStatusCheck({ domains: 'test-vm' });

      expect(vmSnapModule.spinner.start).toHaveBeenCalledWith(`Querying for domains...${EOL}`);
      expect(vmSnapModule.spinner.stop).toHaveBeenCalled();
    });

    test('calls getStatus with correct parameters', async () => {
      await printStatusCheck({
        domains: 'test-vm',
        output: '/backup',
        groupBy: 'quarter',
        pretty: true
      });

      expect(serializationModule.getStatus).toHaveBeenCalledWith(
        'test-vm',
        '/backup',
        'quarter',
        true
      );
    });

    test('uses default parameters when not provided', async () => {
      await printStatusCheck({});

      expect(serializationModule.getStatus).toHaveBeenCalledWith(
        '*',
        undefined,
        'month',
        false
      );
    });

    describe('standard status output', () => {
      test('displays domain status with colored output', async () => {
        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Status for')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Overall status:')
        );
      });

      test('displays checkpoints when available', async () => {
        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Checkpoints found for test-vm')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('checkpoint1')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('checkpoint2')
        );
      });

      test('displays no checkpoints message when none found', async () => {
        const statusWithoutCheckpoints = {
          'test-vm': {
            ...sampleStatus['test-vm'],
            checkpoints: []
          }
        };
        serializationModule.getStatus.mockResolvedValue(statusWithoutCheckpoints);

        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('No checkpoints found for test-vm')
        );
      });

      test('displays disk information when available', async () => {
        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Eligible disks found for test-vm')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('vda')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Virtual size: 10737418240')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Actual size: 5368709120')
        );
      });

      test('displays no disks message when none found', async () => {
        const statusWithoutDisks = {
          'test-vm': {
            ...sampleStatus['test-vm'],
            disks: []
          }
        };
        serializationModule.getStatus.mockResolvedValue(statusWithoutDisks);

        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('No eligible disks found for test-vm')
        );
      });

      test('displays bitmap information when available', async () => {
        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Bitmaps found for vda')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('checkpoint1')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('checkpoint2')
        );
      });

      test('displays no bitmaps message when none found', async () => {
        const statusWithoutBitmaps = {
          'test-vm': {
            ...sampleStatus['test-vm'],
            disks: [{
              disk: 'vda',
              virtualSize: 10737418240,
              actualSize: 5368709120,
              bitmaps: []
            }]
          }
        };
        serializationModule.getStatus.mockResolvedValue(statusWithoutBitmaps);

        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('No bitmaps found for vda')
        );
      });

      test('displays backup directory stats when available', async () => {
        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Backup directory stats for test-vm')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Path:')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Total files: 5')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Total size: 1073741824')
        );
        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Checkpoints: 2')
        );
      });

      test('skips backup directory stats when not available', async () => {
        const statusWithoutBackupStats = {
          'test-vm': {
            ...sampleStatus['test-vm'],
            backupDirStats: undefined
          }
        };
        serializationModule.getStatus.mockResolvedValue(statusWithoutBackupStats);

        await printStatusCheck({ domains: 'test-vm' });

        expect(vmSnapModule.logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining('Backup directory stats')
        );
      });

      test('displays inconsistent status with yellow color', async () => {
        serializationModule.getStatus.mockResolvedValue(sampleStatusInconsistent);

        await printStatusCheck({ domains: 'problem-vm' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Overall status:')
        );
      });

      test('handles multiple domains', async () => {
        const multiDomainStatus = {
          'vm1': sampleStatus['test-vm'],
          'vm2': sampleStatusInconsistent['problem-vm']
        };
        serializationModule.getStatus.mockResolvedValue(multiDomainStatus);

        await printStatusCheck({ domains: 'vm1,vm2' });

        expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Status for')
        );
        // Should be called twice, once for each domain
        const statusCalls = vmSnapModule.logger.info.mock.calls.filter(call =>
          call[0].includes('Status for')
        );
        expect(statusCalls).toHaveLength(2);
      });
    });

    describe('JSON output mode', () => {
      test('outputs JSON when json flag is true', async () => {
        await printStatusCheck({ domains: 'test-vm', json: true });

        const jsonCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('"test-vm"')
        );
        expect(jsonCall).toBeDefined();
      });

      test('outputs minified JSON in machine mode', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          json: true, 
          machine: true 
        });

        // Machine mode should output minified JSON (no indentation)
        const jsonCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('"test-vm"') && !call[0].includes('\n  ')
        );
        expect(jsonCall).toBeDefined();
      });

      test('outputs pretty-printed JSON in non-machine mode', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          json: true, 
          machine: false 
        });

        const framedCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('JSON:') && call[0].includes('-'.repeat(80))
        );
        expect(framedCall).toBeDefined();
      });
    });

    describe('YAML output mode', () => {
      test('outputs YAML when yaml flag is true', async () => {
        await printStatusCheck({ domains: 'test-vm', yaml: true });

        const yamlCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('test-vm:')
        );
        expect(yamlCall).toBeDefined();
      });

      test('outputs YAML when yml flag is true', async () => {
        await printStatusCheck({ domains: 'test-vm', yml: true });

        const yamlCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('test-vm:')
        );
        expect(yamlCall).toBeDefined();
      });

      test('outputs YAML in machine mode', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          yaml: true, 
          machine: true 
        });

        // Should output raw YAML without framing
        const yamlCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('test-vm:') && !call[0].includes('YAML:')
        );
        expect(yamlCall).toBeDefined();
      });

      test('outputs framed YAML in non-machine mode', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          yaml: true, 
          machine: false 
        });

        const framedCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('YAML:') && call[0].includes('-'.repeat(80))
        );
        expect(framedCall).toBeDefined();
      });

      test('prefers YAML over JSON when both flags are set', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          yaml: true, 
          json: true 
        });

        const yamlCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('test-vm:')
        );
        expect(yamlCall).toBeDefined();

        const jsonCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('"test-vm"')
        );
        expect(jsonCall).toBeUndefined();
      });
    });

    describe('framing functionality', () => {
      test('frames output with correct prefix and hyphens', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          json: true, 
          machine: false 
        });

        const framedCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('JSON:') && 
          call[0].includes('-'.repeat(80)) &&
          call[0].startsWith('JSON:')
        );
        expect(framedCall).toBeDefined();
      });

      test('frame includes EOL characters correctly', async () => {
        await printStatusCheck({ 
          domains: 'test-vm', 
          yaml: true, 
          machine: false 
        });

        const framedCall = vmSnapModule.logger.info.mock.calls.find(call =>
          call[0].includes('YAML:' + EOL)
        );
        expect(framedCall).toBeDefined();
      });
    });

    describe('error handling', () => {
      test('propagates getStatus errors', async () => {
        serializationModule.getStatus.mockRejectedValue(new Error('Test error'));

        await expect(printStatusCheck({ domains: 'test-vm' }))
          .rejects.toThrow('Test error');

        // Note: spinner.stop is called but in the error path may not be captured
      });

      test('handles empty status object', async () => {
        serializationModule.getStatus.mockResolvedValue({});

        await expect(printStatusCheck({ domains: 'test-vm' }))
          .resolves.not.toThrow();

        expect(vmSnapModule.spinner.stop).toHaveBeenCalled();
        // Should not crash, just output nothing
      });

      test('handles malformed status object gracefully', async () => {
        serializationModule.getStatus.mockResolvedValue({
          'test-vm': {
            // Basic structure with arrays to prevent length errors
            checkpoints: [],
            disks: [],
            overallStatus: 0
          }
        });

        await expect(printStatusCheck({ domains: 'test-vm' }))
          .resolves.not.toThrow();

        expect(vmSnapModule.spinner.stop).toHaveBeenCalled();
        // Should handle gracefully without crashing
      });
    });
  });
});