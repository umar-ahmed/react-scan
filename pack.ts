#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const net = require('net');

// Paths
const currentDir = process.cwd();
const testAppPath = '/Users/robby/scan-test';
const testAppPackageJsonPath = path.join(testAppPath, 'package.json');

let viteProcess = null;
let isProcessing = false;
let debounceTimer = null;

// Helper to run commands and log output
const run = (command) => {
  console.log(`\n> ${command}`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Failed to execute: ${command}`);
    process.exit(1);
  }
};

// Check if port is in use
const isPortInUse = (port) => {
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => {
        server.close();
        resolve(false);
      })
      .listen(port);
  });
};

// Kill process by port with retries
const killProcessOnPort = async (port) => {
  const maxAttempts = 3;
  const waitTime = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (process.platform === 'win32') {
        execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' })
          .split('\n')
          .forEach((line) => {
            const pid = line.trim().split(/\s+/).pop();
            if (pid) execSync(`taskkill /F /PID ${pid}`);
          });
      } else {
        const pids = execSync(`lsof -t -i:${port}`, { encoding: 'utf-8' })
          .split('\n')
          .filter(Boolean);

        pids.forEach((pid) => {
          execSync(`kill -9 ${pid}`);
        });
      }

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      const stillInUse = await isPortInUse(port);

      if (!stillInUse) {
        console.log(`Successfully freed port ${port}`);
        return true;
      }

      console.log(
        `Port ${port} still in use after attempt ${attempt}/${maxAttempts}, retrying...`,
      );
    } catch (error) {
      const stillInUse = await isPortInUse(port);
      if (!stillInUse) {
        console.log(`Port ${port} is free`);
        return true;
      }
      console.log(
        `Failed to kill process on port ${port}, attempt ${attempt}/${maxAttempts}`,
      );
    }
  }

  throw new Error(`Failed to free port ${port} after ${maxAttempts} attempts`);
};

async function rebuild() {
  if (isProcessing) {
    console.log('Already processing a change, skipping...');
    return;
  }

  isProcessing = true;
  console.log('\n🔄 Detected change, rebuilding...');

  try {
    // Kill existing Vite process if it exists
    if (viteProcess) {
      console.log('Killing existing Vite process...');
      viteProcess.kill();
      viteProcess = null;
    }

    // 1. Run build
    console.log('Building package...');
    run('npm run build');

    // 2. Bump version
    console.log('\nBumping version...');
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const version = packageJson.version.split('.');
    version[2] = parseInt(version[2]) + 1;
    packageJson.version = version.join('.');
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
    console.log(`Version bumped to ${packageJson.version}`);

    // 3. Pack
    console.log('\nPacking...');
    run('npm pack');
    const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
    console.log(`Created ${tarballName}`);

    // 4. Update test app's package.json
    console.log('\nUpdating test app package.json...');
    const testAppPackageJson = JSON.parse(
      fs.readFileSync(testAppPackageJsonPath, 'utf8'),
    );
    testAppPackageJson.dependencies['react-scan'] =
      `file:${path.join(currentDir, tarballName)}`;
    fs.writeFileSync(
      testAppPackageJsonPath,
      JSON.stringify(testAppPackageJson, null, 2),
    );

    // 5. Kill existing Vite server
    console.log('\nKilling existing Vite server...');
    try {
      await killProcessOnPort(5173);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await isPortInUse(5173)) {
        throw new Error('Port 5173 still in use after killing process');
      }
    } catch (error) {
      console.error('Failed to free port 5173:', error.message);
      process.exit(1);
    }

    // 6. Install in test app
    console.log('\nInstalling in test app...');
    process.chdir(testAppPath);
    run('pnpm install');

    // 7. Start Vite server
    console.log('\nStarting Vite server...');
    viteProcess = spawn('pnpm', ['dev'], {
      stdio: 'inherit',
      shell: true,
    });

    viteProcess.on('error', (err) => {
      console.error('Failed to start Vite server:', err);
      process.exit(1);
    });

    console.log('\n✨ Done! Watching for changes...');
  } catch (error) {
    console.error('Build failed:', error);
  } finally {
    isProcessing = false;
  }
}

// Main script
async function main() {
  // Initial build
  await rebuild();

  // Watch for changes
  const watcher = fs.watch(
    'src',
    { recursive: true },
    (eventType, filename) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        console.log(`\nDetected ${eventType} in ${filename}`);
        rebuild();
      }, 500); // 500ms debounce
    },
  );

  console.log('\n👀 Watching src directory for changes...');

  // Handle script termination
  const cleanup = () => {
    if (viteProcess) {
      viteProcess.kill();
    }
    watcher.close();
    process.exit();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
