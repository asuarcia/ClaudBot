"""
ForgeBridge — GUI entry point.

FreeCAD executes this file when it starts with a GUI, once per addon folder in
Mod/. There is no hook function to define and nothing to register in a
workbench: the bridge has no UI, it just needs to start watching.

This file is deliberately almost empty, and both reasons are the same reason —
FreeCAD `exec()`s it rather than importing it, in a bare namespace:

- `__file__` IS NOT DEFINED here. Any `os.path.dirname(__file__)` raises
  NameError and aborts the addon on its first line, with nothing to show for it
  but one line in a log nobody reads. Nothing needs it: FreeCAD has already put
  this folder on `sys.path` by the time this runs, so the bare import resolves.
- Nothing defined here survives. The namespace is discarded once the file
  finishes, so anything that must outlive startup — above all the poll timer,
  which stops firing the moment it is garbage-collected — has to be owned by
  forge_bridge, which is a real module. Hence `start_gui()` rather than a timer
  built here.
"""

import FreeCAD

import forge_bridge

try:
    jobs = forge_bridge.start_gui()
    FreeCAD.Console.PrintMessage("ForgeBridge watching {}\n".format(jobs))
except Exception as exc:
    # Never raise out of here. An addon that throws during startup can stop
    # FreeCAD finishing its boot, which is a far worse outcome than no bridge.
    FreeCAD.Console.PrintError("ForgeBridge failed to start: {}\n".format(exc))
