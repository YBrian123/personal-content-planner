#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"
node scripts/local.mjs start
open 'http://127.0.0.1:18765/'
