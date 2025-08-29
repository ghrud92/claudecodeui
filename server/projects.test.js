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
    realpath: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  },
}));

// Mock path utilities
vi.mock('./utils/paths.js', () => ({
  getClaudeDir: vi.fn(() => '/mock/.claude'),
}));

describe('addProjectManually - PROJECT_BASE_DIR functionality', () => {
  let originalEnv;

  beforeEach(async () => {
    originalEnv = process.env.PROJECT_BASE_DIR;
    vi.clearAllMocks();
    
    // Set default mocks for fs.promises.realpath
    const fs = await import('fs');
    fs.promises.realpath.mockRejectedValue({ code: 'ENOENT' });
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
      '유효하지 않은 프로젝트 경로입니다. 디렉토리 순회 시도는 허용되지 않습니다.'
    );
  });

  it('should validate project names correctly', async () => {
    process.env.PROJECT_BASE_DIR = '/test/projects';

    await expect(addProjectManually('')).rejects.toThrow('유효하지 않은 프로젝트 이름입니다');
    await expect(addProjectManually('.')).rejects.toThrow('유효하지 않은 프로젝트 이름입니다');
    await expect(addProjectManually('..')).rejects.toThrow('유효하지 않은 프로젝트 이름입니다');
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
        'PROJECT_BASE_DIR는 시스템 디렉토리로 설정할 수 없습니다'
      );
    }
  });

  it('should throw error for relative paths in PROJECT_BASE_DIR', async () => {
    process.env.PROJECT_BASE_DIR = './relative/path';
    
    await expect(addProjectManually('test-project')).rejects.toThrow(
      'PROJECT_BASE_DIR는 절대 경로여야 합니다'
    );
  });

  it('should handle Windows-style path separators', async () => {
    // Test multiple Windows-style patterns
    await expect(addProjectManually('..\\sensitive')).rejects.toThrow(
      '유효하지 않은 프로젝트 경로입니다. 디렉토리 순회 시도는 허용되지 않습니다.'
    );
    
    await expect(addProjectManually('..\\..\\etc\\passwd')).rejects.toThrow(
      '유효하지 않은 프로젝트 경로입니다. 디렉토리 순회 시도는 허용되지 않습니다.'
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
      "보안 위반: 프로젝트 경로가 허용된 기본 디렉토리를 벗어났습니다 '/safe/projects'"
    );

    path.resolve.mockRestore();
  });

  it('should handle very long project names', async () => {
    // Test maximum path length handling
    const longName = 'a'.repeat(200); // Very long but reasonable project name
    process.env.PROJECT_BASE_DIR = '/tmp/test';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });

    await expect(addProjectManually(longName)).resolves.toBeDefined();
  });

  it('should handle special characters in project names', async () => {
    process.env.PROJECT_BASE_DIR = '/tmp/test';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });

    // Test Unicode characters
    await expect(addProjectManually('프로젝트-한글')).resolves.toBeDefined();
    
    // Test spaces (should work after basename extraction)
    await expect(addProjectManually('project with spaces')).resolves.toBeDefined();
    
    // Test special characters
    await expect(addProjectManually('project_with-dots.and_underscores')).resolves.toBeDefined();
  });

  it('should handle disk space and permission errors gracefully', async () => {
    process.env.PROJECT_BASE_DIR = '/tmp/test';
    
    const fs = await import('fs');
    
    // Test disk space error
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.mkdir.mockRejectedValue({ code: 'ENOSPC', message: 'No space left on device' });
    
    await expect(addProjectManually('test-disk-full')).rejects.toThrow('디스크 공간이 부족합니다');
    
    // Test read-only filesystem error
    fs.promises.mkdir.mockRejectedValue({ code: 'EROFS', message: 'Read-only file system' });
    
    await expect(addProjectManually('test-readonly')).rejects.toThrow('읽기 전용 파일시스템입니다');
    
    // Test resource exhaustion
    fs.promises.mkdir.mockRejectedValue({ code: 'EMFILE', message: 'Too many open files' });
    
    await expect(addProjectManually('test-resources')).rejects.toThrow('시스템 리소스가 부족합니다');
  });

  it('should handle extremely long paths that exceed OS limits', async () => {
    // Test path length limits with reasonable base path but very long project name
    process.env.PROJECT_BASE_DIR = '/tmp/test';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.realpath.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.mkdir.mockRejectedValue({ code: 'ENAMETOOLONG', message: 'File name too long' });
    
    const longProjectName = 'a'.repeat(300); // Very long project name
    await expect(addProjectManually(longProjectName)).rejects.toThrow('경로 이름이 너무 깁니다');
  });

  it('should validate path normalization edge cases', async () => {
    // Test various normalization scenarios
    const testCases = [
      './current/path', // relative path
      '../../parent/path', // multiple parent references
      'path/./current', // current directory references
      'path//double//slashes', // double slashes
      'path/../../escape', // mixed traversal attempts
    ];
    
    for (const testCase of testCases) {
      if (testCase.includes('..') || !path.isAbsolute(testCase)) {
        await expect(addProjectManually(testCase)).rejects.toThrow(
          '유효하지 않은 프로젝트 경로입니다. 디렉토리 순회 시도는 허용되지 않습니다.'
        );
      }
    }
  });

  it('should handle cross-platform path validation correctly', async () => {
    process.env.PROJECT_BASE_DIR = '/safe/projects';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.realpath.mockRejectedValue({ code: 'ENOENT' }); // Parent directory doesn't exist yet
    fs.promises.mkdir.mockResolvedValue(undefined); // Successfully create directory
    
    const result = await addProjectManually('test-project');
    
    // Should work with normalized path handling
    expect(result.path).toBeDefined();
    expect(result.fullPath).toContain('/safe/projects/test-project');
  });

  it('should detect symbolic link traversal attempts', async () => {
    process.env.PROJECT_BASE_DIR = '/safe/projects';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    
    // Mock fs.realpath to simulate symbolic link resolving to outside directory
    fs.promises.realpath.mockResolvedValue('/unsafe/location');
    
    await expect(addProjectManually('symlink-project')).rejects.toThrow(
      '보안 위반: 심볼릭 링크를 통한 디렉토리 순회 시도가 감지되었습니다'
    );
  });

  it('should handle realpath ENOENT errors gracefully for new directories', async () => {
    process.env.PROJECT_BASE_DIR = '/safe/projects';
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.realpath.mockRejectedValue({ code: 'ENOENT' }); // Expected for new directories
    fs.promises.mkdir.mockResolvedValue(undefined); // Successfully create directory
    
    const result = await addProjectManually('new-project');
    
    // Should succeed since ENOENT is expected for new directories
    expect(result.path).toBeDefined();
  });

  it('should not log sensitive paths in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PROJECT_BASE_DIR = '/secure/path';
    
    const consoleSpy = vi.spyOn(console, 'debug');
    
    const fs = await import('fs');
    fs.promises.access.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.realpath.mockRejectedValue({ code: 'ENOENT' });
    fs.promises.mkdir.mockResolvedValue(undefined); // Successfully create directory
    
    await addProjectManually('test-project');
    
    // Should not call console.debug with sensitive information
    const debugCalls = consoleSpy.mock.calls.filter(call => 
      call[0] && call[0].includes && call[0].includes('/secure/path')
    );
    expect(debugCalls).toHaveLength(0);
    
    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });
});