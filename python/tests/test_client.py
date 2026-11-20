"""Tests against a stub core (standard library only)."""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from controlarmour import Blocked, ControlArmour, Stopped  # noqa: E402
from controlarmour.langchain import ControlArmourCallbackHandler  # noqa: E402


class StubCore:
    def __init__(self):
        self.events, self.checks, self.acks = [], [], []
        self.control = {"seq": 0}
        self.decision = {"decision": "allow", "category": "other"}
        self.hang_up = False
        self.check_status = 200  # e.g. 500 to make the client probe /health
        self.health_app = "controlarmour"
        self.wait_status = 200  # e.g. 402 for a lapse during an approval
        self.controls: list = []  # a scripted sequence of control answers, consumed first
        core = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"null") if n else None

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if self.path.endswith("/control"):
                    if core.controls:
                        nxt = core.controls.pop(0)
                        if isinstance(nxt, int):
                            return self._send(nxt, {"error": "gone"})
                        return self._send(200, nxt)
                    return self._send(200, core.control)
                if self.path.endswith("/health"):
                    return self._send(200, {"ok": True, "app": core.health_app})
                self._send(404, {"error": "nope"})

            def do_POST(self):
                body = self._body()
                if self.path.endswith("/events"):
                    core.events.extend(body or [])
                    return self._send(200, {"control": core.control})
                if self.path.endswith("/ack"):
                    core.acks.append(body)
                    self.send_response(204)
                    self.end_headers()
                    return
                if self.path.endswith("/check"):
                    core.checks.append(body)
                    if core.hang_up:
                        self.connection.close()
                        return
                    if core.check_status != 200:
                        return self._send(core.check_status, {"error": "broken"})
                    return self._send(200, core.decision)
                if "/approvals/" in self.path:
                    aid = self.path.rsplit("/", 2)[-2]
                    if core.wait_status != 200:
                        return self._send(core.wait_status, {"error": "licence"})
                    return self._send(200, {"decision": "allow", "approvalId": aid, "reason": "approved by the person"})
                self._send(404, {"error": "nope"})

        self.server = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.dir = tempfile.mkdtemp()
        Path(self.dir, "endpoint.json").write_text(json.dumps({"url": self.url, "ingestToken": "tok"}))
        os.environ["CONTROLARMOUR_DATA_DIR"] = self.dir

    def close(self):
        self.server.shutdown()
        self.server.server_close()  # free the port too, so a client sees "refused", not a hang


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.core = StubCore()

    def tearDown(self):
        self.core.close()

    def test_not_running_is_a_no_op(self):
        os.environ["CONTROLARMOUR_DATA_DIR"] = tempfile.mkdtemp()
        ca = ControlArmour(title="x")
        self.assertFalse(ca.connected)
        ca.step("a")
        with ca.check("shell", command="rm -rf /") as d:
            self.assertEqual(d["decision"], "allow")
        ca.done()

    def test_session_steps_and_measurements(self):
        ca = ControlArmour(title="Nightly", agent="bot", session_id="s1")
        self.assertEqual(self.core.events[0]["type"], "session")
        self.assertEqual(self.core.events[0]["data"]["title"], "Nightly")
        ca.step("Load   the\nexport")
        ca.step("Match")
        ca.file("/x/a.txt", content="one\ntwo\n")
        ca.command("go test ./...", exit_code=0, output="ok\n")
        ca.note("looks fine", kind="confirmed")
        ca.done()
        kinds = [e["type"] for e in self.core.events]
        self.assertEqual(kinds, ["session", "status", "status", "step", "status", "step", "step", "file", "code", "command", "note", "step", "status"])
        step1 = self.core.events[3]["data"]
        self.assertEqual((step1["id"], step1["title"]), ("1", "Load the export"))
        f = self.core.events[7]["data"]
        self.assertEqual((f["lines"], f["bytes"], f["action"]), (2, 8, "write"))
        c = self.core.events[9]["data"]
        self.assertEqual((c["cmd"], c["exit"], c["outLines"]), ("go test ./...", 0, 1))

    def test_deny_and_allow(self):
        ca = ControlArmour(title="x", session_id="s2")
        self.core.decision = {"decision": "deny", "reason": "/x/Payroll is a protected folder", "category": "protectedFolder"}
        with self.assertRaises(Blocked) as cm:
            with ca.check("delete_file", paths=["/x/Payroll/a.csv"]):
                self.fail("the body must not run")
        self.assertIn("protected folder", str(cm.exception))
        self.assertEqual(self.core.checks[0]["paths"], ["/x/Payroll/a.csv"])
        self.core.decision = {"decision": "pending", "approvalId": "ap-1", "category": "deleteFiles"}
        with ca.check("shell", command="rm -r build") as d:
            self.assertEqual(d["decision"], "allow")

    def test_guard_decorator(self):
        ca = ControlArmour(title="x", session_id="s3")
        calls = []

        @ca.guard("send_email", command_from=lambda to, body: f"mail {to}")
        def send(to, body):
            calls.append(to)
            return "sent"

        send("a@b", "hi")
        self.assertEqual(calls, ["a@b"])
        self.assertEqual(self.core.checks[-1]["tool"], "send_email")
        self.assertEqual(self.core.events[-1]["type"], "command")
        self.core.decision = {"decision": "deny", "reason": "no", "category": "sendMessages"}
        with self.assertRaises(Blocked):
            send("c@d", "hi")
        self.assertEqual(calls, ["a@b"])

    def test_stop_and_pause_and_messages(self):
        ca = ControlArmour(title="x", session_id="s4")
        self.core.control = {"seq": 3, "message": "hold on", "pause": False}
        ca.step("go")
        self.assertEqual(ca.messages(), ["hold on"])
        self.assertEqual(ca.messages(), [])
        self.assertEqual(self.core.acks[-1]["seq"], 3)
        self.core.control = {"seq": 4, "stop": True}
        with self.assertRaises(Stopped):
            ca.ask("shell", command="ls")

    def test_lost_contact_fails_closed(self):
        ca = ControlArmour(title="x", session_id="s5")
        self.core.hang_up = True
        with self.assertRaises(Blocked) as cm:
            ca.ask("shell", command="ls")
        self.assertIn("lost contact", str(cm.exception))

    def test_langchain_handler_blocks_tool(self):
        h = ControlArmourCallbackHandler(title="LC", client=ControlArmour(title="LC", session_id="s6"))
        h.on_chain_start({}, {"input": "do the thing"}, run_id="r0", parent_run_id=None)
        self.core.decision = {"decision": "deny", "reason": "no", "category": "deleteFiles"}
        with self.assertRaises(Blocked):
            h.on_tool_start({"name": "delete_file"}, '{"path": "/x/Payroll/a.csv"}', run_id="r1")
        self.assertEqual(self.core.checks[-1]["tool"], "delete_file")
        self.assertEqual(self.core.checks[-1]["paths"], ["/x/Payroll/a.csv"])
        self.core.decision = {"decision": "allow", "category": "other"}
        h.on_tool_start({"name": "search"}, "weather", run_id="r2")
        h.on_tool_end("sunny", run_id="r2")
        self.assertEqual(self.core.events[-1]["data"]["cmd"], "search")


if __name__ == "__main__":
    unittest.main()


class ContractEdgeTests(unittest.TestCase):
    """The lines of the hook contract the happy path does not exercise."""

    def setUp(self):
        self.core = StubCore()

    def tearDown(self):
        self.core.close()
        os.environ.pop("http_proxy", None)
        os.environ.pop("HTTP_PROXY", None)

    def test_nothing_listens_fails_open(self):
        # endpoint.json points at a closed port: not running, carry on.
        d = tempfile.mkdtemp()
        Path(d, "endpoint.json").write_text(json.dumps({"url": "http://127.0.0.1:9", "ingestToken": "tok"}))
        os.environ["CONTROLARMOUR_DATA_DIR"] = d
        ca = ControlArmour(title="x", session_id="e1")
        self.assertEqual(ca.ask("shell", command="ls")["decision"], "allow")

    def test_developer_proxy_is_ignored(self):
        os.environ["http_proxy"] = "http://127.0.0.1:9"
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        ca = ControlArmour(title="x", session_id="e2")
        self.core.decision = {"decision": "deny", "reason": "no", "category": "x"}
        with self.assertRaises(Blocked):
            ca.ask("shell", command="ls")
        self.assertEqual(self.core.checks[-1]["command"], "ls")

    def test_broken_check_from_controlarmour_blocks(self):
        ca = ControlArmour(title="x", session_id="e3")
        self.core.check_status = 500
        with self.assertRaises(Blocked) as cm:
            ca.ask("shell", command="ls")
        self.assertIn("could not check", str(cm.exception))

    def test_broken_check_from_something_else_opens(self):
        ca = ControlArmour(title="x", session_id="e4")
        self.core.check_status = 500
        self.core.health_app = "someone-else"
        self.assertEqual(ca.ask("shell", command="ls")["decision"], "allow")

    def test_lapse_during_approval_opens(self):
        ca = ControlArmour(title="x", session_id="e5")
        self.core.decision = {"decision": "pending", "approvalId": "ap-9", "category": "deleteFiles"}
        self.core.wait_status = 402
        self.assertEqual(ca.ask("shell", command="rm -r build")["decision"], "allow")

    def test_pause_then_resume(self):
        ca = ControlArmour(title="x", session_id="e6")
        import controlarmour.client as c
        old = c.PAUSE_POLL_S
        c.PAUSE_POLL_S = 0.05
        try:
            self.core.controls = [{"seq": 1, "pause": True}, {"seq": 1, "pause": True}, {"seq": 2, "pause": False}]
            self.assertEqual(ca.ask("shell", command="ls")["decision"], "allow")
            self.assertEqual(self.core.controls, [])
            # Losing the core while paused keeps the agent paused.
            self.core.controls = [{"seq": 3, "pause": True}, 500]
            with self.assertRaises(Blocked) as cm:
                ca.ask("shell", command="ls")
            self.assertIn("paused", str(cm.exception))
        finally:
            c.PAUSE_POLL_S = old

    def test_restarted_core_is_found_again(self):
        ca = ControlArmour(title="x", session_id="e7")
        other = StubCore()  # writes a new endpoint.json with another port
        try:
            self.core.close()
            other.decision = {"decision": "deny", "reason": "moved", "category": "x"}
            with self.assertRaises(Blocked):
                ca.ask("shell", command="ls")
            self.assertEqual(other.checks[-1]["command"], "ls")
        finally:
            other.close()
