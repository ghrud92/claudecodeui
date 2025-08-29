import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDangerousSystemPaths,
  getAllowedBasePathPatterns,
  isSafeProjectPath,
  matchesAllowedPattern,
  isValidPathFormat,
  getPathSeparator,
  normalizePlatformPath
} from './platform.js';

describe('Platform Utilities', () => {
  let originalPlatform;
  
  beforeEach(() => {
    originalPlatform = process.platform;
  });
  
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('getDangerousSystemPaths', () => {
    it('should return common dangerous paths for Unix-like systems', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      const paths = getDangerousSystemPaths();
      
      expect(paths).toContain('/etc');
      expect(paths).toContain('/usr');
      expect(paths).toContain('/var');
      expect(paths).toContain('/sys');
      expect(paths).toContain('/proc');
      expect(paths).toContain('/boot');
      expect(paths).toContain('/bin');
      expect(paths).toContain('/sbin');
      expect(paths).toContain('/root');
    });

    it('should return Windows-specific dangerous paths for win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      const paths = getDangerousSystemPaths();
      
      expect(paths).toContain('C:\\Windows');
      expect(paths).toContain('C:\\Program Files');
      expect(paths).toContain('C:\\Program Files (x86)');
      expect(paths).toContain('C:\\ProgramData');
      expect(paths).toContain('C:\\System Volume Information');
    });
  });

  describe('getAllowedBasePathPatterns', () => {
    it('should return Unix-like path patterns for non-Windows systems', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      const patterns = getAllowedBasePathPatterns();
      
      expect(patterns).toHaveLength(6);
      expect(patterns[0].test('/workspace/project')).toBe(true);
      expect(patterns[1].test('/projects/myapp')).toBe(true);
      expect(patterns[2].test('/dev/test')).toBe(true);
      expect(patterns[3].test('/code/app')).toBe(true);
      expect(patterns[4].test('/home/user/workspace/project')).toBe(true);
      expect(patterns[5].test('/Users/jane/dev/app')).toBe(true);
    });

    it('should return Windows path patterns for win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      const patterns = getAllowedBasePathPatterns();
      
      expect(patterns).toHaveLength(5);
      expect(patterns[0].test('C:\\workspace\\project')).toBe(true);
      expect(patterns[1].test('D:\\projects\\myapp')).toBe(true);
      expect(patterns[2].test('C:\\dev\\test')).toBe(true);
      expect(patterns[3].test('E:\\code\\app')).toBe(true);
      expect(patterns[4].test('C:\\Users\\john\\workspace\\project')).toBe(true);
    });
  });

  describe('isSafeProjectPath', () => {
    it('should return false for dangerous system paths on Unix', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(isSafeProjectPath('/etc/passwd')).toBe(false);
      expect(isSafeProjectPath('/usr/bin/test')).toBe(false);
      expect(isSafeProjectPath('/var/log/app')).toBe(false);
      expect(isSafeProjectPath('/sys/kernel')).toBe(false);
      expect(isSafeProjectPath('/proc/meminfo')).toBe(false);
      expect(isSafeProjectPath('/boot/grub')).toBe(false);
      expect(isSafeProjectPath('/bin/bash')).toBe(false);
      expect(isSafeProjectPath('/sbin/init')).toBe(false);
      expect(isSafeProjectPath('/root/.ssh')).toBe(false);
    });

    it('should return false for dangerous system paths on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      expect(isSafeProjectPath('C:\\Windows\\System32')).toBe(false);
      expect(isSafeProjectPath('C:\\Program Files\\App')).toBe(false);
      expect(isSafeProjectPath('C:\\Program Files (x86)\\Tool')).toBe(false);
      expect(isSafeProjectPath('C:\\ProgramData\\Config')).toBe(false);
      expect(isSafeProjectPath('C:\\System Volume Information\\Data')).toBe(false);
    });

    it('should return true for safe project paths', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(isSafeProjectPath('/workspace/myproject')).toBe(true);
      expect(isSafeProjectPath('/projects/webapp')).toBe(true);
      expect(isSafeProjectPath('/home/user/dev/app')).toBe(true);
      expect(isSafeProjectPath('/opt/custom/project')).toBe(true);
    });
  });

  describe('matchesAllowedPattern', () => {
    it('should match allowed patterns correctly on Unix', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(matchesAllowedPattern('/workspace/project')).toBe(true);
      expect(matchesAllowedPattern('/projects/app')).toBe(true);
      expect(matchesAllowedPattern('/dev/test')).toBe(true);
      expect(matchesAllowedPattern('/code/myapp')).toBe(true);
      expect(matchesAllowedPattern('/home/john/workspace/project')).toBe(true);
      expect(matchesAllowedPattern('/Users/jane/dev/app')).toBe(true);
      
      expect(matchesAllowedPattern('/random/path')).toBe(false);
      expect(matchesAllowedPattern('/etc/config')).toBe(false);
    });

    it('should match allowed patterns correctly on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      expect(matchesAllowedPattern('C:\\workspace\\project')).toBe(true);
      expect(matchesAllowedPattern('D:\\projects\\app')).toBe(true);
      expect(matchesAllowedPattern('E:\\dev\\test')).toBe(true);
      expect(matchesAllowedPattern('F:\\code\\myapp')).toBe(true);
      expect(matchesAllowedPattern('C:\\Users\\john\\workspace\\project')).toBe(true);
      
      expect(matchesAllowedPattern('C:\\Random\\Path')).toBe(false);
      expect(matchesAllowedPattern('C:\\Windows\\System32')).toBe(false);
    });
  });

  describe('isValidPathFormat', () => {
    it('should validate Unix path format correctly', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(isValidPathFormat('/absolute/path')).toBe(true);
      expect(isValidPathFormat('/workspace')).toBe(true);
      expect(isValidPathFormat('/')).toBe(true);
      
      expect(isValidPathFormat('relative/path')).toBe(false);
      expect(isValidPathFormat('./current/path')).toBe(false);
      expect(isValidPathFormat('../parent/path')).toBe(false);
    });

    it('should validate Windows path format correctly', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      expect(isValidPathFormat('C:\\absolute\\path')).toBe(true);
      expect(isValidPathFormat('D:\\workspace')).toBe(true);
      expect(isValidPathFormat('E:\\')).toBe(true);
      
      expect(isValidPathFormat('\\relative\\path')).toBe(false);
      expect(isValidPathFormat('relative\\path')).toBe(false);
      expect(isValidPathFormat('.\\current\\path')).toBe(false);
      expect(isValidPathFormat('..\\parent\\path')).toBe(false);
    });
  });

  describe('getPathSeparator', () => {
    it('should return correct separator for Unix systems', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(getPathSeparator()).toBe('/');
    });

    it('should return correct separator for Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      expect(getPathSeparator()).toBe('\\');
    });
  });

  describe('normalizePlatformPath', () => {
    it('should normalize path separators for Unix systems', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      
      expect(normalizePlatformPath('path\\with\\backslashes')).toBe('path/with/backslashes');
      expect(normalizePlatformPath('path/with/forward/slashes')).toBe('path/with/forward/slashes');
      expect(normalizePlatformPath('mixed\\and/separators')).toBe('mixed/and/separators');
    });

    it('should normalize path separators for Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      
      expect(normalizePlatformPath('path/with/forward/slashes')).toBe('path\\with\\forward\\slashes');
      expect(normalizePlatformPath('path\\with\\backslashes')).toBe('path\\with\\backslashes');
      expect(normalizePlatformPath('mixed/and\\separators')).toBe('mixed\\and\\separators');
    });
  });
});