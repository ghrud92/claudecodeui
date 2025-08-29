import * as child_process from 'child_process';
import * as crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Use cross-spawn on Windows for better command execution
let activeClaudeProcesses = new Map(); // Track active processes by session ID

// Helper function to build Claude CLI arguments
function buildClaudeArgs(options, settings) {
  const { sessionId, command, resume, permissionMode, images } = options;
  const trimmedCommand = command ? command.trim() : '';
  
  const args = [];
  let commandForStdin = null;
  
  if (resume && sessionId) {
    args.push('--resume', sessionId);
    if (trimmedCommand) {
      commandForStdin = trimmedCommand;
    }
  } else {
    if (trimmedCommand) {
      commandForStdin = trimmedCommand;
    }
  }
  
  // Add images if provided
  if (images && images.length > 0) {
    for (const image of images) {
      args.push('--image', image);
    }
  }
  
  // Add permission mode
  if (permissionMode && permissionMode !== 'default') {
    args.push('--permission-mode', permissionMode);
  }
  
  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    args.push('--dangerously-skip-permissions');
  } else {
    let allowedTools = [...(settings.allowedTools || [])];
    if (permissionMode === 'plan') {
      const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite'];
      for (const tool of planModeTools) {
        if (!allowedTools.includes(tool)) {
          allowedTools.push(tool);
        }
      }
    }
    allowedTools.forEach(tool => args.push('--allowedTools', tool));
    (settings.disallowedTools || []).forEach(tool => args.push('--disallowedTools', tool));
  }
  
  return { args, commandForStdin };
}

// Helper function to handle stdout data processing
function processStdoutData(data, ws, sessionId, processKey, sessionState) {
  const rawOutput = data.toString();
  const lines = rawOutput.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    // Quick check if line looks like JSON before parsing (performance optimization)
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
      try {
        const response = JSON.parse(trimmedLine);
      
        // Handle session ID capture with race condition protection
        if (response.session_id && !sessionState.capturedSessionId) {
          sessionState.capturedSessionId = response.session_id;
          
          // Atomically update the process entry
          const entry = activeClaudeProcesses.get(processKey);
          if (entry && !entry.capturedSessionId) {
            entry.capturedSessionId = sessionState.capturedSessionId;
            
            // Send session-created event if we get a new sessionId from Claude CLI
            if (!sessionState.sessionCreatedSent && sessionState.capturedSessionId !== sessionId) {
              sessionState.sessionCreatedSent = true;
              console.log(`📋 Session ID updated: ${sessionId} -> ${sessionState.capturedSessionId}`);
              
              // Use setImmediate to ensure WebSocket message is sent after current processing
              setImmediate(() => {
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'session-created', sessionId: sessionState.capturedSessionId }));
                }
              });
            }
          }
        }
        
        ws.send(JSON.stringify({ type: 'claude-response', data: response }));
      } catch (parseError) {
        // If JSON parsing fails, send as plain text
        ws.send(JSON.stringify({ type: 'claude-output', data: trimmedLine }));
      }
    } else {
      // Line doesn't look like JSON, send as plain text
      ws.send(JSON.stringify({ type: 'claude-output', data: trimmedLine }));
    }
  }
}

// Helper function to setup process cleanup
function setupProcessCleanup(claudeProcess, processKey, cleanup) {
  claudeProcess.on('close', (code, signal) => {
    console.log(`🏁 Claude process exited with code ${code}, signal: ${signal}`);
    activeClaudeProcesses.delete(processKey);
    cleanup && cleanup();
  });

  claudeProcess.on('error', (error) => {
    console.error('❌ Error starting Claude CLI:', error);
    activeClaudeProcesses.delete(processKey);
    cleanup && cleanup();
  });
}

async function spawnClaude(command, options = {}, ws) {
  const spawnFunction = process.platform === 'win32' ? crossSpawn.default : child_process.spawn;
  return new Promise(async (resolve, reject) => {
    const { sessionId, cwd, toolsSettings } = options;
    
    // Session state for handling race conditions
    const sessionState = {
      capturedSessionId: null,
      sessionCreatedSent: false
    };

    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Build arguments using helper function
    const { args, commandForStdin } = buildClaudeArgs({ 
      ...options, 
      command 
    }, settings);
    
    const workingDir = cwd || process.cwd();
    
    const tempImagePaths = [];
    let tempDir = null;
    if (images && images.length > 0) {
      try {
        tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
        
        for (const [index, image] of images.entries()) {
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            console.error('Invalid image data format');
            continue;
          }
          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const filepath = path.join(tempDir, filename);
          await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(filepath);
        }
        
        if (tempImagePaths.length > 0 && trimmedCommand) {
            const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
            if (commandForStdin) {
                commandForStdin += imageNote;
            } else {
                const modifiedCommand = trimmedCommand + imageNote;
                const printIndex = args.indexOf('--print');
                if (printIndex !== -1 && printIndex + 1 < args.length) {
                    args[printIndex + 1] = modifiedCommand;
                }
            }
        }
      } catch (error) {
        console.error('Error processing images for Claude:', error);
      }
    }
    
    args.push('--output-format', 'stream-json', '--verbose');
    
    try {
        const claudeConfigPath = path.join(os.homedir(), '.claude.json');
        const claudeConfigData = await fs.readFile(claudeConfigPath, 'utf8');
        const claudeConfig = JSON.parse(claudeConfigData);
        const hasGlobalServers = claudeConfig.mcpServers && Object.keys(claudeConfig.mcpServers).length > 0;
        const projectConfig = claudeConfig.claudeProjects && claudeConfig.claudeProjects[process.cwd()];
        const hasProjectServers = projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0;

        if (hasGlobalServers || hasProjectServers) {
            args.push('--mcp-config', claudeConfigPath);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('❌ MCP config check failed:', error.message);
        }
    }
    
    if (!resume) {
      args.push('--model', 'sonnet');
    }
    
    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }
    
    if (settings.skipPermissions && permissionMode !== 'plan') {
      args.push('--dangerously-skip-permissions');
    } else {
      let allowedTools = [...(settings.allowedTools || [])];
      if (permissionMode === 'plan') {
        const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite'];
        for (const tool of planModeTools) {
          if (!allowedTools.includes(tool)) {
            allowedTools.push(tool);
          }
        }
      }
      allowedTools.forEach(tool => args.push('--allowedTools', tool));
      (settings.disallowedTools || []).forEach(tool => args.push('--disallowedTools', tool));
    }
    
    console.log('Spawning Claude CLI:', 'claude', args.join(' '));
    
    const safeEnv = { PATH: process.env.PATH };
    if (process.env.HOME) safeEnv.HOME = process.env.HOME;
    if (process.env.USERPROFILE) safeEnv.USERPROFILE = process.env.USERPROFILE;

    const claudeProcess = spawnFunction('claude', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnv
    });
    
    claudeProcess.tempImagePaths = tempImagePaths;
    claudeProcess.tempDir = tempDir;
    
    const processKey = sessionId || Date.now().toString();
    activeClaudeProcesses.set(processKey, { process: claudeProcess, capturedSessionId: null });
    
    const cleanup = async () => {
      activeClaudeProcesses.delete(processKey);
      if (tempImagePaths.length > 0) {
        for (const imagePath of tempImagePaths) {
          await fs.unlink(imagePath).catch(err => console.error(`Failed to delete temp image ${imagePath}:`, err));
        }
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(err => console.error(`Failed to delete temp directory ${tempDir}:`, err));
      }
    };

    claudeProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      const lines = rawOutput.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        // Quick check if line looks like JSON before parsing (performance optimization)
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
          try {
            const response = JSON.parse(trimmedLine);
          
          // Handle session ID capture with race condition protection
          if (response.session_id && !capturedSessionId) {
            capturedSessionId = response.session_id;
            
            // Atomically update the process entry
            const entry = activeClaudeProcesses.get(processKey);
            if (entry && !entry.capturedSessionId) {
              entry.capturedSessionId = capturedSessionId;
              
              // Send session-created event if we get a new sessionId from Claude CLI
              // This happens both for new sessions and when --resume returns a different sessionId
              if (!sessionCreatedSent && capturedSessionId !== sessionId) {
                sessionCreatedSent = true;
                console.log(`📋 Session ID updated: ${sessionId} -> ${capturedSessionId}`);
                
                // Use setImmediate to ensure WebSocket message is sent after current processing
                setImmediate(() => {
                  if (ws && ws.readyState === 1) { // Check WebSocket is still open
                    ws.send(JSON.stringify({ type: 'session-created', sessionId: capturedSessionId }));
                  }
                });
              }
            }
          }
          
            ws.send(JSON.stringify({ type: 'claude-response', data: response }));
          } catch (parseError) {
            // If JSON parsing fails, send as plain text
            ws.send(JSON.stringify({ type: 'claude-output', data: trimmedLine }));
          }
        } else {
          // Line doesn't look like JSON, send as plain text
          ws.send(JSON.stringify({ type: 'claude-output', data: trimmedLine }));
        }
      }
    });
    
    claudeProcess.stderr.on('data', (data) => {
      ws.send(JSON.stringify({ type: 'claude-error', error: data.toString() }));
    });
    
    // Setup process cleanup using helper function
    setupProcessCleanup(claudeProcess, processKey, async () => {
      await cleanup();
    });

    // Add completion handlers
    claudeProcess.on('close', async (code) => {
      const trimmedCommand = command ? command.trim() : '';
      ws.send(JSON.stringify({ type: 'claude-complete', exitCode: code, isNewSession: !sessionId && !!trimmedCommand }));
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });
    
    claudeProcess.on('error', async (error) => {
      ws.send(JSON.stringify({ type: 'claude-error', error: error.message }));
      reject(error);
    });
    
    if (commandForStdin) {
      claudeProcess.stdin.write(commandForStdin + '\n');
      claudeProcess.stdin.end();
    } else if (trimmedCommand) {
      claudeProcess.stdin.end();
    }
  });
}

function abortClaudeSession(sessionId) {
  let keyToDelete = null;
  for (const [key, value] of activeClaudeProcesses.entries()) {
    if (key === sessionId || value.capturedSessionId === sessionId) {
      console.log(`🛑 Aborting Claude session: ${sessionId}`);
      value.process.kill('SIGTERM');
      keyToDelete = key;
      break;
    }
  }

  if (keyToDelete) {
    activeClaudeProcesses.delete(keyToDelete);
    return true;
  }

  return false;
}

export {
  spawnClaude,
  abortClaudeSession
};
