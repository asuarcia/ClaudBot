"""
Geometry cross-check for the Fusion rack.

Not the deliverable — the Fusion script is. This rebuilds the *same numbers*
through build123d so the design can be looked at and measured before Fusion is
even open. It catches what went wrong last time (dimensions, clearances, parts
occupying the same space); it cannot catch a mistake in the Fusion API calls,
which only running them can.

Every rectangle here is copied from fusion-rack.py deliberately. If the two
drift apart this check is worthless.
"""

from build123d import Align, Box, BuildPart, Locations, Mode
from cad_khana.mechanism.assembly import Assembly

INCH = 25.4
W, D, H = 12.0 * INCH, 14.4 * INCH, 14.4 * INCH
LEG, THK = 1.5 * INCH, 0.125 * INCH
RAIL_CENTRES, U, UNITS = 236.525, 44.45, 6
RAIL_W, RAIL_T, HOLE_D, RAIL_EDGE = 25.0, 3.0, 7.0, 8.0
U_HOLES = (6.35, 22.225, 38.1)
PLATE_T = 3.0

# The datum for the U hole pattern: the first hole sits one leg-height up, so
# the lowest usable U clears the bottom frame.
RAIL_Z0 = LEG

# The rail *body* runs the full internal height, which is not the same thing as
# the hole pattern and was the bug. Ending the rails at RAIL_Z0 + UNITS*U left
# the two rear ones touching nothing at all: the only rear structure at that
# depth is the corner post at x 149.2-152.4, and the rails sit at 110.3-135.3,
# so they floated with a 13.96 mm gap and zero overlap — measured in FreeCAD,
# after the printability gates passed the part, because three closed shells are
# still manifold. Real 4-post racks run the rails the full height and bolt them
# to both frames; doing the same makes the whole rack one welded solid.
RAIL_BODY_Z0 = 0.0
RAIL_BODY_Z1 = H


def slab(part_ctx, rects, z0, z1, mode=Mode.ADD):
    """Same helper shape as the Fusion script: rectangles between two heights."""
    for x0, y0, x1, y1 in rects:
        with Locations(((x0 + x1) / 2, (y0 + y1) / 2, z0)):
            Box(x1 - x0, y1 - y0, z1 - z0,
                align=(Align.CENTER, Align.CENTER, Align.MIN), mode=mode)


bottom_flat = [
    (-W / 2, -D / 2, W / 2, -D / 2 + LEG),
    (-W / 2, D / 2 - LEG, W / 2, D / 2),
    (-W / 2, -D / 2, -W / 2 + LEG, D / 2),
    (W / 2 - LEG, -D / 2, W / 2, D / 2),
]
bottom_up = [
    (-W / 2, -D / 2, W / 2, -D / 2 + THK),
    (-W / 2, D / 2 - THK, W / 2, D / 2),
    (-W / 2, -D / 2, -W / 2 + THK, D / 2),
    (W / 2 - THK, -D / 2, W / 2, D / 2),
]
rear_posts = [
    (-W / 2, D / 2 - LEG, -W / 2 + THK, D / 2),
    (-W / 2, D / 2 - THK, -W / 2 + LEG, D / 2),
    (W / 2 - THK, D / 2 - LEG, W / 2, D / 2),
    (W / 2 - LEG, D / 2 - THK, W / 2, D / 2),
]

_inner = RAIL_CENTRES / 2 - RAIL_EDGE
rail_x = [(-_inner - RAIL_W, -_inner), (_inner, _inner + RAIL_W)]
rail_rects = []
for x0, x1 in rail_x:
    rail_rects.append((x0, -D / 2, x1, -D / 2 + RAIL_T))
    rail_rects.append((x0, D / 2 - LEG, x1, D / 2 - LEG + RAIL_T))

with BuildPart() as rack:
    slab(rack, [(-W / 2, -D / 2, W / 2, D / 2)], 0, PLATE_T)
    slab(rack, bottom_flat, 0, THK)
    slab(rack, bottom_up, 0, LEG)
    slab(rack, bottom_flat, H - THK, H)
    slab(rack, bottom_up, H - LEG, H)
    slab(rack, rear_posts, 0, H)
    slab(rack, rail_rects, RAIL_BODY_Z0, RAIL_BODY_Z1)

    # The hole pattern, cut through the rails only.
    for x0, x1 in rail_x:
        cx = -RAIL_CENTRES / 2 if x0 < 0 else RAIL_CENTRES / 2
        for y0, y1 in [(-D / 2, -D / 2 + RAIL_T), (D / 2 - LEG, D / 2 - LEG + RAIL_T)]:
            for u in range(UNITS):
                for h in U_HOLES:
                    z = RAIL_Z0 + u * U + h
                    with Locations(((cx), (y0 + y1) / 2, z)):
                        Box(HOLE_D, (y1 - y0) + 4, HOLE_D,
                            align=(Align.CENTER, Align.CENTER, Align.CENTER),
                            mode=Mode.SUBTRACT)

part = rack.part

# ─── the numbers that decide whether this is buildable ───────────────────────
bb = part.bounding_box()
print("envelope        {:.1f} x {:.1f} x {:.1f} mm".format(
    bb.size.X, bb.size.Y, bb.size.Z))
print("brief           {:.1f} x {:.1f} x {:.1f} mm".format(W, D, H))
print("usable height   {:.1f} mm between frames = {:.2f}U".format(H - 2 * LEG, (H - 2 * LEG) / U))
print("rail bodies     z {:.1f} -> {:.1f}  (full internal height, bolted to both frames)".format(
    RAIL_BODY_Z0, RAIL_BODY_Z1))
print("hole pattern    z {:.1f} -> {:.1f}  = {}U".format(
    RAIL_Z0, RAIL_Z0 + UNITS * U, UNITS))
print("front opening   {:.1f} mm clear between the rails' inner edges".format(
    rail_x[1][0] - rail_x[0][1]))
print("10in panel      254.0 mm wide, ears at +/-127.0 land ON the rails")
print("  rail spans +/-{:.1f} to +/-{:.1f} mm: ear covers {:.1f} mm of it, {:.1f} mm spare".format(
    _inner, _inner + RAIL_W, 127.0 - _inner, (_inner + RAIL_W) - 127.0))
print("rail hole span  {:.1f} mm centres".format(RAIL_CENTRES))
print("front-to-rear   rails {:.1f} mm apart (equipment depth support)".format(
    (D / 2 - LEG) - (-D / 2 + RAIL_T)))
print("volume          {:.0f} cm3 of steel".format(part.volume / 1000))

# The check that the printability gates cannot make. Three closed shells are
# still "manifold", so a rail connected to nothing passes every gate and falls
# out of the finished rack. If this is not 1, something is floating.
_solids = len(part.solids())
print("solids          {}  <- must be 1; more means a piece is unattached".format(_solids))
assert _solids == 1, "rack is in {} disconnected pieces".format(_solids)

assembly = Assembly().with_part("rack", part)
