const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('fs-extra');

const projectRoot = path.resolve(__dirname, '..');
const runnerPath = path.join(projectRoot, 'scripts', 'build-runner.js');

function isUncPath(targetPath) {
	return String(targetPath || '').startsWith('\\\\');
}

function copyFilter(src) {
	const rel = path.relative(projectRoot, src);
	if (!rel) return true;
	const top = rel.split(path.sep)[0];
	if (['dist', 'publish', '.git'].includes(top)) return false;
	return true;
}

async function stageAndBuild() {
	const tempBase = process.env.TEMP || 'C:\\Windows\\Temp';
	const stageDir = path.join(tempBase, 'openclaw-build', 'joplin-search-workbench');
	await fs.remove(stageDir);
	await fs.mkdirp(path.dirname(stageDir));
	await fs.copy(projectRoot, stageDir, { filter: copyFilter, dereference: true });

	const stagedRunner = path.join(stageDir, 'scripts', 'build-runner.js');
	const result = spawnSync(process.execPath, [stagedRunner], {
		cwd: stageDir,
		stdio: 'inherit',
		env: {
			...process.env,
			OPENCLAW_BUILD_NO_STAGE: '1',
		},
	});
	if (result.status !== 0) process.exit(result.status || 1);

	await fs.remove(path.join(projectRoot, 'dist'));
	await fs.remove(path.join(projectRoot, 'publish'));
	await fs.copy(path.join(stageDir, 'dist'), path.join(projectRoot, 'dist'));
	await fs.copy(path.join(stageDir, 'publish'), path.join(projectRoot, 'publish'));

	for (const suffix of ['jpl', 'json']) {
		const stagedFiles = await fs.readdir(stageDir);
		for (const file of stagedFiles) {
			if (!file.endsWith(`.${suffix}`)) continue;
			await fs.copy(path.join(stageDir, file), path.join(projectRoot, file));
		}
	}
}

async function main() {
	if (!isUncPath(projectRoot) || process.env.OPENCLAW_BUILD_NO_STAGE === '1') {
		require(runnerPath);
		return;
	}
	await stageAndBuild();
}

main().catch(error => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exit(1);
});
