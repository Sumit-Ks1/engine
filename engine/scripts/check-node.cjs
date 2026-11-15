const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nThis engine needs Node.js 22.13 or newer. You are running ${process.versions.node}.\nInstall the current LTS from https://nodejs.org and run the command again.\n`);
  process.exit(1);
}
