import path from 'path';
import os from 'os';

// Get projects directory path from environment or default
export function getProjectsPath() {
    // Warn about deprecated PROJECTS_PATH usage
    if (process.env.PROJECTS_PATH) {
        console.warn('⚠️  PROJECTS_PATH environment variable is deprecated and will be ignored.');
        console.warn('   Projects are now stored in ~/.claude/projects by default.');
        console.warn('   Please update your configuration and move existing projects if needed.');
    }
    
    // Get home directory with fallback
    const home = process.env.HOME || os.homedir();
    if (!home) {
        throw new Error('Unable to determine home directory. Please ensure HOME environment variable is set.');
    }
    
    return path.join(home, '.claude', 'projects');
}

// Get claude directory path from environment or default
export function getClaudeDir() {
    // Get home directory with fallback
    const home = process.env.HOME || os.homedir();
    if (!home) {
        throw new Error('Unable to determine home directory. Please ensure HOME environment variable is set.');
    }
    
    return path.join(home, '.claude');
}