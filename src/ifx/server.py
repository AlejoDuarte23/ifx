import threading
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

_RUNNING_HANDLES: set["ViewerHandle"] = set()


@dataclass(eq=False, slots=True)
class ViewerHandle:
    """Handle for a local viewer server."""

    url: str
    _server: ThreadingHTTPServer
    _thread: threading.Thread
    _closed: bool = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._server.shutdown()
        self._server.server_close()
        if self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)
        _RUNNING_HANDLES.discard(self)

    def wait(self, poll_interval: float = 0.25) -> None:
        """Keep the calling process alive until interrupted or closed."""

        try:
            while not self._closed and self._thread.is_alive():
                time.sleep(poll_interval)
        except KeyboardInterrupt:
            self.close()

    def __enter__(self) -> "ViewerHandle":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def start_viewer_server(
    *,
    html: str,
    payload: bytes,
    token: str,
    port: int = 0,
    browser: str | None = None,
    open_browser: bool = True,
) -> ViewerHandle:
    """Serve one viewer page and its binary payload on localhost."""

    if not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")

    base_path = f"/{token}"
    html_bytes = html.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        server_version = "IFX/0.1"

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = self.path.split("?", 1)[0]
            if path in {base_path, f"{base_path}/", f"{base_path}/index.html"}:
                self._send_bytes(
                    html_bytes,
                    "text/html; charset=utf-8",
                    cache="no-store",
                )
                return
            if path == f"{base_path}/model.ifcv.gz":
                self._send_bytes(
                    payload,
                    "application/octet-stream",
                    cache="private, max-age=3600",
                )
                return
            if path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            self.send_error(HTTPStatus.NOT_FOUND)

        def _send_bytes(self, data: bytes, content_type: str, *, cache: str) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual_port = int(server.server_address[1])
    url = f"http://127.0.0.1:{actual_port}{base_path}/"
    thread = threading.Thread(
        target=server.serve_forever,
        name=f"ifx-{actual_port}",
        daemon=True,
    )
    thread.start()
    handle = ViewerHandle(url=url, _server=server, _thread=thread)
    _RUNNING_HANDLES.add(handle)
    if open_browser:
        controller = webbrowser.get(browser) if browser else webbrowser
        controller.open(url, new=2)
    return handle
