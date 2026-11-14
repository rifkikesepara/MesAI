const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function buildSidecar() {
  const esbuild = require('esbuild');
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist-sidecar');
  const binariesDir = path.join(rootDir, 'src-tauri', 'binaries');
  const bundlePath = path.join(distDir, 'mesai-backend.cjs');
  const seaConfigPath = path.join(distDir, 'sea-config.json');
  const blobPath = path.join(distDir, 'sea-prep.blob');

  const targetTriple =
    process.platform === 'win32'
      ? process.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'aarch64-apple-darwin'
          : 'x86_64-apple-darwin'
        : 'x86_64-unknown-linux-gnu';

  const ext = process.platform === 'win32' ? '.exe' : '';
  const outputExe = path.join(binariesDir, `mesai-backend-${targetTriple}${ext}`);

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(binariesDir, { recursive: true });

  console.log('[build-sidecar] Bundling src/main/sidecar-entry.ts -> dist-sidecar/mesai-backend.cjs');
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'main', 'sidecar-entry.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: false,
    minify: false
  });

  const seaConfig = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  console.log('[build-sidecar] Generating Node SEA blob...');
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  console.log(`[build-sidecar] Copying node binary -> ${path.relative(rootDir, outputExe)}`);
  fs.copyFileSync(process.execPath, outputExe);

  console.log('[build-sidecar] Injecting SEA blob via postject...');
  const postjectCli = require.resolve('postject/dist/cli.js');
  const postjectArgs = [
    postjectCli,
    outputExe,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  execFileSync(process.execPath, postjectArgs, {
    cwd: rootDir,
    stdio: 'inherit'
  });

  console.log(`[build-sidecar] Ready: ${outputExe}`);
}

buildSidecar().catch((err) => {
  console.error('[build-sidecar] Failed:', err);
  process.exit(1);
});
