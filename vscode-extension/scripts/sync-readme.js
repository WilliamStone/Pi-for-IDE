// 打包时把仓库根 README.md 同步为扩展 readme.md（商店列表页渲染此文件）
// 单一来源：根 README.md；本产物不提交（.gitignore）
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', 'README.md');
fs.copyFileSync(root, path.join(__dirname, '..', 'readme.md'));
console.log('synced ../README.md -> readme.md');
