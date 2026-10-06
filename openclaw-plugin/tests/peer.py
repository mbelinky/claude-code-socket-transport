"""Reuse the CLI's disposable Unix peer; never touch a live Claude session."""
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tests'))
from test_cli import CLI

peer = CLI()
peer.setUp()
def handle(frame):
    with (peer.root / 'received').open('a') as out:
        out.write(json.dumps(frame['message']['content']) + '\n')
    mode = (peer.root / 'mode').read_text() if (peer.root / 'mode').exists() else 'reply'
    if mode == 'hold':
        peer.reply(frame, 'delivered')
    elif mode == 'deny':
        peer.reply(frame, 'denied')
    else:
        time.sleep(.2)
        peer.reply(frame)
peer.handler = handle
print(json.dumps({'root':str(peer.root),'profile':str(peer.cfg),'session':peer.sid}), flush=True)
try:
    sys.stdin.read()
finally:
    peer.tearDown()
