"""
Tiny static file server for the built game.

Chrome refuses to load ES modules over file:// (CORS: origin 'null'), so the
playtest has to serve dist/ over HTTP. Kept dependency-free and silent so it
can be used as a context manager from the test scripts.

    from tools.serve import serve
    with serve() as url:
        ...
"""

import contextlib
import functools
import http.server
import socketserver
import threading


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - silence the access log
        pass


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


@contextlib.contextmanager
def serve(directory, port=0):
    """Serve `directory` on a free port; yields the base URL."""
    handler = functools.partial(_Quiet, directory=str(directory))
    httpd = _Server(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    finally:
        httpd.shutdown()
        httpd.server_close()
