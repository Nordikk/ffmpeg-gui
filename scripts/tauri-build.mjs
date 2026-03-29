import { spawn } from 'node:child_process';

const bundleTargetsByPlatform = {
  darwin: 'app',
  win32: 'nsis'
};

const bundleTarget = bundleTargetsByPlatform[process.platform];
const args = ['tauri', 'build'];

if (bundleTarget) {
  args.push('--bundles', bundleTarget);
}

const child = spawn('npx', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
