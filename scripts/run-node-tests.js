const { spawnSync } = require('node:child_process');
const path = require('node:path');

const fs = require('node:fs');

const projectRoot = path.resolve(__dirname, '..');
const testDir = path.join(projectRoot, 'test');
const testFiles = fs.readdirSync(testDir)
	.filter(name => name.endsWith('.test.js'))
	.map(name => path.join('test', name));
const args = ['--test', ...testFiles];

const result = spawnSync(process.execPath, args, {
	cwd: projectRoot,
	stdio: 'inherit',
	env: process.env,
});

if (typeof result.status === 'number') {
	process.exit(result.status);
}

process.exit(1);
