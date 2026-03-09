const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const args = ['--test', path.join('test', 'search-core.test.js')];

const result = spawnSync(process.execPath, args, {
	cwd: projectRoot,
	stdio: 'inherit',
	env: process.env,
});

if (typeof result.status === 'number') {
	process.exit(result.status);
}

process.exit(1);
