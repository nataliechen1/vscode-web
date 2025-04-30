var fs = require("fs");
const fse = require("fs-extra");
const child_process = require("child_process");

function exec(cmd, opts) {
  console.info("\x1b[36m%s\x1b[0m", cmd);
  return child_process.execSync(cmd, opts);
}

if (fs.existsSync("./conav/static")) {
  fs.rmdirSync("./conav/static", { recursive: true });
}

process.chdir("./browser");
exec('rm -rf out/* && tsc -b ./', {stdio: 'inherit'});
exec("sed -i 's/.\\/workbench.api/vs\\/workbench\\/workbench.web.main/g' out/workbench.js", {stdio: 'inherit'});
exec("printf '\nrequire([\"vscode-web-browser-main\"], function() { });' >> out/workbench.js", {stdio: 'inherit'});

process.chdir("../");
fse.copySync("./browser/out/workbench.js", "./conav/static/out/workbench.js");
fse.copySync("./dist/extensions", "./conav/static/extensions");
fse.copySync("./dist/node_modules", "./conav/static/node_modules");
fse.copySync("./dist/out", "./conav/static/out");

const webConavExPath = './conav/static/extensions/vscode-gerrit';
fse.ensureDir(webConavExPath, err => {
  console.log(err) // => null
  // dir has now been created, including the directory it is to be placed in
})

process.chdir("./gerrit-vscode-extension");
child_process.execSync('yarn', {stdio: 'inherit'});
child_process.execSync('yarn package', {stdio: 'inherit'});

fse.copySync("./media", "../conav/static/extensions/vscode-gerrit/media");
fse.copySync("./dist", "../conav/static/extensions/vscode-gerrit/dist");
fse.copySync("./package.json", "../conav/static/extensions/vscode-gerrit/package.json");
fse.copySync("./package.nls.json", "../conav/static/extensions/vscode-gerrit/package.nls.json");

process.chdir("../");
const dirCont = fs.readdirSync('.');
dirCont.forEach( ( elm ) => {
	if (elm.match(/conav\..*\.tar\.gz/ig)) {
		fse.removeSync(elm);
	}
});

child_process.execSync("export VERSION=`git describe --always` && echo VERSION=$VERSION > conav/version && tar zcf conav.$VERSION.tar.gz conav/");

