#!/usr/bin/env python3
"""Serve the planner locally (ES modules need http, not file://).

    ./serve.py [port]      # default 8765, then open http://localhost:8765
Tests: node --test planner.test.mjs
"""
import http.server, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f"Node pool planner on http://localhost:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), http.server.SimpleHTTPRequestHandler).serve_forever()
