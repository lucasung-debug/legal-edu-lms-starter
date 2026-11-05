// 실행 파일이 호출한다: Node.js 22.13 이상이면 0, 아니면 1로 끝난다
const [major, minor] = process.versions.node.split('.').map(Number);
process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
