const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const fs = require('fs-extra');
const glob = require('glob');
const tar = require('tar');
const webpack = require('webpack');

const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');
const publishDir = path.join(projectRoot, 'publish');
const webpackConfigFactory = require(path.join(projectRoot, 'webpack.config.js'));
const manifest = fs.readJsonSync(path.join(srcDir, 'manifest.json'));

function fileSha256(filePath) {
	const content = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(content).digest('hex');
}

function currentGitInfo() {
	try {
		let branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
		const commit = execSync('git rev-parse HEAD', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
		if (branch === 'HEAD') branch = 'master';
		return `${branch}:${commit}`;
	} catch (_error) {
		return '';
	}
}

function runWebpack(config) {
	return new Promise((resolve, reject) => {
		const compiler = webpack(config);
		compiler.run((error, stats) => {
			compiler.close(() => {
				if (error) return reject(error);
				if (stats && stats.hasErrors()) {
					const info = stats.toJson({ all: false, errors: true, warnings: true });
					const message = (info.errors || []).map(item => item.message || String(item)).join('\n\n') || 'Webpack 构建失败';
					return reject(new Error(message));
				}
				resolve(stats);
			});
		});
	});
}

async function copyStaticAssets() {
	const files = glob.sync('**/*', {
		cwd: srcDir,
		nodir: true,
		ignore: ['**/*.ts', '**/*.tsx'],
	});
	for (const file of files) {
		await fs.copy(path.join(srcDir, file), path.join(distDir, file));
	}
	return files;
}

async function createArchive() {
	const archivePath = path.join(publishDir, `${manifest.id}.jpl`);
	const infoPath = path.join(publishDir, `${manifest.id}.json`);
	const distFiles = glob.sync('**/*', {
		cwd: distDir,
		nodir: true,
	});
	if (!distFiles.length) throw new Error('dist 目录为空，无法打包');

	await fs.remove(archivePath);
	await tar.create({
		strict: true,
		portable: true,
		file: archivePath,
		cwd: distDir,
		sync: true,
	}, distFiles);

	const info = {
		...manifest,
		_publish_hash: `sha256:${fileSha256(archivePath)}`,
		_publish_commit: currentGitInfo(),
	};
	await fs.writeJson(infoPath, info, { spaces: 2 });
	return { archivePath, infoPath, distFiles };
}

async function main() {
	await fs.remove(distDir);
	await fs.remove(publishDir);
	await fs.mkdirp(distDir);
	await fs.mkdirp(publishDir);

	const mainConfigs = webpackConfigFactory({ 'joplin-plugin-config': 'buildMain' }) || [];
	if (!mainConfigs.length) throw new Error('没有拿到 buildMain webpack 配置');
	const mainConfig = {
		...mainConfigs[0],
		context: projectRoot,
		entry: path.join(projectRoot, 'src', 'index.ts'),
		output: {
			...(mainConfigs[0].output || {}),
			path: distDir,
			filename: 'index.js',
		},
	};

	await runWebpack(mainConfig);
	const copiedFiles = await copyStaticAssets();
	const packaged = await createArchive();
	const rootArchive = path.join(projectRoot, `${manifest.id}.jpl`);
	const rootInfo = path.join(projectRoot, `${manifest.id}.json`);
	await fs.copy(packaged.archivePath, rootArchive);
	await fs.copy(packaged.infoPath, rootInfo);

	console.log('Build OK');
	console.log(`Copied assets: ${copiedFiles.join(', ')}`);
	console.log(`Archive: ${packaged.archivePath}`);
	console.log(`Archive files: ${packaged.distFiles.join(', ')}`);
}

main().catch(error => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exit(1);
});
