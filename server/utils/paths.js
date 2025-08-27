import path from 'path';
import os from 'os';

// Flag to track if we've warned about PROJECTS_PATH deprecation
let warnedAboutProjectsPath = false;

// Get home directory with proper fallback and error handling
function getHomeDirectory() {
    const home = process.env.HOME || os.homedir();
    if (!home) {
        throw new Error('Unable to determine home directory. Please ensure HOME environment variable is set.');
    }
    return home;
}

// Get projects directory path from environment or default
export function getProjectsPath() {
    // Warn about deprecated PROJECTS_PATH usage (only once)
    if (process.env.PROJECTS_PATH && process.env.PROJECTS_PATH.trim() && !warnedAboutProjectsPath) {
        warnedAboutProjectsPath = true;
        console.warn('⚠️  PROJECTS_PATH environment variable is deprecated and will be ignored.');
        console.warn('   Projects are now stored in ~/.claude/projects by default.');
        console.warn('   Please update your configuration and move existing projects if needed.');
    }
    
    const home = getHomeDirectory();
    return path.join(home, '.claude', 'projects');
}

// Get claude directory path from environment or default
export function getClaudeDir() {
    const home = getHomeDirectory();
    return path.join(home, '.claude');
}