const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getGitTagVersion() {
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    const match = process.env.GITHUB_REF_NAME.match(/\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i);
    if (match) return match[1];
  }

  if (process.env.MESAI_VERSION) {
    const match = process.env.MESAI_VERSION.match(/\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i);
    if (match) return match[1];
  }

  try {
    const rawTag = execSync('git describe --tags --exact-match', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const match = rawTag.match(/\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i);
    if (match) return match[1];
  } catch {
    // Git not available or no tags in repo
  }

  return null;
}

function syncTauriVersions(version) {
  const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
  if (fs.existsSync(tauriConfPath)) {
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    if (conf.version !== version) {
      conf.version = version;
      fs.writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');
      console.log(`[sync-version] Synced tauri.conf.json version -> ${version}`);
    }
  }

  const cargoTomlPath = path.resolve(__dirname, '../src-tauri/Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    const raw = fs.readFileSync(cargoTomlPath, 'utf8');
    const updated = raw.replace(
      /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
      `$1${version}$3`
    );
    if (updated !== raw) {
      fs.writeFileSync(cargoTomlPath, updated, 'utf8');
      console.log(`[sync-version] Synced Cargo.toml version -> ${version}`);
    }
  }
}

function syncVersion() {
  const pkgPath = path.resolve(__dirname, '../package.json');
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const tagVersion = getGitTagVersion();
  const shouldSyncFromTag = Boolean(process.env.GITHUB_REF_TYPE === 'tag' || process.env.MESAI_VERSION);

  if (shouldSyncFromTag && tagVersion && pkg.version !== tagVersion) {
    console.log(`[sync-version] Updated package.json version from git tag: ${pkg.version} -> ${tagVersion}`);
    pkg.version = tagVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } else {
    console.log(`[sync-version] Active version: ${pkg.version} (git tag: ${tagVersion || 'none'})`);
  }

  syncTauriVersions(pkg.version);
}

syncVersion();
