"""
ForgeBridge — console entry point.

FreeCAD executes this in *both* modes; InitGui.py is the GUI-only one. There is
no Qt event loop in FreeCADCmd, so there is nothing to start here — a timer
would never fire, and a blocking poll loop would hang every headless run.

It deliberately does not write the `.bridge-alive` marker either. That marker
answers one question — "is the live GUI bridge up?" — and every headless
`runHeadless()` call loads this file. Marking alive from here would make
`doctor` report a working GUI bridge on a machine where FreeCAD had never been
opened, which is the precise class of lie the Fusion detection told.

**The trap, and it cost an evening:** FreeCAD does not import these two files,
it `exec()`s them in a bare namespace — so `__file__` IS NOT DEFINED. Any
`os.path.dirname(__file__)` here raises NameError, the whole file aborts on its
first line, and the only sign is one line in a log nobody is reading. There is
no need for it in any case: FreeCAD puts each Mod subfolder on `sys.path`
before running these, so plain `import forge_bridge` already resolves.
"""
