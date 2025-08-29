import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addProjectManually } from './projects.js';
import path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  promises: {
    access: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock path utilities
vi.mock('./utils/paths.js', () => ({
  getClaudeDir: vi.fn(() => '/mock/.claude'),
}));

describe('addProjectManually - PROJECT_BASE_DIR functionality', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.PROJECT_BASE_DIR;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PROJECT_BASE_DIR = originalEnv;
    } else {
      delete process.env.PROJECT_BASE_DIR;
    }
  });

  it('should use /workspace as default when PROJECT_BASE_DIR is not set', async () => {
    delete process.env.PROJECT_BASE_DIR;
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });

    const result = await addProjectManually('test-project');

    expect(result.path).toBe(path.resolve('/workspace/test-project'));
    expect(result.fullPath).toBe(path.resolve('/workspace/test-project'));
  });

  it('should use custom PROJECT_BASE_DIR when set', async () => {
    process.env.PROJECT_BASE_DIR = '/custom/projects';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });

    const result = await addProjectManually('test-project');

    expect(result.path).toBe(path.resolve('/custom/projects/test-project'));
    expect(result.fullPath).toBe(path.resolve('/custom/projects/test-project'));
  });

  it('should prevent directory traversal attacks with custom base dir', async () => {
    process.env.PROJECT_BASE_DIR = '/safe/projects';

    await expect(addProjectManually('../../../etc/passwd')).rejects.toThrow(
      'Invalid project path. Directory traversal attempts are not allowed.'
    );
  });

  it('should validate project names correctly', async () => {
    process.env.PROJECT_BASE_DIR = '/test/projects';

    await expect(addProjectManually('')).rejects.toThrow('Invalid project name');
    await expect(addProjectManually('.')).rejects.toThrow('Invalid project name');
    await expect(addProjectManually('..')).rejects.toThrow('Invalid project name');
  });

  it('should generate correct project identifier for session linking', async () => {
    process.env.PROJECT_BASE_DIR = '/custom/base';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });

    const result = await addProjectManually('my-project');

    // Project identifier should be encoded path for session storage
    const expectedPath = path.resolve('/custom/base/my-project');
    const expectedIdentifier = expectedPath.replace(/\//g, '-');
    expect(result.name).toBe(expectedIdentifier);
  });

  it('should throw error for system directories in PROJECT_BASE_DIR', async () => {
    const systemDirs = ['/etc', '/usr', '/var', '/sys', '/proc', '/boot', '/bin', '/sbin'];
    
    for (const systemDir of systemDirs) {
      process.env.PROJECT_BASE_DIR = systemDir + '/sensitive';
      
      await expect(addProjectManually('test-project')).rejects.toThrow(
        'PROJECT_BASE_DIR cannot be set to system directories'
      );
    }
  });

  it('should throw error for relative paths in PROJECT_BASE_DIR', async () => {
    process.env.PROJECT_BASE_DIR = './relative/path';
    
    await expect(addProjectManually('test-project')).rejects.toThrow(
      'PROJECT_BASE_DIR must be an absolute path'
    );
  });

  it('should handle Windows-style path separators', async () => {
    // Test multiple Windows-style patterns
    await expect(addProjectManually('..\\sensitive')).rejects.toThrow(
      'Invalid project path. Directory traversal attempts are not allowed.'
    );
    
    await expect(addProjectManually('..\\..\\etc\\passwd')).rejects.toThrow(
      'Invalid project path. Directory traversal attempts are not allowed.'
    );
  });

  it('should provide detailed security violation messages', async () => {
    process.env.PROJECT_BASE_DIR = '/safe/projects';
    
    // Mock path.resolve to simulate a case where directory traversal bypasses initial check
    const originalResolve = path.resolve;
    vi.spyOn(path, 'resolve').mockImplementation((...args) => {
      if (args.length === 2 && args[0] === '/safe/projects' && args[1] === 'test') {
        return '/unsafe/location/test'; // Simulate security violation
      }
      return originalResolve(...args);
    });

    await expect(addProjectManually('test')).rejects.toThrow(
      "Security violation: Project path '/unsafe/location/test' is outside allowed base directory '/safe/projects'"
    );

    path.resolve.mockRestore();
  });
});