"""Thin adapters: wrap in place, ask first, record after."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from controlarmour import Blocked, ControlArmour  # noqa: E402
from controlarmour.frameworks import ControlArmourSecurityAnalyzer, SecurityRisk, anthropic_tool_guard, guard_callable, guard_tools  # noqa: E402
from tests.test_client import StubCore  # noqa: E402


class FakeCrewTool:
    name = "delete_file"

    def _run(self, path: str) -> str:
        return "deleted " + path


class FakeSmolTool:
    name = "shell"

    def forward(self, command: str) -> str:
        return "ran " + command


class FrameworkTests(unittest.TestCase):
    def setUp(self):
        self.core = StubCore()
        self.ca = ControlArmour(title="fw", session_id="fw1")

    def tearDown(self):
        self.core.close()

    def test_guard_tools_wraps_in_place_and_blocks(self):
        crew, smol = FakeCrewTool(), FakeSmolTool()
        self.assertEqual(guard_tools(self.ca, [crew, smol]), 2)
        self.assertEqual(guard_tools(self.ca, [crew, smol]), 0)  # not twice
        self.assertEqual(smol.forward(command="ls"), "ran ls")
        self.assertEqual(self.core.checks[-1]["tool"], "shell")
        self.assertEqual(self.core.checks[-1]["command"], "ls")
        self.assertEqual(self.core.events[-1]["data"]["cmd"], "ls")
        self.core.decision = {"decision": "deny", "reason": "protected folder", "category": "protectedFolder"}
        with self.assertRaises(Blocked):
            crew._run(path="/x/Payroll/a.csv")
        self.assertEqual(self.core.checks[-1]["paths"], ["/x/Payroll/a.csv"])

    def test_guard_callable_async(self):
        async def fetch(url: str) -> str:
            return "page"

        g = guard_callable(self.ca, fetch, tool="fetch")
        self.assertEqual(asyncio.run(g(url="https://example.com")), "page")
        self.assertEqual(self.core.checks[-1]["tool"], "fetch")
        self.assertEqual(self.core.checks[-1]["paths"], [])

    def test_anthropic_loop_guard(self):
        check = anthropic_tool_guard(self.ca)
        check("bash", {"command": "echo hi"})
        self.assertEqual(self.core.checks[-1]["command"], "echo hi")
        self.core.decision = {"decision": "deny", "reason": "no", "category": "x"}
        with self.assertRaises(Blocked):
            check("bash", {"command": "rm -r Payroll"})

    def test_openhands_analyzer_survives_a_pydantic_style_base(self):
        import controlarmour.frameworks as fw

        class StrictModel:
            """Like pydantic: refuses attributes that are not declared fields."""

            def __init__(self, **kw):
                object.__setattr__(self, "__pydantic_fields_set__", set(kw))

            def __setattr__(self, name, value):
                raise ValueError(f'"{type(self).__name__}" object has no field "{name}"')

        # The strict base sits behind the stand-in SecurityAnalyzerBase in the MRO, so
        # every attribute set goes through its pydantic-like __setattr__.
        class Analyzer(fw.ControlArmourSecurityAnalyzer, StrictModel):
            pass

        an = Analyzer(client=self.ca)
        self.assertIs(an.ca, self.ca)
        self.assertEqual(an.security_risk(type("A", (), {"tool_name": "x"})()), SecurityRisk.LOW)
        # The real class on the stand-in base, for symmetry.
        self.assertIs(ControlArmourSecurityAnalyzer(client=self.ca).ca, self.ca)

    def test_openhands_analyzer_rates_refusals_high(self):
        class Act:
            tool_name = "execute_bash"

            class action:
                command = "rm -r /x/Payroll"

        an = ControlArmourSecurityAnalyzer(client=self.ca)
        self.assertEqual(an.security_risk(Act()), SecurityRisk.LOW)
        self.assertEqual(self.core.checks[-1]["command"], "rm -r /x/Payroll")
        self.core.decision = {"decision": "deny", "reason": "protected", "category": "protectedFolder"}
        self.assertEqual(an.security_risk(Act()), SecurityRisk.HIGH)
        self.assertEqual(self.core.events[-1]["type"], "note")
        self.assertEqual(self.core.events[-1]["data"]["kind"], "warning")


if __name__ == "__main__":
    unittest.main()
