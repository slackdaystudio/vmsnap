import { beforeEach, vi } from 'vitest';

// Set system time for consistent testing
beforeEach(() => {
  vi.setSystemTime(new Date('2024-03-15T10:00:00Z'));
});