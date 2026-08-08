import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = exec('git', ['rev-parse', '--show-toplevel']).trim();
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const backupDirectory = path.join(root, '.git', 'backups');

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function runChecked(command, args) {
  exec(command, args, { inherit: true });
}

function runOptional(command, args) {
  try {
    runChecked(command, args);
    return true;
  } catch (error) {
    return error;
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error(`版本号必须是 x.y.z，收到：${value}`);
  return match.slice(1).map(Number);
}

function nextVersion(current, requested) {
  const [major, minor, patch] = parseVersion(current);
  if (requested === 'major') return `${major + 1}.0.0`;
  if (requested === 'minor') return `${major}.${minor + 1}.0`;
  if (requested === 'patch') return `${major}.${minor}.${patch + 1}`;
  parseVersion(requested);
  return requested;
}

function updatePackageVersion(version) {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const lockJson = JSON.parse(readFileSync(lockPath, 'utf8'));
  lockJson.version = version;
  if (lockJson.packages?.['']) lockJson.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lockJson, null, 2)}\n`, 'utf8');
}

function restoreFiles(originalPackage, originalLock) {
  writeFileSync(packagePath, originalPackage, 'utf8');
  writeFileSync(lockPath, originalLock, 'utf8');
}

function usage() {
  console.log('用法：npm run release -- patch|minor|major|x.y.z [--no-push]');
  console.log('示例：npm run release -- patch');
  console.log('      npm run release -- 0.2.0 --no-push');
}

const argumentsList = process.argv.slice(2);
if (argumentsList.includes('--help') || argumentsList.includes('-h') || argumentsList.length === 0) {
  usage();
  process.exit(argumentsList.length === 0 ? 1 : 0);
}

const requestedVersion = argumentsList.find((value) => !value.startsWith('--'));
const pushEnabled = !argumentsList.includes('--no-push');
if (!requestedVersion) {
  usage();
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const version = nextVersion(packageJson.version, requestedVersion);
const tag = `v${version}`;
const originalPackage = readFileSync(packagePath, 'utf8');
const originalLock = readFileSync(lockPath, 'utf8');

console.log(`准备发布 ${tag}`);
console.log('1/5 运行测试与生产构建');
runChecked('npm', ['test']);
runChecked('npm', ['run', 'build']);

console.log('2/5 更新 package.json 与 package-lock.json');
updatePackageVersion(version);

try {
  console.log('3/5 创建版本提交与 Git 标签');
  runChecked('git', ['diff', '--check']);
  runChecked('git', ['add', '-A']);
  runChecked('git', ['commit', '-m', `release: ${tag}`]);
  runChecked('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
} catch (error) {
  restoreFiles(originalPackage, originalLock);
  throw error;
}

console.log('4/5 创建本地 Git bundle 备份');
mkdirSync(backupDirectory, { recursive: true });
const backupPath = path.join(backupDirectory, `dypro-${tag}.bundle`);
runChecked('git', ['bundle', 'create', backupPath, '--all']);
console.log(`本地备份：${backupPath}`);

if (!pushEnabled) {
  console.log('5/5 已跳过 GitHub 推送（--no-push），本地版本已保存。');
  process.exit(0);
}

const branch = exec('git', ['branch', '--show-current']).trim();
const pushResult = runOptional('git', ['push', 'origin', branch, '--follow-tags']);
if (pushResult !== true) {
  console.error(`5/5 GitHub 推送失败，版本仍保存在本地。请稍后重试：git push origin ${branch} --follow-tags`);
  console.error(`可恢复备份：${backupPath}`);
  process.exitCode = 2;
  process.exit();
}

console.log(`5/5 已推送 GitHub：${branch} + ${tag}`);
