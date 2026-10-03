do shell script "
  cd /Users/a/trading/openalice-fleet/office-hud
  PORT=4747
  lsof -ti:$PORT >/dev/null 2>&1 || nohup node server/index.js >/tmp/office-hud.log 2>&1 &
  sleep 1
  open http://localhost:$PORT
"
