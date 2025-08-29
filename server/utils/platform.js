/**
 * Platform-specific utility functions for cross-platform path and system validation
 */

/**
 * Get dangerous system paths that should be restricted for security
 * @returns {string[]} Array of dangerous system paths
 */
function getDangerousSystemPaths() {
  const commonPaths = ['/etc', '/usr', '/var', '/sys', '/proc'];
  
  if (process.platform === 'win32') {
    return [
      ...commonPaths,
      'C:\\Windows',
      'C:\\Program Files', 
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\System Volume Information'
    ];
  }
  
  return [...commonPaths, '/boot', '/bin', '/sbin', '/root'];
}

/**
 * Get allowed base path patterns for project creation
 * @returns {string[]} Array of allowed base path patterns
 */
function getAllowedBasePathPatterns() {
  if (process.platform === 'win32') {
    return [
      /^[A-Za-z]:\\workspace/,
      /^[A-Za-z]:\\projects/,
      /^[A-Za-z]:\\dev/,
      /^[A-Za-z]:\\code/,
      /^[A-Za-z]:\\Users\\[^\\]+\\(workspace|projects|dev|code)/
    ];
  }
  
  return [
    /^\/workspace/,
    /^\/projects/, 
    /^\/dev/,
    /^\/code/,
    /^\/home\/[^/]+\/(workspace|projects|dev|code)/,
    /^\/Users\/[^/]+\/(workspace|projects|dev|code)/
  ];
}

/**
 * Check if a path is considered safe for project creation
 * @param {string} absolutePath - The absolute path to validate
 * @returns {boolean} True if path is safe, false otherwise
 */
function isSafeProjectPath(absolutePath) {
  const dangerousPaths = getDangerousSystemPaths();
  
  // Check if path starts with any dangerous system path
  for (const dangerousPath of dangerousPaths) {
    if (absolutePath.startsWith(dangerousPath)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Check if a path matches allowed base path patterns
 * @param {string} absolutePath - The absolute path to validate
 * @returns {boolean} True if path matches allowed patterns, false otherwise
 */
function matchesAllowedPattern(absolutePath) {
  const allowedPatterns = getAllowedBasePathPatterns();
  
  return allowedPatterns.some(pattern => pattern.test(absolutePath));
}

/**
 * Validate platform-specific path format
 * @param {string} pathStr - The path string to validate
 * @returns {boolean} True if path format is valid for current platform
 */
function isValidPathFormat(pathStr) {
  if (process.platform === 'win32') {
    // Windows: Must have drive letter (C:\, D:\, etc.)
    return /^[A-Za-z]:\\/.test(pathStr);
  }
  
  // Unix-like: Must start with /
  return pathStr.startsWith('/');
}

/**
 * Get platform-specific path separator
 * @returns {string} Path separator for current platform
 */
function getPathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

/**
 * Normalize path separators for current platform
 * @param {string} pathStr - The path string to normalize
 * @returns {string} Path with normalized separators
 */
function normalizePlatformPath(pathStr) {
  const separator = getPathSeparator();
  const oppositeSeparator = separator === '\\' ? '/' : '\\';
  
  return pathStr.replace(new RegExp(`\\${oppositeSeparator}`, 'g'), separator);
}

module.exports = {
  getDangerousSystemPaths,
  getAllowedBasePathPatterns,
  isSafeProjectPath,
  matchesAllowedPattern,
  isValidPathFormat,
  getPathSeparator,
  normalizePlatformPath
};