#!/bin/sh
# macOS용 실행 파일. 더블클릭이 막히면 터미널에서: sh 시작하기.command
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. 열리는 페이지에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  open "https://nodejs.org/ko/download"
  exit 1
fi
if ! node check-node.js; then
  echo "Node.js 버전이 낮습니다. 22.13 이상이 필요합니다."
  open "https://nodejs.org/ko/download"
  exit 1
fi

PORT="${PORT:-3000}"
(sleep 2; open "http://localhost:$PORT") &
exec node --disable-warning=ExperimentalWarning server.js
