import * as child_process from 'child_process';
import * as crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { compressImageIfNeeded, validateImageMagicBytes, getMemoryUsage } from './utils/imageCompression.js';

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
      args.push('--print', trimmedCommand);
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
          activeClaudeProcesses.set(processKey, {
            ...activeClaudeProcesses.get(processKey),
            capturedSessionId: sessionState.capturedSessionId
          });
          
          // Send session-created event if we get a new sessionId from Claude CLI
          if (!sessionState.sessionCreatedSent && sessionState.capturedSessionId !== sessionId) {
            sessionState.sessionCreatedSent = true;
            console.log(`📋 Session ID updated: ${sessionId} -> ${sessionState.capturedSessionId}`);
            
            // Send session-created event immediately
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'session-created', sessionId: sessionState.capturedSessionId }));
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
    const { sessionId, cwd, toolsSettings, resume, permissionMode } = options;
    
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
    const trimmedCommand = command ? command.trim() : '';
    
    const tempImagePaths = [];
    let tempDir = null;
    if (options.images && options.images.length > 0) {
      try {
        // Use UUID for guaranteed unique temp directory (race condition safe)
        const sessionHash = sessionId ? sessionId.slice(-8) : 'anon';
        const uniqueId = randomUUID();
        tempDir = path.join(workingDir, '.tmp', 'images', `${sessionHash}_${uniqueId}`);
        await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
        
        for (const [index, image] of options.images.entries()) {
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            console.error('Invalid image data format');
            continue;
          }
          const [, mimeType, base64Data] = matches;
          
          // Initial buffer creation and comprehensive validation
          const originalBuffer = Buffer.from(base64Data, 'base64');
          const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          
          // Basic MIME type check
          if (!allowedTypes.includes(mimeType)) {
            console.error(`❌ Unsupported image type: ${mimeType}`);
            continue;
          }
          
          // Enhanced magic byte validation (MIME type vs actual content)
          if (!validateImageMagicBytes(originalBuffer, mimeType)) {
            console.error(`❌ Image ${index} magic bytes don't match MIME type ${mimeType}`);
            continue;
          }
          
          // Hard limit: 50MB raw file size (before compression)
          const hardLimit = 50 * 1024 * 1024;
          if (originalBuffer.length > hardLimit) {
            console.error(`❌ Image ${index} exceeds hard limit: ${(originalBuffer.length / 1024 / 1024).toFixed(1)}MB > 50MB`);
            continue;
          }
          
          // Monitor memory usage for large image processing
          const memoryBefore = getMemoryUsage();
          
          // Smart compression with fallback to original on failure
          let finalBuffer, compressed, originalSize, finalSize;
          try {
            const compressionResult = await compressImageIfNeeded(originalBuffer, mimeType);
            finalBuffer = compressionResult.buffer;
            compressed = compressionResult.compressed;
            originalSize = compressionResult.originalSize;
            finalSize = compressionResult.finalSize;
            
            // Log memory impact for large files
            if (originalSize > 5 * 1024 * 1024) { // 5MB+
              const memoryAfter = getMemoryUsage();
              const memoryDiff = memoryAfter.heapUsed - memoryBefore.heapUsed;
              console.log(`🧠 Memory impact: ${memoryDiff > 0 ? '+' : ''}${memoryDiff}MB (Heap: ${memoryAfter.heapUsed}MB)`);
            }
          } catch (compressionError) {
            console.error(`❌ Compression failed for image ${index}, using original:`, compressionError.message);
            finalBuffer = originalBuffer;
            compressed = false;
            originalSize = finalSize = originalBuffer.length;
          }
          
          // Determine final extension (might change due to PNG→JPEG conversion)
          let finalExtension = mimeType.split('/')[1] || 'png';
          if (compressed && mimeType === 'image/png' && finalBuffer !== originalBuffer) {
            finalExtension = 'jpg'; // PNG was converted to JPEG
          }
          
          const filename = `image_${index}.${finalExtension}`;
          const filepath = path.join(tempDir, filename);
          
          // Safe file write with backup preservation
          try {
            await fs.writeFile(filepath, finalBuffer);
            tempImagePaths.push(filepath);
            
            if (compressed) {
              console.log(`📁 Saved compressed image: ${filename} (${(originalSize / 1024).toFixed(1)}KB → ${(finalSize / 1024).toFixed(1)}KB)`);
            } else {
              console.log(`📁 Saved image: ${filename} (${(finalSize / 1024).toFixed(1)}KB)`);
            }
          } catch (writeError) {
            console.error(`❌ Failed to write image ${index} to ${filepath}:`, writeError.message);
            // Continue with next image instead of failing entire upload
            continue;
          }
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
      try {
        // Remove from active processes map
        activeClaudeProcesses.delete(processKey);
        
        // Clean up temporary image files
        if (tempImagePaths.length > 0) {
          const cleanupPromises = tempImagePaths.map(imagePath =>
            fs.unlink(imagePath).catch(err => 
              console.error(`❌ Failed to delete temp image ${imagePath}:`, err)
            )
          );
          const results = await Promise.allSettled(cleanupPromises);
          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length > 0) {
            console.warn(`⚠️ Failed to clean ${failed.length}/${results.length} temp files`);
          } else if (tempImagePaths.length > 0) {
            console.log(`✅ Successfully cleaned ${tempImagePaths.length} temp files`);
          }
        }
        
        // Clean up temporary directory
        if (tempDir) {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
          } catch (err) {
            console.error(`❌ Failed to delete temp directory ${tempDir}:`, err);
          }
        }
      } catch (error) {
        console.error('❌ Error during cleanup:', error);
      }
    };

    // Use helper function for stdout data processing
    claudeProcess.stdout.on('data', (data) => {
      processStdoutData(data, ws, sessionId, processKey, sessionState);
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
  abortClaudeSession,
  buildClaudeArgs,
  processStdoutData,
  setupProcessCleanup
};
