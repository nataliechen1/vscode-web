var fs = require("fs");
const fse = require("fs-extra");
const child_process = require("child_process");

if (fs.existsSync("./conav/static")) {
  fs.rmdirSync("./conav/static", { recursive: true });
}

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

child_process.execSync("export VERSION=`git describe --always` && tar zcf conav.$VERSION.tar.gz conav/");

