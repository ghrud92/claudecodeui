import path from 'path';
import os from 'os';

// Check for deprecated PROJECTS_PATH at module load time
const PROJECTS_PATH_DEPRECATED = process.env.PROJECTS_PATH && process.env.PROJECTS_PATH.trim();
let warnedAboutProjectsPath = false;

// Get home directory with proper fallback and error handling
function getHomeDirectory() {
    try {
        const home = process.env.HOME || os.homedir();
        if (!home) {
            throw new Error('Unable to determine home directory. Please ensure HOME environment variable is set.');
        }
        return home;
    } catch (error) {
        throw new Error(`Failed to get home directory: ${error.message}`);
    }
}

// Get projects directory path from environment or default
export function getProjectsPath() {
    // Warn about deprecated PROJECTS_PATH usage (only once)
    if (PROJECTS_PATH_DEPRECATED && !warnedAboutProjectsPath) {
        warnedAboutProjectsPath = true;
        console.warn('⚠️  PROJECTS_PATH environment variable is deprecated and will be ignored.');
        console.warn('   Projects are now stored in ~/.claude/projects by default.');
        console.warn('   Please update your configuration and move existing projects if needed.');
        console.warn('   Migration guide: https://github.com/ghrud92/claudecodeui/wiki/Migration-Guide');
    }
    
    const home = getHomeDirectory();
    return path.join(home, '.claude', 'projects');
}

// Get claude directory path from environment or default
export function getClaudeDir() {
    const home = getHomeDirectory();
    return path.join(home, '.claude');
}