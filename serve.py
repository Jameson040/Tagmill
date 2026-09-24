#!/usr/bin/env python3
"""Tagmill dev server — static files with COOP/COEP headers (required for WASM multithreading).

Usage:  python3 serve.py [port]     (default 8080, serves this directory)
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.mjs': 'text/javascript',
        '.js': 'text/javascript',
        '.json': 'application/json',
    }

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def translate_path(self, path):
        # /models and /fixtures can be mapped to sibling dirs when present
        if path.startswith('/models/'):
            local = os.path.join(os.path.dirname(ROOT), 'tests', 'models', path[len('/models/'):])
            if os.path.exists(local):
                return local
        return super().translate_path(path)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(ROOT)
    with http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler) as httpd:
        print(f'Tagmill serving on http://localhost:{port}  (COOP/COEP enabled)')
        httpd.serve_forever()
