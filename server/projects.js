/**
 * PROJECT DISCOVERY AND MANAGEMENT SYSTEM
 * ========================================
 * 
 * This module manages project discovery for both Claude CLI and Cursor CLI sessions.
 * 
 * ## Architecture Overview
 * 
 * 1. **Claude Projects** (stored in ~/.claude/projects/)
 *    - Each project is a directory named with the project path encoded (/ replaced with -)
 *    - Contains .jsonl files with conversation history including 'cwd' field
 *    - Project metadata stored in ~/.claude/project-config.json
 * 
 * 2. **Cursor Projects** (stored in ~/.cursor/chats/)
 *    - Each project directory is named with MD5 hash of the absolute project path
 *    - Example: /Users/john/myproject -> MD5 -> a1b2c3d4e5f6...
 *    - Contains session directories with SQLite databases (store.db)
 *    - Project path is NOT stored in the database - only in the MD5 hash
 * 
 * ## Project Discovery Strategy
 * 
 * 1. **Claude Projects Discovery**:
 *    - Scan ~/.claude/projects/ directory for Claude project folders
 *    - Extract actual project path from .jsonl files (cwd field)
 *    - Fall back to decoded directory name if no sessions exist
 * 
 * 2. **Cursor Sessions Discovery**:
 *    - For each KNOWN project (from Claude or manually added)
 *    - Compute MD5 hash of the project's absolute path
 *    - Check if ~/.cursor/chats/{md5_hash}/ directory exists
 *    - Read session metadata from SQLite store.db files
 * 
 * 3. **Manual Project Addition**:
 *    - Users can manually add project paths via UI
 *    - Stored in ~/.claude/project-config.json with 'manuallyAdded' flag
 *    - Allows discovering Cursor sessions for projects without Claude sessions
 * 
 * ## Critical Limitations
 * 
 * - **CANNOT discover Cursor-only projects**: From a quick check, there was no mention of
 *   the cwd of each project. if someone has the time, you can try to reverse engineer it.
 * 
 * - **Project relocation breaks history**: If a project directory is moved or renamed,
 *   the MD5 hash changes, making old Cursor sessions inaccessible unless the old
 *   path is known and manually added.
 * 
 * ## Error Handling
 * 
 * - Missing ~/.claude directory is handled gracefully with automatic creation
 * - ENOENT errors are caught and handled without crashing
 * - Empty arrays returned when no projects/sessions exist
 * 
 * ## Caching Strategy
 * 
 * - Project directory extraction is cached to minimize file I/O
 * - Cache is cleared when project configuration changes
 * - Session data is fetched on-demand, not cached
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';
import { getProjectsPath, getClaudeDir } from './utils/paths.js';
import {
  getDangerousSystemPaths,
  isValidPathFormat,
  isSafeProjectPath
} from './utils/platform.js';


// Cache for extracted project directories
const projectDirectoryCache = new Map();


// Enhanced BASE_DIR validation function with additional configuration validation
function validateBaseDir(baseDir) {
  // Enhanced path format validation using platform utilities
  if (!path.isAbsolute(baseDir)) {
    throw new Error('PROJECT_BASE_DIR는 절대 경로여야 합니다');
  }
  
  // Platform-specific path format validation
  if (!isValidPathFormat(baseDir)) {
    throw new Error('PROJECT_BASE_DIR는 절대 경로여야 합니다');
  }
  
  const normalizedBaseDir = path.normalize(baseDir);
  
  // Enhanced security validation using platform utilities
  if (!isSafeProjectPath(normalizedBaseDir)) {
    throw new Error(`PROJECT_BASE_DIR는 시스템 디렉토리로 설정할 수 없습니다. 시도된 경로: ${baseDir}`);
  }
  
  // Additional validation: prevent commonly dangerous configurations
  const homedir = os.homedir();
  if (normalizedBaseDir === homedir) {
    throw new Error('PROJECT_BASE_DIR를 홈 디렉토리로 직접 설정할 수 없습니다. 하위 디렉토리를 사용해주세요.');
  }
  
  // Additional validation: prevent root directory
  if (normalizedBaseDir === '/' || normalizedBaseDir.match(/^[A-Za-z]:\\?$/)) {
    throw new Error('PROJECT_BASE_DIR를 루트 디렉토리로 설정할 수 없습니다.');
  }
  
  return normalizedBaseDir;
}

// Thread-safe BASE_DIR validation cache using Map
const baseDirCache = new Map();

// Get validated BASE_DIR with concurrent-safe caching
function getValidatedBaseDir() {
  const currentEnvValue = process.env.PROJECT_BASE_DIR || '/workspace';
  
  // Use Map-based caching for thread safety
  if (!baseDirCache.has(currentEnvValue)) {
    baseDirCache.set(currentEnvValue, validateBaseDir(currentEnvValue));
  }
  
  return baseDirCache.get(currentEnvValue);
}

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(getClaudeDir(), 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const claudeDir = getClaudeDir();
  const configPath = path.join(claudeDir, 'project-config.json');
  
  // Ensure the .claude directory exists
  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');
  
  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);
    
    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }
  
  // If it starts with /, it's an absolute path
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name
    return parts[parts.length - 1] || projectPath;
  }
  
  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }
  
  
  const projectDir = path.join(getProjectsPath(), projectName);
  const cwdCounts = new Map();
  let latestTimestamp = 0;
  let latestCwd = null;
  let extractedPath;
  
  try {
    // Check if the project directory exists
    await fs.access(projectDir);
    
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // Process all JSONL files to collect cwd values
      for (const file of jsonlFiles) {
        const jsonlFile = path.join(projectDir, file);
        const fileStream = fsSync.createReadStream(jsonlFile);
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });
        
        for await (const line of rl) {
          if (line.trim()) {
            try {
              const entry = JSON.parse(line);
              
              if (entry.cwd) {
                // Count occurrences of each cwd
                cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1);
                
                // Track the most recent cwd
                const timestamp = new Date(entry.timestamp || 0).getTime();
                if (timestamp > latestTimestamp) {
                  latestTimestamp = timestamp;
                  latestCwd = entry.cwd;
                }
              }
            } catch (parseError) {
              // Skip malformed lines
            }
          }
        }
      }
      
      // Determine the best cwd to use
      if (cwdCounts.size === 0) {
        // No cwd found, fall back to decoded project name
        extractedPath = projectName.replace(/-/g, '/');
      } else if (cwdCounts.size === 1) {
        // Only one cwd, use it
        extractedPath = Array.from(cwdCounts.keys())[0];
      } else {
        // Constants for CWD selection heuristics
        const RECENT_CWD_THRESHOLD = 0.25; // 25% threshold for using recent CWD
        
        // Multiple cwd values - prefer the most recent one if it has reasonable usage
        const mostRecentCount = cwdCounts.get(latestCwd) || 0;
        const maxCount = Math.max(...cwdCounts.values());
        
        // Use most recent if it has at least 25% of the max count
        if (mostRecentCount >= maxCount * RECENT_CWD_THRESHOLD) {
          extractedPath = latestCwd;
        } else {
          // Otherwise use the most frequently used cwd
          for (const [cwd, count] of cwdCounts.entries()) {
            if (count === maxCount) {
              extractedPath = cwd;
              break;
            }
          }
        }
        
        // Fallback (shouldn't reach here)
        if (!extractedPath) {
          extractedPath = latestCwd || projectName.replace(/-/g, '/');
        }
      }
    }
    
    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);
    
    return extractedPath;
    
  } catch (error) {
    // If the directory doesn't exist, just use the decoded project name
    if (error.code === 'ENOENT') {
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      console.error(`Error extracting project directory for ${projectName}:`, error);
      // Fall back to decoded project name for other errors
      extractedPath = projectName.replace(/-/g, '/');
    }
    
    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);
    
    return extractedPath;
  }
}

async function getProjects() {
  const claudeDir = getProjectsPath();
  const config = await loadProjectConfig();
  const projects = [];
  const existingProjects = new Set();
  
  try {
    // Check if the .claude/projects directory exists
    await fs.access(claudeDir);
    
    // First, get existing Claude projects from the file system
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingProjects.add(entry.name);
        const projectPath = path.join(claudeDir, entry.name);
        
        // Extract actual project directory from JSONL sessions
        const actualProjectDir = await extractProjectDirectory(entry.name);
        
        // Get display name from config or generate one
        const customName = config[entry.name]?.displayName;
        const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);
        const fullPath = actualProjectDir;
        
        const project = {
          name: entry.name,
          path: actualProjectDir,
          displayName: customName || autoDisplayName,
          fullPath: fullPath,
          isCustomName: !!customName,
          sessions: []
        };
        
        // Try to get sessions for this project (just first 5 for performance)
        try {
          const sessionResult = await getSessions(entry.name, 5, 0);
          project.sessions = sessionResult.sessions || [];
          project.sessionMeta = {
            hasMore: sessionResult.hasMore,
            total: sessionResult.total
          };
        } catch (e) {
          console.warn(`Could not load sessions for project ${entry.name}:`, e.message);
        }
        
        // Also fetch Cursor sessions for this project
        try {
          project.cursorSessions = await getCursorSessions(actualProjectDir);
        } catch (e) {
          console.warn(`Could not load Cursor sessions for project ${entry.name}:`, e.message);
          project.cursorSessions = [];
        }
        
        projects.push(project);
      }
    }
  } catch (error) {
    // If the directory doesn't exist (ENOENT), that's okay - just continue with empty projects
    if (error.code !== 'ENOENT') {
      console.error('Error reading projects directory:', error);
    }
  }
  
  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;
      
      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, '/');
        }
      }
      
              const project = {
          name: projectName,
          path: actualProjectDir,
          displayName: projectConfig.displayName || await generateDisplayName(projectName, actualProjectDir),
          fullPath: actualProjectDir,
          isCustomName: !!projectConfig.displayName,
          isManuallyAdded: true,
          sessions: [],
          cursorSessions: []
        };
      
      // Try to fetch Cursor sessions for manual projects too
      try {
        project.cursorSessions = await getCursorSessions(actualProjectDir);
      } catch (e) {
        console.warn(`Could not load Cursor sessions for manual project ${projectName}:`, e.message);
      }
      
      projects.push(project);
    }
  }
  
  return projects;
}

async function getSessions(projectName, limit = 5, offset = 0) {
  const projectDir = path.join(getProjectsPath(), projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }
    
    // For performance, get file stats to sort by modification time
    const filesWithStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime };
      })
    );
    
    // Sort files by modification time (newest first) for better performance
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    
    const allSessions = new Map();
    let processedCount = 0;
    
    // Process files in order of modification time
    for (const { file } of filesWithStats) {
      const jsonlFile = path.join(projectDir, file);
      const sessions = await parseJsonlSessions(jsonlFile);
      
      // Merge sessions, avoiding duplicates by session ID
      sessions.forEach(session => {
        if (!allSessions.has(session.id)) {
          allSessions.set(session.id, session);
        }
      });
      
      processedCount++;
      
      // Constants for early exit optimization
      const MAX_RECENT_FILES_TO_PROCESS = 3;
      
      // Early exit optimization: if we have enough sessions and processed recent files
      if (allSessions.size >= (limit + offset) * 2 && processedCount >= Math.min(MAX_RECENT_FILES_TO_PROCESS, filesWithStats.length)) {
        break;
      }
    }
    
    // Convert to array and sort by last activity
    const sortedSessions = Array.from(allSessions.values()).sort((a, b) => 
      new Date(b.lastActivity) - new Date(a.lastActivity)
    );
    
    const total = sortedSessions.length;
    const paginatedSessions = sortedSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    
    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  
  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    // console.log(`[JSONL Parser] Reading file: ${filePath}`);
    let lineCount = 0;
    
    for await (const line of rl) {
      if (line.trim()) {
        lineCount++;
        try {
          const entry = JSON.parse(line);
          
          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: 'New Session',
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || ''
              });
            }
            
            const session = sessions.get(entry.sessionId);
            
            // Update summary if this is a summary entry
            if (entry.type === 'summary' && entry.summary) {
              session.summary = entry.summary;
            } else if (entry.message?.role === 'user' && entry.message?.content && session.summary === 'New Session') {
              // Use first user message as summary if no summary entry exists
              const content = entry.message.content;
              if (typeof content === 'string' && content.length > 0) {
                // Skip command messages that start with <command-name>
                if (!content.startsWith('<command-name>')) {
                  session.summary = content.length > 50 ? content.substring(0, 50) + '...' : content;
                }
              }
            }
            
            // Count messages instead of storing them all
            session.messageCount = (session.messageCount || 0) + 1;
            
            // Update last activity
            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          console.warn(`[JSONL Parser] Error parsing line ${lineCount}:`, parseError.message);
        }
      }
    }
    
    // console.log(`[JSONL Parser] Processed ${lineCount} lines, found ${sessions.size} sessions`);
  } catch (error) {
    console.error('Error reading JSONL file:', error);
  }
  
  // Convert Map to Array and sort by last activity
  return Array.from(sessions.values()).sort((a, b) => 
    new Date(b.lastActivity) - new Date(a.lastActivity)
  );
}

// Get messages for a specific session with pagination support
async function getSessionMessages(projectName, sessionId, limit = null, offset = 0) {
  const projectDir = path.join(getProjectsPath(), projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }
    
    const messages = [];
    
    // Process all JSONL files to find messages for this session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      
      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            console.warn('Error parsing line:', parseError.message);
          }
        }
      }
    }
    
    // Sort messages by timestamp
    const sortedMessages = messages.sort((a, b) => 
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );
    
    const total = sortedMessages.length;
    
    // If no limit is specified, return all messages (backward compatibility)
    if (limit === null) {
      return sortedMessages;
    }
    
    // Apply pagination - for recent messages, we need to slice from the end
    // offset 0 should give us the most recent messages
    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;
    
    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();
  
  if (!newDisplayName || newDisplayName.trim() === '') {
    // Remove custom name if empty, will fall back to auto-generated
    delete config[projectName];
  } else {
    // Set custom display name
    config[projectName] = {
      displayName: newDisplayName.trim()
    };
  }
  
  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(getProjectsPath(), projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      throw new Error('No session files found for this project');
    }
    
    // Check all JSONL files to find which one contains the session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const content = await fs.readFile(jsonlFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      // Check if this file contains the session
      const hasSession = lines.some(line => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sessionId;
        } catch {
          return false;
        }
      });
      
      if (hasSession) {
        // Filter out all entries for this session
        const filteredLines = lines.filter(line => {
          try {
            const data = JSON.parse(line);
            return data.sessionId !== sessionId;
          } catch {
            return true; // Keep malformed lines
          }
        });
        
        // Write back the filtered content
        await fs.writeFile(jsonlFile, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''));
        return true;
      }
    }
    
    throw new Error(`Session ${sessionId} not found in any files`);
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete an empty project
async function deleteProject(projectName) {
  const projectDir = path.join(getProjectsPath(), projectName);
  
  try {
    // First check if the project is empty
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty) {
      throw new Error('Cannot delete project with existing sessions');
    }
    
    // Remove the project directory
    await fs.rm(projectDir, { recursive: true, force: true });
    
    // Remove from project config
    const config = await loadProjectConfig();
    delete config[projectName];
    await saveProjectConfig(config);
    
    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (without creating folders)
// Helper function to ensure directory exists (create if needed)
async function ensureDirectoryExists(absolutePath) {
  try {
    // Check if the path exists
    await fs.access(absolutePath);
    return { directoryCreated: false };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Path doesn't exist, try to create it
      try {
        await fs.mkdir(absolutePath, { recursive: true });
        console.log(`Created directory: ${absolutePath}`);
        return { directoryCreated: true };
      } catch (createError) {
        if (createError.code === 'EACCES') {
          throw new Error(`Permission denied creating directory: ${absolutePath}`);
        } else if (createError.code === 'ENOTDIR') {
          throw new Error(`Cannot create directory - parent path is not a directory: ${absolutePath}`);
        } else if (createError.code === 'ENOSPC') {
          throw new Error(`디스크 공간이 부족합니다: ${absolutePath}`);
        } else if (createError.code === 'EROFS') {
          throw new Error(`읽기 전용 파일시스템입니다: ${absolutePath}`);
        } else if (createError.code === 'EMFILE' || createError.code === 'ENFILE') {
          throw new Error(`시스템 리소스가 부족합니다: ${absolutePath}`);
        } else if (createError.code === 'ENAMETOOLONG') {
          throw new Error(`경로 이름이 너무 깁니다: ${absolutePath}`);
        } else {
          throw new Error(`디렉토리 생성 실패: ${absolutePath} - ${createError.message}`);
        }
      }
    } else if (error.code === 'EACCES') {
      throw new Error(`디렉토리 접근이 거부되었습니다: ${absolutePath}`);
    } else {
      throw new Error(`경로에 접근할 수 없습니다: ${absolutePath} - ${error.message}`);
    }
  }
}

// Validate project input and extract clean project name
function validateProjectInput(projectPath) {
  const trimmedPath = projectPath.trim();
  const inputName = path.basename(trimmedPath);
  
  // Validate project name (empty, dots)
  if (!inputName || inputName === '.' || inputName === '..') {
    throw new Error('유효하지 않은 프로젝트 이름입니다. 올바른 디렉토리 이름을 제공해주세요.');
  }
  
  // Strong directory traversal validation
  const normalizedPath = path.normalize(trimmedPath);
  if (normalizedPath.includes('..') || 
      normalizedPath !== trimmedPath ||
      trimmedPath.includes('../') || 
      trimmedPath.includes('..\\')) {
    throw new Error('유효하지 않은 프로젝트 경로입니다. 디렉토리 순회 시도는 허용되지 않습니다.');
  }
  
  return inputName;
}

// Recursively validate path chain to prevent symbolic link bypass
async function validatePathChainSecurity(targetPath, baseDir) {
  const normalizedBase = path.normalize(baseDir);
  let currentPath = path.normalize(targetPath);
  const checkedPaths = new Set(); // Prevent infinite loops
  const resolvedPaths = new Set(); // Track resolved paths for circular detection
  let iterations = 0;
  const maxIterations = 20; // Prevent infinite loops
  
  while (currentPath !== normalizedBase && currentPath !== '/' && currentPath !== path.parse(currentPath).root) {
    // Safety: Prevent infinite loops with iteration limit
    if (++iterations > maxIterations) {
      throw new Error('보안 위반: 순환 심볼릭 링크가 감지되었습니다');
    }
    
    // Prevent infinite loops from circular symbolic links
    if (checkedPaths.has(currentPath)) {
      throw new Error('보안 위반: 순환 심볼릭 링크가 감지되었습니다');
    }
    checkedPaths.add(currentPath);
    
    try {
      // Atomically resolve and validate each path component
      const realPath = await fs.realpath(currentPath);
      const normalizedReal = path.normalize(realPath);
      
      // Check if resolved path is still within base directory
      if (!normalizedReal.startsWith(normalizedBase + path.sep) && normalizedReal !== normalizedBase) {
        throw new Error('보안 위반: 심볼릭 링크를 통한 디렉토리 순회 시도가 감지되었습니다');
      }
      
      // Check for circular references in resolved paths
      if (resolvedPaths.has(normalizedReal)) {
        throw new Error('보안 위반: 순환 심볼릭 링크가 감지되었습니다');
      }
      resolvedPaths.add(normalizedReal);
      
      // Move to parent of resolved path to continue chain validation
      currentPath = path.dirname(normalizedReal);
    } catch (error) {
      // If realpath fails (directory doesn't exist), check parent instead
      if (error.code === 'ENOENT') {
        currentPath = path.dirname(currentPath);
        continue;
      }
      throw new Error(`보안 검증 실패: ${error.message}`);
    }
  }
}

// Perform comprehensive atomic security validation on project path
async function validateProjectSecurity(absolutePath, baseDir) {
  // Security: Enhanced atomic path validation using consistent normalization
  const normalizedAbsolute = path.normalize(absolutePath);
  const normalizedBase = path.normalize(baseDir);
  
  // Initial path boundary check
  if (!normalizedAbsolute.startsWith(normalizedBase + path.sep) && normalizedAbsolute !== normalizedBase) {
    throw new Error(`보안 위반: 프로젝트 경로가 허용된 기본 디렉토리를 벗어났습니다 '${baseDir}'`);
  }
  
  // Comprehensive recursive path chain validation to prevent TOCTOU and symbolic link bypass
  await validatePathChainSecurity(absolutePath, normalizedBase);
}

// Create project directory and return creation status
async function createProjectDirectory(absolutePath) {
  return await ensureDirectoryExists(absolutePath);
}

// Update project configuration with new project
async function updateProjectConfig(absolutePath, displayName) {
  const projectIdentifier = absolutePath.replace(/\//g, '-');
  const config = await loadProjectConfig();
  
  if (config[projectIdentifier]) {
    throw new Error(`프로젝트가 이미 설정되어 있습니다: ${absolutePath}`);
  }
  
  // Add to config as manually added project
  config[projectIdentifier] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };
  
  if (displayName) {
    config[projectIdentifier].displayName = displayName;
  }
  
  await saveProjectConfig(config);
  return projectIdentifier;
}

// Main function - orchestrates project creation process
async function addProjectManually(projectPath, displayName = null) {
  // Step 1: Validate and extract project input
  const inputName = validateProjectInput(projectPath);
  
  // Step 2: Get validated base directory with lazy initialization
  const baseDir = getValidatedBaseDir();
  const absolutePath = path.resolve(baseDir, inputName);
  
  // Step 3: Perform comprehensive security validation
  await validateProjectSecurity(absolutePath, baseDir);
  
  // Step 4: Create project directory
  const { directoryCreated } = await createProjectDirectory(absolutePath);
  
  // Step 5: Update project configuration
  const projectIdentifier = await updateProjectConfig(absolutePath, displayName);
  
  // Step 6: Return project information
  return {
    name: projectIdentifier,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectIdentifier, absolutePath),
    isManuallyAdded: true,
    directoryCreated: directoryCreated,
    sessions: [],
    cursorSessions: []
  };
}

// Fetch Cursor sessions for a given project path
async function getCursorSessions(projectPath) {
  try {
    // Calculate cwdID hash for the project path (Cursor uses MD5 hash)
    const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath = path.join(os.homedir(), '.cursor', 'chats', cwdId);
    
    // Check if the directory exists
    try {
      await fs.access(cursorChatsPath);
    } catch (error) {
      // No sessions for this project
      return [];
    }
    
    // List all session directories
    const sessionDirs = await fs.readdir(cursorChatsPath);
    const sessions = [];
    
    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(cursorChatsPath, sessionId);
      const storeDbPath = path.join(sessionPath, 'store.db');
      
      try {
        // Check if store.db exists
        await fs.access(storeDbPath);
        
        // Capture store.db mtime as a reliable fallback timestamp
        let dbStatMtimeMs = null;
        try {
          const stat = await fs.stat(storeDbPath);
          dbStatMtimeMs = stat.mtimeMs;
        } catch (_) {}

        // Open SQLite database
        const db = await open({
          filename: storeDbPath,
          driver: sqlite3.Database,
          mode: sqlite3.OPEN_READONLY
        });
        
        // Get metadata from meta table
        const metaRows = await db.all(`
          SELECT key, value FROM meta
        `);
        
        // Parse metadata
        let metadata = {};
        for (const row of metaRows) {
          if (row.value) {
            try {
              // Try to decode as hex-encoded JSON
              const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
              if (hexMatch) {
                const jsonStr = Buffer.from(row.value, 'hex').toString('utf8');
                metadata[row.key] = JSON.parse(jsonStr);
              } else {
                metadata[row.key] = row.value.toString();
              }
            } catch (e) {
              metadata[row.key] = row.value.toString();
            }
          }
        }
        
        // Get message count
        const messageCountResult = await db.get(`
          SELECT COUNT(*) as count FROM blobs
        `);
        
        await db.close();
        
        // Extract session info
        const sessionName = metadata.title || metadata.sessionTitle || 'Untitled Session';
        
        // Determine timestamp - prefer createdAt from metadata, fall back to db file mtime
        let createdAt = null;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt).toISOString();
        } else if (dbStatMtimeMs) {
          createdAt = new Date(dbStatMtimeMs).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }
        
        sessions.push({
          id: sessionId,
          name: sessionName,
          createdAt: createdAt,
          lastActivity: createdAt, // For compatibility with Claude sessions
          messageCount: messageCountResult.count || 0,
          projectPath: projectPath
        });
        
      } catch (error) {
        console.warn(`Could not read Cursor session ${sessionId}:`, error.message);
      }
    }
    
    // Sort sessions by creation time (newest first)
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Return only the first 5 sessions for performance
    return sessions.slice(0, 5);
    
  } catch (error) {
    console.error('Error fetching Cursor sessions:', error);
    return [];
  }
}


export {
  getProjects,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache
};