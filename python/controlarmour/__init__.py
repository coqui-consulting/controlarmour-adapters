"""ControlArmour for Python agents.

Report what your agent does to ControlArmour on this computer and ask it
before risky actions. Standard library only. If ControlArmour is not
running, every call is a no-op and your agent carries on (fail open); once
ControlArmour has answered a check, a lost connection blocks the action
(fail closed), and a licence lapse (402) turns checking off.

    from controlarmour import ControlArmour, Blocked

    ca = ControlArmour(title="Nightly reconciliation", agent="my-agent")
    ca.step("Load bank export")
    with ca.check(tool="shell", command="rm -r build"):   # raises Blocked when the person or the rules say no
        subprocess.run(["rm", "-r", "build"])
    ca.command("rm -r build", exit_code=0)
    ca.done()

Licence: Apache-2.0.
"""

from .client import Blocked, ControlArmour, Stopped

__all__ = ["ControlArmour", "Blocked", "Stopped"]
__version__ = "0.1.0"
