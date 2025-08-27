import path from 'path';

// Get projects directory path from environment or default
export function getProjectsPath() {
    return path.join(process.env.HOME, '.claude', 'projects');
}

// Get claude directory path from environment or default
export function getClaudeDir() {
    return path.join(process.env.HOME, '.claude');
}